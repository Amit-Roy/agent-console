#!/usr/bin/env python3
"""Held-out benchmark of effort quantile-tree candidates on one calibration dataset.

Candidates: `current` (live artifact params), `stable` (TREE_PARAMS), `intent` (stable plus
request-intent features, needs request text; bench-only), with external rows
`stable+swe-chat-prior`, and `qrf` (quantile regression forest, bench-only). External rows are train-only: never held out, never in the ceiling.
Prints one line per candidate, `<name> real ...` lines when held-out rows split into real and
probe sessions (row `origin`/`real` marker, else history console links), plus `best <name>`; writes summary.json under --out.
"""

import argparse
import concurrent.futures
import importlib.util
import json
import math
import os
import pickle
import re
import sys
import time
from pathlib import Path

# Forced, not defaulted, and before numpy/sklearn load: OpenMP reads this once at load time. With
# the default thread count, each forked candidate worker spawns a full OpenMP pool, the pools
# oversubscribe the cores and busy-wait against each other, so a run takes minutes instead of seconds.
for variable in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ[variable] = "1"

import numpy  # noqa: E402
from sklearn.ensemble import HistGradientBoostingRegressor  # noqa: E402

sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("triage_effort_fit", HERE / "triage-effort-fit.py")
fit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fit)

# Depth-3 heads: what artifacts fitted before the steadier parameters used.
LEGACY_PARAMS = {
    "max_depth": 3,
    "max_iter": 100,
    "learning_rate": 0.05,
    "min_samples_leaf": 20,
    "l2_regularization": 1.0,
    "random_state": 0,
}
PARAM_TYPES = {
    "max_depth": int,
    "max_iter": int,
    "learning_rate": float,
    "min_samples_leaf": int,
    "l2_regularization": float,
    "random_state": int,
}
CUT_FRACTIONS = (0.6, 0.68, 0.76, 0.84, 0.92, 1.0)
EXTERNAL_WEIGHT = 0.2
EXTERNAL_NAME = "stable+swe-chat-prior"
FOREST_TREES = 300
FOREST_GRID = [
    {"min_samples_leaf": leaf, "max_features": features}
    for leaf in (5, 10, 20)
    for features in (0.5, 1.0)
]
# The lowest-hash fifth of the training rows picks the forest settings; held-out rows never do.
FOREST_VALID_FRACTION = 0.2
TARGET_METRIC = "totalTokens"
# Row origins that mark probe sessions; a row with none of these (or no marker) counts as real.
PROBE_ORIGINS = {"sdk-cli", "sdk-py", "codex_exec", "probe"}
INTENT_NAME = "intent"
REQUEST_WINDOW = 2000
QUESTION_START = re.compile(
    r"^\s*(what|why|how|is|are|can|could|should|do|does|which|where|when|who|any)\b", re.I | re.M
)
EDIT_WORDS = re.compile(
    r"\b(fix|implement|add|build|refactor|create|write|change|update|remove|delete|rename|migrate"
    r"|enforce|install|configure|set ?up|wire|hook|make)\b",
    re.I,
)
SHIP_WORDS = re.compile(
    r"\b(deploy|ship|merge|push|commit|pr|pull request|release|restart)\b", re.I
)
RESEARCH_WORDS = re.compile(
    r"\b(research|compare|benchmark|evaluate|investigate|analy[sz]e|audit|explore|options"
    r"|alternatives|recommend)\b",
    re.I,
)
DEBUG_WORDS = re.compile(
    r"\b(error|bug|broken|fails?|failing|crash|stuck|not working|doesn'?t work|wrong|flaky"
    r"|502|404|500|timeout|exception|traceback)\b",
    re.I,
)
IMAGE_MARK = re.compile(r"\[Image #\d+\]|\[Attached files")
ISSUE_REF = re.compile(r"(issue|pr)\s*#\d+|#\d{2,}", re.I)
NUMBERED_ASK = re.compile(r"^\s*(?:[-*]|\d+[.)])\s+", re.M)
INTENT_FEATURES = [
    "iQuestion",
    "iEdit",
    "iShip",
    "iResearch",
    "iDebug",
    "iImage",
    "iIssue",
    "iEnum",
]


class BenchError(Exception):
    def __init__(self, stage, message):
        super().__init__(message)
        self.stage = stage


def current_params(artifact_path):
    """Params of the live artifact's quantile heads, else the depth-3 legacy params."""
    try:
        recorded = json.loads(Path(artifact_path).read_text())["quantileModel"]["parameters"]
    except (OSError, ValueError, KeyError, TypeError):
        return dict(LEGACY_PARAMS)
    if not isinstance(recorded, dict):
        return dict(LEGACY_PARAMS)
    params = dict(LEGACY_PARAMS)
    for name, kind in PARAM_TYPES.items():
        value = recorded.get(name)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            params[name] = kind(value)
    return params


def load_external(path):
    """Feature matrix and log1p targets of train-only external rows."""
    matrix, target = [], []
    with open(path) as source:
        for line in source:
            row = json.loads(line)
            values = fit.quantile_text({"text": row.get("text")})
            total = row.get("total_tokens")
            if values and fit.finite(total) and total > 0:
                matrix.append(values)
                target.append(math.log1p(total))
    if not matrix:
        raise BenchError("external", "no usable external rows")
    return numpy.array(matrix, dtype=float), numpy.array(target, dtype=float)


def intent_features(request):
    """Deterministic intent cues of the first request window (bench-only candidate features)."""
    head = request[:REQUEST_WINDOW]
    return {
        "iQuestion": float(bool(QUESTION_START.search(head) or head.rstrip().endswith("?"))),
        "iEdit": math.log1p(len(EDIT_WORDS.findall(head))),
        "iShip": float(bool(SHIP_WORDS.search(head))),
        "iResearch": float(bool(RESEARCH_WORDS.search(head))),
        "iDebug": float(bool(DEBUG_WORDS.search(head))),
        "iImage": float(bool(IMAGE_MARK.search(head))),
        "iIssue": float(bool(ISSUE_REF.search(head))),
        "iEnum": math.log1p(len(NUMBERED_ASK.findall(head))),
    }


def load_history(path):
    """Session-history tasks by id, or {} when the file is absent or unreadable."""
    try:
        tasks = json.loads(Path(path).read_text())["tasks"]
        return {task["id"]: task for task in tasks if isinstance(task, dict) and "id" in task}
    except (OSError, ValueError, KeyError, TypeError):
        return {}


def row_is_real(sample, task):
    """True/False from the row's own marker, else from history provenance; None when unknown."""
    if isinstance(sample.get("origin"), str):
        return sample["origin"] not in PROBE_ORIGINS
    if isinstance(sample.get("real"), bool):
        return sample["real"]
    provenance = task.get("provenance") if task else None
    if isinstance(provenance, dict):
        # A non-console-linked native session is a probe.
        return bool(provenance.get("consoleThreads"))
    return None


def annotate(samples, history):
    """Attach `_real` (bool or None) and `_request` (text or None) to each row."""
    for sample in samples:
        task = history.get(sample["sampleId"])
        request = sample.get("request")
        if not isinstance(request, str) and task:
            request = task.get("request")
        sample["_real"] = row_is_real(sample, task)
        sample["_request"] = request if isinstance(request, str) else None
    return samples


def with_intent(samples):
    """Copies of the rows whose text also carries the intent features."""
    return [
        {**sample, "text": {**sample["text"], **intent_features(sample["_request"])}}
        for sample in samples
    ]


def load_samples(dataset_path, history_path=None):
    try:
        dataset = json.loads(Path(dataset_path).read_text())
        samples, _ = fit.validate_dataset(dataset)
    except (OSError, ValueError) as error:
        raise BenchError("dataset", str(error)) from error
    usable = [sample for sample in samples if fit.quantile_text(sample)]
    if len(usable) < 6:
        raise BenchError("dataset", "fewer than six rows carry request features")
    if history_path is None:
        history_path = Path(dataset_path).with_name("triage-session-history.json")
    return annotate(usable, load_history(history_path))


def matrix_of(rows):
    return numpy.array([fit.quantile_text(sample) for sample in rows], dtype=float)


def target_of(rows):
    return numpy.log1p([fit.observed_work(sample, TARGET_METRIC) for sample in rows])


def fit_heads(train, held, params, external=None):
    """Held-out log1p predictions (rows x levels) and node count. External rows only add weight."""
    features, target, weight = matrix_of(train), target_of(train), numpy.ones(len(train))
    if external is not None:
        # One level offset per source: the external median is moved onto the own-data median.
        shift = float(numpy.median(external[1]) - numpy.median(target))
        features = numpy.vstack([features, external[0]])
        target = numpy.concatenate([target, external[1] - shift])
        weight = numpy.concatenate([weight, numpy.full(len(external[1]), EXTERNAL_WEIGHT)])
    columns, nodes, size = [], 0, 0
    for level in fit.QUANTILE_LEVELS.values():
        head = HistGradientBoostingRegressor(loss="quantile", quantile=level, **params)
        head.fit(features, target, sample_weight=weight)
        columns.append(head.predict(matrix_of(held)))
        nodes += sum(len(iteration[0].nodes) for iteration in head._predictors)
        trees = [fit.export_tree(iteration[0]) for iteration in head._predictors]
        size += len(json.dumps(trees, separators=(",", ":")))
    return numpy.column_stack(columns), nodes, size


def forest_of(features, target, config):
    from quantile_forest import RandomForestQuantileRegressor

    forest = RandomForestQuantileRegressor(
        n_estimators=FOREST_TREES, random_state=0, n_jobs=1, **config
    )
    return forest.fit(features, target)


def forest_logs(forest, rows):
    return forest.predict(matrix_of(rows), quantiles=list(fit.QUANTILE_LEVELS.values()))


def pick_forest_config(train):
    """Grid search on training rows only: fit on the highest-hash rows, score on the lowest-hash fifth."""
    ordered = sorted(train, key=lambda sample: fit.stable_hash(sample["sampleId"]), reverse=True)
    cut = int(len(ordered) * (1 - FOREST_VALID_FRACTION))
    older, newest = ordered[:cut], ordered[cut:]
    features, target = matrix_of(older), target_of(older)
    scored = []
    for config in FOREST_GRID:
        logs = forest_logs(forest_of(features, target, config), newest)
        scored.append(
            (score(logs, newest, math.inf)["pinball"], config["min_samples_leaf"], config)
        )
    return min(scored, key=lambda entry: entry[:2])[2]


def fit_forest(train, held):
    """Held-out predictions of the quantile forest with its grid-picked settings."""
    config = pick_forest_config(train)
    forest = forest_of(matrix_of(train), target_of(train), config)
    return forest_logs(forest, held), None, len(pickle.dumps(forest))


def fit_predict(train, held, spec):
    """Held-out log1p predictions (rows x levels), node count (None for forests) and bytes."""
    if spec["kind"] == "forest":
        return fit_forest(train, held)
    return fit_heads(train, held, spec["params"], spec["external"])


def real_rows(held):
    """Indexes of held-out rows marked real; empty unless some are real and some are probes."""
    marks = [sample["_real"] for sample in held]
    if None in marks or all(marks) or not any(marks):
        return []
    return [index for index, real in enumerate(marks) if real]


def score(logs, held, cap):
    """Mean pinball over the levels and p80/p95 coverage, as the runtime would price them."""
    stacked = numpy.maximum.accumulate(numpy.minimum(logs, cap), axis=1)
    actual = numpy.array([fit.observed_work(sample, TARGET_METRIC) for sample in held])
    pinball, coverage = [], {}
    for index, (name, level) in enumerate(fit.QUANTILE_LEVELS.items()):
        pinball.append(
            float(numpy.mean(fit.pinball_loss(level, numpy.log1p(actual) - stacked[:, index])))
        )
        coverage[name] = float(numpy.mean(actual <= numpy.expm1(stacked[:, index])))
    return {"pinball": float(numpy.mean(pinball)), "coverage": coverage}


def split_ceiling(samples):
    """Frozen split plus the own-train workload ceiling (external rows never set it)."""
    train, held, _ = fit.random_split(samples)
    ceiling = float(max(fit.observed_work(sample, TARGET_METRIC) for sample in train))
    return train, held, ceiling


def pooled_offsets(train, spec):
    """CQR offsets from out-of-fold residuals on OUR rows; external rows only join the fits."""
    count = min(fit.OFFSET_FOLDS, len(fit.groups(train)))
    assigned = numpy.array(fit.fold_assignment(train, count))
    oof = numpy.zeros((len(train), len(fit.QUANTILE_LEVELS)))
    for fold in range(count):
        inside = [row for row, which in zip(train, assigned, strict=True) if which != fold]
        position = numpy.flatnonzero(assigned == fold)
        rows = [train[index] for index in position]
        oof[position] = fit_heads(inside, rows, spec["params"], spec["external"])[0]
    actual = target_of(train)
    offsets = {}
    for index, (name, level) in enumerate(fit.QUANTILE_LEVELS.items()):
        raw = float(numpy.quantile(actual - oof[:, index], level))
        offsets[name] = float(numpy.clip(raw, -fit.OFFSET_LIMIT, fit.OFFSET_LIMIT))
    return offsets


def candidate_offsets(train, ceiling, spec):
    """Per-level offsets as served: the fitter's own routine, or the pooled variant, else zeros."""
    if spec["offsets"] == "fitter":
        return fit.conformal_offsets(train, ceiling)[0]
    if spec["offsets"] == "own-rows":
        return pooled_offsets(train, spec)
    return {name: 0.0 for name in fit.QUANTILE_LEVELS}


def run_candidate(samples, spec):
    train, held, ceiling = split_ceiling(samples)
    started = time.monotonic()
    logs, nodes, size = fit_predict(train, held, spec)
    offsets = candidate_offsets(train, ceiling, spec)
    elapsed = time.monotonic() - started
    logs = logs + numpy.array([offsets[name] for name in fit.QUANTILE_LEVELS])
    result = score(logs, held, math.log1p(ceiling))
    real = real_rows(held)
    if real:
        subset = score(logs[real], [held[index] for index in real], math.log1p(ceiling))
        result["real"] = {**subset, "heldout": len(real)}
    return {**result, "nodes": nodes, "sizeKb": size / 1024, "fitSec": elapsed, "offsets": offsets}


def cut_gap(samples, fraction, spec):
    """Pinball change at one cut-point when the lowest-hash training rows are dropped.

    Raw heads only: offsets cost OFFSET_FOLDS extra fits per refit, about 6x per cut-point.
    """
    grouped = sorted(fit.groups(samples), key=fit.group_hash)
    prefix = [
        sample for group in grouped[: int(round(len(grouped) * fraction))] for sample in group
    ]
    try:
        train, held, ceiling = split_ceiling(prefix)
    except ValueError:
        return None
    cap = math.log1p(ceiling)
    older = sorted(train, key=lambda sample: fit.stable_hash(sample["sampleId"]))[
        fit.STABILITY_DROPPED :
    ]
    if len(older) < 2:
        return None
    full = score(fit_predict(train, held, spec)[0], held, cap)["pinball"]
    base = score(fit_predict(older, held, spec)[0], held, cap)["pinball"]
    return abs(full - base)


def rolling_gap(samples, spec):
    gaps = [cut_gap(samples, fraction, spec) for fraction in CUT_FRACTIONS]
    gaps = [gap for gap in gaps if gap is not None]
    return float(numpy.mean(gaps)) if gaps else None


def evaluate(spec, samples):
    features = fit.QUANTILE_FEATURES[:]
    # Forked workers own their copy; the restore keeps in-process callers clean.
    fit.QUANTILE_FEATURES[:] = features + spec.get("extraFeatures", [])
    try:
        rows = with_intent(samples) if spec.get("extraFeatures") else samples
        result = run_candidate(rows, spec)
        result["gap"] = rolling_gap(rows, spec)
    finally:
        fit.QUANTILE_FEATURES[:] = features
    result["name"] = spec["name"]
    return result


def candidate_line(result):
    gap = "n/a" if result["gap"] is None else f"{result['gap']:.3f}"
    cov = result["coverage"]
    nodes = "n/a" if result["nodes"] is None else result["nodes"]
    return (
        f"{result['name']} pinball {result['pinball']:.3f} "
        f"cov {cov['p80']:.2f}/{cov['p95']:.2f} gap {gap} nodes {nodes} "
        f"kb {result['sizeKb']:.0f} fit {result['fitSec']:.1f}s"
    )


def real_line(result):
    real = result["real"]
    cov = real["coverage"]
    return (
        f"{result['name']} real pinball {real['pinball']:.3f} "
        f"cov {cov['p80']:.2f}/{cov['p95']:.2f} n {real['heldout']}"
    )


def forest_available():
    return importlib.util.find_spec("quantile_forest") is not None


def candidate_specs(artifact_path, external, samples=()):
    """Every runnable candidate; the forest is skipped when quantile-forest is not installed."""
    specs = [
        {
            "name": "current",
            "kind": "trees",
            "params": current_params(artifact_path),
            "external": None,
            "offsets": "none",
        },
        {
            "name": "stable",
            "kind": "trees",
            "params": fit.TREE_PARAMS,
            "external": None,
            "offsets": "fitter",
        },
    ]
    if external is not None:
        specs.append(
            {
                "name": EXTERNAL_NAME,
                "kind": "trees",
                "params": fit.TREE_PARAMS,
                "external": external,
                "offsets": "own-rows",
            }
        )
    if samples and all(sample["_request"] is not None for sample in samples):
        specs.append(
            {
                "name": INTENT_NAME,
                "kind": "trees",
                "params": fit.TREE_PARAMS,
                "external": None,
                "offsets": "fitter",
                "extraFeatures": INTENT_FEATURES,
            }
        )
    if forest_available():
        specs.append(
            {"name": "qrf", "kind": "forest", "params": None, "external": None, "offsets": "none"}
        )
    else:
        print("effort-model: qrf: quantile-forest not installed, skipped", file=sys.stderr)
    return specs


def chosen_specs(specs, names):
    if not names:
        return specs
    wanted = [name.strip() for name in names.split(",") if name.strip()]
    unknown = [name for name in wanted if name not in {spec["name"] for spec in specs}]
    if unknown:
        raise BenchError("candidates", f"unknown or unavailable: {','.join(unknown)}")
    return [spec for spec in specs if spec["name"] in wanted]


def benchmark(args):
    samples = load_samples(args.dataset, args.history)
    try:
        train, held, ceiling = split_ceiling(samples)
    except ValueError as error:
        raise BenchError("split", str(error)) from error
    external = load_external(args.external_rows) if args.external_rows else None
    plan = chosen_specs(candidate_specs(args.artifact or "", external, samples), args.candidates)
    # One single-threaded worker per candidate keeps the wall time near the slowest one.
    with concurrent.futures.ProcessPoolExecutor(max_workers=len(plan)) as pool:
        pending = [pool.submit(evaluate, spec, samples) for spec in plan]
        results = [job.result() for job in pending]
    held_real = len(real_rows(held))
    best = min(results, key=lambda result: result["pinball"])["name"]
    return {
        "best": best,
        "candidates": results,
        "train": len(train),
        "heldout": len(held),
        "ceiling": ceiling,
        "externalRows": 0 if external is None else len(external[1]),
        **({"realHeldout": held_real} if held_real else {}),
    }


def write_summary(out_dir, summary):
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / "summary.json"
    target.write_text(json.dumps(summary, indent=1) + "\n")
    return target


def parse_args(argv):
    parser = argparse.ArgumentParser(description="Benchmark effort quantile-tree candidates.")
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--artifact", help="live artifact whose fit parameters define `current`")
    parser.add_argument("--external-rows", help="feature rows from effort-data-features.ts")
    parser.add_argument(
        "--history",
        help="session history giving request text and console links; default: next to --dataset",
    )
    parser.add_argument("--candidates", help="comma-separated names to run; default all")
    parser.add_argument("--json", action="store_true", help="print summary.json instead of lines")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        summary = benchmark(args)
        target = write_summary(args.out, summary)
    except (BenchError, OSError, ValueError) as error:
        print(f"effort-model: {getattr(error, 'stage', 'bench')}: {error}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(summary))
        return 0
    for result in summary["candidates"]:
        print(candidate_line(result))
    for result in summary["candidates"]:
        if "real" in result:
            print(real_line(result))
    print(f"best {summary['best']} out {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
