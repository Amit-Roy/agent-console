#!/usr/bin/env python3
"""Fit initial-request complexity to chronological observed session usage.

Requests and credentials are never copied to artifacts. The CLI does not read
production logs; it accepts the audited, prework-feature dataset explicitly.
Legacy delivery-run datasets retain their tool-call target and token yields.
"""

import argparse
import copy
import json
import math
import os
from collections import Counter
from datetime import datetime
from pathlib import Path

# Tiny boosted trees fit in about 2 s on one thread; the default thread pool contends and takes minutes.
os.environ.setdefault("OMP_NUM_THREADS", "1")

import numpy as np
import scipy
import sklearn
from scipy.optimize import lsq_linear
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_log_error

LEGACY_FEATURES = ["breadth", "complexity", "uncertainty", "risk"]
SHAPE_FEATURES = ["requestSize", "requestLines", "requestReferences", "requestActions"]
# Datasets that carry the deterministic request-shape buckets price with those four alone. The
# model-extracted metrics are unknown for most sessions and, when known, vary between models, so
# they would make the same request price differently from run to run.
FEATURES = list(LEGACY_FEATURES)


def use_features(dataset):
    """Pick the feature set once per dataset; datasets without request shape keep the original four."""
    global FEATURES
    samples = dataset.get("samples") if isinstance(dataset, dict) else None
    shaped = (
        isinstance(samples, list)
        and samples
        and all(
            isinstance(s, dict)
            and isinstance(s.get("features"), dict)
            and all(name in s["features"] for name in SHAPE_FEATURES)
            for s in samples
        )
    )
    FEATURES = list(SHAPE_FEATURES) if shaped else list(LEGACY_FEATURES)


ALPHAS = [0.01, 0.1, 1.0, 10.0, 100.0]
QUANTILES = {"p50": 0.5, "p80": 0.8, "p95": 0.95}
# Quantile tree heads price the whole session directly; independent heads are rearranged
# into a monotone set so a higher quantile never falls below a lower one.
QUANTILE_LEVELS = {"p50": 0.5, "p75": 0.75, "p80": 0.8, "p95": 0.95, "p99": 0.99}
QUANTILE_FEATURES = [
    "size",
    "lines",
    "refs",
    "verbs",
    "logChars",
    "logLines",
    "logRefs",
    "logVerbs",
    "fence",
    "logPaths",
    "tests",
    "checklist",
    "bullets",
    "questions",
    "versions",
]
# Shallow, heavily regularised heads: depth 2 with 80-row leaves was the most stable on the
# real data (small gap when the newest rows are dropped, best held-out pinball).
TREE_PARAMS = {
    "max_depth": 2,
    "max_iter": 100,
    "learning_rate": 0.03,
    "min_samples_leaf": 80,
    "l2_regularization": 10.0,
    "random_state": 0,
}
# Paired bootstrap of per-row pinball, challenger minus champion, on shared held-out rows.
BOOTSTRAP_RESAMPLES = 2000
BOOTSTRAP_SEED = 7
# Report-only stability probe: refit without the newest training rows.
STABILITY_DROPPED = 14
# Conformalized quantile regression: per-head offsets are the q-th quantile of out-of-fold
# residuals (log1p space) on training rows only, clamped to a sane shift.
OFFSET_FOLDS = 5
OFFSET_LIMIT = 1.0
OFFSET_SOURCE = "oof-cqr"


def dataset_scope(dataset):
    scope = dataset.get("scope", "completed-delivery-run")
    if scope == "successful-direct-logged-delivery-run":
        scope = "completed-delivery-run"
    if scope not in ("completed-session", "completed-delivery-run"):
        raise ValueError("Unsupported dataset scope")
    return scope


def count_tree(value):
    """Carry aggregate source counts without copying paths, IDs, or text."""
    if not isinstance(value, dict):
        return {}
    result = {}
    for name, child in value.items():
        if (
            not isinstance(name, str)
            or not name.replace("_", "").replace("-", "").isalnum()
            or len(name) > 80
        ):
            continue
        if isinstance(child, dict):
            nested = count_tree(child)
            if nested:
                result[name] = nested
        elif finite(child) and child >= 0 and child == int(child):
            result[name] = int(child)
    return result


def public_metadata(value):
    """Remove record identities and scenario rows at every report depth."""
    if isinstance(value, dict):
        private_keys = {
            "sampleId",
            "sampleIds",
            "groupId",
            "groupIds",
            "sourceId",
            "sourceIds",
            "scenarios",
            "candidateScenarios",
        }
        return {
            key: public_metadata(child) for key, child in value.items() if key not in private_keys
        }
    if isinstance(value, list):
        return [public_metadata(child) for child in value]
    return value


def finite_metadata(value):
    """Keep failed metric diagnostics JSON-safe without inventing a value."""
    if isinstance(value, dict):
        return {key: finite_metadata(child) for key, child in value.items()}
    if isinstance(value, list):
        return [finite_metadata(child) for child in value]
    return None if isinstance(value, float) and not math.isfinite(value) else value


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def timestamp(value, field="completedAt"):
    if not isinstance(value, str):
        raise ValueError(f"{field} must be an ISO timestamp")
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            raise ValueError("timestamp needs timezone")
        return dt.timestamp()
    except (ValueError, OverflowError) as exc:
        raise ValueError(f"{field} must be an ISO timestamp with timezone") from exc


def validate_sample_ids(sample, ids):
    for name in ("sampleId", "groupId"):
        if not isinstance(sample.get(name), str) or not sample[name] or len(sample[name]) > 300:
            raise ValueError(f"Invalid {name}")
    if sample["sampleId"] in ids:
        raise ValueError("Duplicate sampleId")
    ids.add(sample["sampleId"])


def validate_sample_features(features):
    if not isinstance(features, dict) or any(name not in features for name in FEATURES):
        raise ValueError("Missing prework feature")
    for name in FEATURES:
        value = features[name]
        if value is not None and (not finite(value) or value not in (0, 1, 2, 3)):
            raise ValueError(f"Feature {name} must be 0..3 or null")


def session_outcomes(outcomes):
    """Return (outcomes, rejection) for a completed-session sample."""
    # Full-session input and output define the supervised target.
    # Action counters, cache splits, and rounds are optional diagnostics.
    invalid = next(
        (
            name
            for name in ("inputTokens", "outputTokens")
            if not finite(outcomes.get(name)) or outcomes[name] < 0
        ),
        None,
    )
    if invalid:
        return outcomes, f"missingOrInvalid{invalid[0].upper()}{invalid[1:]}"
    outcomes = {**outcomes}
    for name in ("toolCalls", "toolRounds", "nonCachedInputTokens", "cachedInputTokens"):
        if not finite(outcomes.get(name)) or outcomes[name] < 0:
            outcomes[name] = None
    return outcomes, None


def legacy_outcomes(outcomes):
    """Return (outcomes, rejection) for a legacy delivery-run sample."""
    for name, value in outcomes.items():
        if value is not None and (not finite(value) or value < 0):
            raise ValueError(f"Invalid outcome {name}")
    # Legacy artifacts retain their original positive-action cohort
    # and per-action yields for numerical compatibility.
    for name, rejection in (
        ("toolCalls", "missingOrZeroToolCalls"),
        ("outputTokens", "missingOrZeroOutputTokens"),
        ("toolRounds", "missingOrZeroToolRounds"),
    ):
        if not finite(outcomes.get(name)) or outcomes[name] <= 0:
            return outcomes, rejection
    if outcomes["toolRounds"] > outcomes["toolCalls"]:
        return outcomes, "roundsExceedCalls"
    return outcomes, None


def validate_dataset(dataset):
    use_features(dataset)
    if (
        not isinstance(dataset, dict)
        or dataset.get("schemaVersion") != 1
        or not isinstance(dataset.get("samples"), list)
    ):
        raise ValueError("Expected schemaVersion=1 and samples array")
    scope = dataset_scope(dataset)
    accepted, rejected, ids = [], Counter(), set()
    for sample in dataset["samples"]:
        if not isinstance(sample, dict):
            raise ValueError("Sample must be an object")
        validate_sample_ids(sample, ids)
        stamp = timestamp(sample.get("completedAt"))
        started = timestamp(sample.get("startedAt"), "startedAt")
        if started > stamp:
            raise ValueError("startedAt must not follow completedAt")
        features, outcomes = sample.get("features"), sample.get("outcomes")
        validate_sample_features(features)
        if not isinstance(outcomes, dict):
            raise ValueError("Missing outcomes object")
        check = session_outcomes if scope == "completed-session" else legacy_outcomes
        outcomes, rejection = check(outcomes)
        if rejection:
            rejected[rejection] += 1
            continue
        accepted.append({**sample, "outcomes": outcomes, "_time": stamp, "_start": started})
    if len(accepted) < 6:
        raise ValueError("Need at least six valid measured runs")
    return accepted, dict(rejected)


def groups(samples):
    result = {}
    for sample in samples:
        result.setdefault(sample["groupId"], []).append(sample)
    return sorted(
        result.values(), key=lambda group: (min(s["_start"] for s in group), group[0]["groupId"])
    )


def frozen_split(samples):
    grouped = groups(samples)
    if len(grouped) < 4:
        raise ValueError("Need at least four independent completed thread groups")
    holdout_count = max(1, math.ceil(len(grouped) * 0.2))
    holdout = [s for group in grouped[-holdout_count:] for s in group]
    boundary = min(s["_start"] for s in holdout)
    older, purged = [], []
    for group in grouped[:-holdout_count]:
        (older if max(s["_time"] for s in group) < boundary else purged).extend(group)
    if len(groups(older)) < 3:
        raise ValueError("Insufficient older groups after strict temporal-overlap purge")
    return older, holdout, purged


def design(samples, imputation=None, scale=None):
    matrix = np.array(
        [
            [np.nan if s["features"][f] is None else s["features"][f] for f in FEATURES]
            for s in samples
        ],
        dtype=float,
    )
    missing = np.isnan(matrix)
    if imputation is None:
        imputation = np.array(
            [
                float(np.median(matrix[~missing[:, j], j])) if (~missing[:, j]).any() else 1.5
                for j in range(len(FEATURES))
            ]
        )
    filled = np.where(missing, imputation, matrix)
    if scale is None:
        scale = np.maximum(np.std(filled, axis=0), 1.0)
    return (
        np.column_stack([np.ones(len(samples)), filled / scale, missing.astype(float)]),
        np.asarray(imputation),
        np.asarray(scale),
    )


def observed_work(sample, workload_metric="toolCalls"):
    outcomes = sample["outcomes"]
    return (
        outcomes["inputTokens"] + outcomes["outputTokens"]
        if workload_metric == "totalTokens"
        else outcomes["toolCalls"]
    )


def fit_model(samples, alpha, workload_metric="toolCalls"):
    matrix, imputation, scale = design(samples)
    target = np.log1p([observed_work(s, workload_metric) for s in samples])
    # Intercept is not penalized. Only true complexity coefficients must be
    # nonnegative. Missingness is a separate signed data-quality indicator.
    n = len(FEATURES)
    penalty = np.diag([0.0] + [math.sqrt(alpha)] * (2 * n))
    result = lsq_linear(
        np.vstack([matrix, penalty]),
        np.concatenate([target, np.zeros(2 * n + 1)]),
        bounds=([-np.inf] + [0.0] * n + [-np.inf] * n, [np.inf] * (2 * n + 1)),
        tol=1e-11,
        max_iter=2000,
    )
    if not result.success:
        raise ValueError("Nonnegative ridge fit failed")
    return {
        "intercept": float(result.x[0]),
        "coefficients": result.x[1 : 1 + n].tolist(),
        "missingCoefficients": result.x[1 + n :].tolist(),
        "imputation": imputation.tolist(),
        "scale": scale.tolist(),
    }


def predict_work(model, samples):
    matrix, _, _ = design(samples, model["imputation"], model["scale"])
    weights = [model["intercept"], *model["coefficients"], *model["missingCoefficients"]]
    return np.maximum(0, np.expm1(np.clip(matrix @ weights, -50, 30)))


def folds(samples):
    ordered = groups(samples)
    # At least two independent groups precede each validation group. Groups
    # with overlapping completion windows are purged from that fold.
    for index in range(2, len(ordered)):
        validation = ordered[index]
        boundary = min(s["_start"] for s in validation)
        train = [
            s
            for group in ordered[:index]
            if max(r["_time"] for r in group) < boundary
            for s in group
        ]
        if len(groups(train)) >= 2:
            yield train, validation


def quantiles(values):
    return {name: float(np.quantile(values, q)) for name, q in QUANTILES.items()}


def scenario(sample, prediction, token_yield_basis="actions"):
    observed = sample["outcomes"]
    work = observed_work(sample, "totalTokens" if token_yield_basis == "workload" else "toolCalls")
    denominator = work + (1 if token_yield_basis == "actions-plus-one" else 0)

    # A measured zero-token session is valid. Its component fractions are zero,
    # while optional measurements remain unavailable when absent.
    def ratio(value):
        return value / denominator if denominator else 0.0

    fresh = observed.get("nonCachedInputTokens")
    # Never infer fresh input by subtracting a cache counter: provider
    # accounting conventions differ and counters may overlap.
    result = {
        "sampleId": sample["sampleId"],
        "logResidual": float(np.log1p(work) - np.log1p(prediction)),
        "outputPerWork": ratio(observed["outputTokens"]),
        "freshInputPerWork": ratio(fresh) if finite(fresh) else None,
        "cachedInputPerWork": ratio(observed.get("cachedInputTokens"))
        if finite(observed.get("cachedInputTokens"))
        else None,
        "roundsPerWork": ratio(observed.get("toolRounds"))
        if finite(observed.get("toolRounds"))
        else None,
    }
    if token_yield_basis in ("actions-plus-one", "workload"):
        result["inputPerWork"] = ratio(observed["inputTokens"])
    if token_yield_basis == "workload" and work == 0:
        result["zeroWork"] = True
    return result


def quote(model, scenarios, samples, token_yield_basis="actions", ceiling=None):
    result = []
    for work in predict_work(model, samples):
        row = {}
        # Preserve the empirical mass at zero without assigning positive usage
        # to zero-fraction scenarios when predicting a different request.
        adjusted = [
            0.0
            if token_yield_basis == "workload" and s.get("zeroWork")
            else max(0, math.expm1(min(30, math.log1p(float(work)) + s["logResidual"])))
            for s in scenarios
        ]
        # A residual tail must not price more work than any observed session.
        if ceiling is not None and token_yield_basis == "workload":
            adjusted = [min(float(ceiling), value) for value in adjusted]
        row["work"] = quantiles(adjusted)
        for channel, field in [
            ("outputTokens", "outputPerWork"),
            ("freshInputTokens", "freshInputPerWork"),
            ("cachedInputTokens", "cachedInputPerWork"),
        ]:
            values = [
                (w + (1 if token_yield_basis == "actions-plus-one" else 0)) * s[field]
                for w, s in zip(adjusted, scenarios, strict=True)
                if s[field] is not None
            ]
            row[channel] = quantiles(values) if len(values) == len(scenarios) else None
        input_yields = [
            s.get("inputPerWork")
            if s.get("inputPerWork") is not None
            else (
                s["freshInputPerWork"] + s["cachedInputPerWork"]
                if s["freshInputPerWork"] is not None and s["cachedInputPerWork"] is not None
                else None
            )
            for s in scenarios
        ]
        if all(value is not None for value in input_yields):
            units = [w + (1 if token_yield_basis == "actions-plus-one" else 0) for w in adjusted]
            row["inputTokens"] = quantiles(
                [w * y for w, y in zip(units, input_yields, strict=True)]
            )
            row["totalTokens"] = (
                row["work"]
                if token_yield_basis == "workload"
                else quantiles(
                    [
                        w * (y + s["outputPerWork"])
                        for w, y, s in zip(units, input_yields, scenarios, strict=True)
                    ]
                )
            )
        else:
            row["inputTokens"] = row["totalTokens"] = None
        row["riskPremiumOutputTokens"] = row["outputTokens"]["p80"] - row["outputTokens"]["p50"]
        result.append(row)
    return result


def errors(actual, predicted):
    return {
        "mae": float(mean_absolute_error(actual, predicted)),
        "rmsle": float(math.sqrt(mean_squared_log_error(actual, predicted))),
    }


def quantile_text(sample):
    """Deterministic request-text features. Missing or non-finite rows cannot train the trees."""
    text = sample.get("text")
    if not isinstance(text, dict) or any(name not in text for name in QUANTILE_FEATURES):
        return None
    values = [text[name] for name in QUANTILE_FEATURES]
    if any(not finite(value) for value in values):
        return None
    return values


def export_tree(predictor):
    """Flatten one fitted tree into parallel arrays the TypeScript walker reads."""
    nodes = predictor.nodes
    if not isinstance(nodes, np.ndarray):
        raise ValueError("Unexpected tree node representation")
    # left/right are unsigned in sklearn; leaves carry 0 there. is_leaf is authoritative.
    leaf = nodes["is_leaf"].astype(bool)
    left = np.where(leaf, -1, nodes["left"].astype(np.int64)).astype(int).tolist()
    right = np.where(leaf, -1, nodes["right"].astype(np.int64)).astype(int).tolist()
    return {
        "f": nodes["feature_idx"].astype(int).tolist(),
        "t": nodes["num_threshold"].astype(float).tolist(),
        "l": left,
        "r": right,
        "v": nodes["value"].astype(float).tolist(),
    }


def score_tree(tree, features, baseline):
    node = 0
    while tree["l"][node] != -1:
        node = tree["l"][node] if features[tree["f"][node]] <= tree["t"][node] else tree["r"][node]
    return baseline + tree["v"][node]


def quantile_cap(ceiling):
    """Runtime cap in log space: a finite ceiling bounds every head, otherwise none."""
    if (
        isinstance(ceiling, (int, float))
        and not isinstance(ceiling, bool)
        and math.isfinite(ceiling)
    ):
        return math.log1p(max(0.0, ceiling))
    return math.inf


def head_logs(model, rows, offsets=True):
    """Raw log1p head outputs (rows x levels): baseline, optional offset, then the tree sum."""
    features = [quantile_text(sample) for sample in rows]
    logs = []
    for name in QUANTILE_LEVELS:
        start = model["baseline"][name] + (model["offsets"][name] if offsets else 0.0)
        trees = model["trees"][name]
        logs.append([start + sum(score_tree(tree, row, 0.0) for tree in trees) for row in features])
    return np.column_stack(logs)


def stacked_logs(model, rows, cap):
    """Monotone log1p quantile predictions (rows x levels), as the runtime would price them."""
    return np.maximum.accumulate(np.minimum(cap, head_logs(model, rows)), axis=1)


def pinball_loss(level, delta):
    return np.maximum(level * delta, (level - 1) * delta)


def row_pinball(model, rows, cap):
    """Per-row pinball averaged over the quantile levels."""
    actual = np.log1p([observed_work(sample, "totalTokens") for sample in rows])
    stacked = stacked_logs(model, rows, cap)
    losses = [
        pinball_loss(level, actual - stacked[:, index])
        for index, level in enumerate(QUANTILE_LEVELS.values())
    ]
    return np.mean(losses, axis=0)


def score_quantile_model(model, rows, cap):
    """Per-quantile pinball (log1p space) and coverage on rows, as the runtime would price them."""
    actual = np.array([observed_work(sample, "totalTokens") for sample in rows])
    stacked = stacked_logs(model, rows, cap)
    metrics = {}
    for index, (name, level) in enumerate(QUANTILE_LEVELS.items()):
        delta = np.log1p(actual) - stacked[:, index]
        metrics[name] = {
            "pinball": float(np.mean(pinball_loss(level, delta))),
            "coverage": float(np.mean(actual <= np.expm1(stacked[:, index]))),
        }
    return metrics


def paired_bootstrap(delta):
    """Mean and 90% percentile interval of the mean of per-row differences."""
    rng = np.random.default_rng(BOOTSTRAP_SEED)
    picks = rng.integers(0, len(delta), size=(BOOTSTRAP_RESAMPLES, len(delta)))
    means = delta[picks].mean(axis=1)
    return {
        "mean": float(delta.mean()),
        "lower90": float(np.quantile(means, 0.05)),
        "upper90": float(np.quantile(means, 0.95)),
        "resamples": BOOTSTRAP_RESAMPLES,
    }


def mean_pinball(metrics):
    return float(np.mean([entry["pinball"] for entry in metrics.values()]))


def unscoreable_champion(reason):
    return {
        "scoreable": False,
        "reason": reason,
        "sampleCount": 0,
        "quantiles": {},
        "meanPinball": None,
    }


def load_champion_model(path):
    """Return (quantileModel, trainingIds, reason). Any failure yields an unscoreable reason."""
    try:
        with open(path) as handle:
            artifact = json.load(handle)
    except (OSError, ValueError):
        return None, None, "champion artifact missing or unreadable"
    model = artifact.get("quantileModel") if isinstance(artifact, dict) else None
    if not isinstance(model, dict):
        return None, None, "champion artifact has no quantileModel"
    if model.get("features") != QUANTILE_FEATURES:
        return None, None, "champion features differ from QUANTILE_FEATURES"
    training = artifact.get("training")
    ids = training.get("sampleIds") if isinstance(training, dict) else None
    return model, ids if isinstance(ids, list) else None, None


def score_champion(path, heldout, challenger=None):
    """Score the installed champion on held-out rows it did not train on.

    With a (model, cap) challenger, also store the paired per-row pinball delta on those rows.
    """
    model, training_ids, reason = load_champion_model(path)
    if model is None:
        return unscoreable_champion(reason)
    note = None
    rows = heldout
    if training_ids is None:
        note = "no training ids"
    else:
        seen = set(training_ids)
        rows = [sample for sample in heldout if sample["sampleId"] not in seen]
    if not rows:
        return unscoreable_champion("no held-out rows outside champion training ids")
    try:
        metrics = score_quantile_model(model, rows, quantile_cap(model.get("ceiling")))
    except (KeyError, IndexError, TypeError, ValueError):
        return unscoreable_champion("champion quantileModel is malformed")
    result = {
        "scoreable": True,
        "reason": note,
        "sampleCount": len(rows),
        "quantiles": metrics,
        "meanPinball": mean_pinball(metrics),
    }
    if challenger is not None:
        challenger_model, challenger_cap = challenger
        delta = row_pinball(challenger_model, rows, challenger_cap) - row_pinball(
            model, rows, quantile_cap(model.get("ceiling"))
        )
        result["pairedDelta"] = paired_bootstrap(delta)
    return result


def fit_quantile_heads(train, ceiling):
    """Fit independent quantile tree heads and verify the exported arrays reproduce sklearn."""
    matrix = np.array([quantile_text(s) for s in train], dtype=float)
    target = np.log1p([observed_work(s, "totalTokens") for s in train])
    trees, baseline, params = {}, {}, 0
    for name, q in QUANTILE_LEVELS.items():
        fitted = HistGradientBoostingRegressor(loss="quantile", quantile=q, **TREE_PARAMS).fit(
            matrix, target
        )
        exported = [export_tree(iteration[0]) for iteration in fitted._predictors]
        base = float(fitted._baseline_prediction.ravel()[0])
        # The artifact must be walkable by the runtime: compare exported arrays with sklearn.
        rows = matrix[: min(3, len(matrix))]

        check = [base + sum(score_tree(tree, row, 0.0) for tree in exported) for row in rows]
        if not np.allclose(np.array(check), fitted.predict(rows), atol=1e-9):
            raise ValueError("Exported quantile trees do not reproduce the fitted estimator")
        trees[name] = exported
        baseline[name] = base
        params += sum(len(tree["f"]) for tree in exported)
    model = {
        "method": "boosted-trees-quantile-v1",
        "features": QUANTILE_FEATURES,
        "quantiles": QUANTILE_LEVELS,
        "baseline": baseline,
        "trees": trees,
        # Zero here; fit_calibrated_heads replaces them with out-of-fold conformal offsets.
        "offsets": {name: 0.0 for name in QUANTILE_LEVELS},
        "ceiling": ceiling,
        "nodeCount": params,
        "parameters": TREE_PARAMS,
    }
    return model, float(np.median(target))


def fold_assignment(rows, count):
    """Deterministic grouped K-fold: whole thread groups, oldest first, dealt round-robin."""
    fold_of = {}
    for index, group in enumerate(groups(rows)):
        fold_of[group[0]["groupId"]] = index % count
    return [fold_of[row["groupId"]] for row in rows]


def oof_head_logs(train, ceiling):
    """Out-of-fold raw head outputs for every training row; each fold is fit without its groups."""
    count = min(OFFSET_FOLDS, len(groups(train)))
    assigned = np.array(fold_assignment(train, count))
    oof = np.zeros((len(train), len(QUANTILE_LEVELS)))
    for fold in range(count):
        inside = [row for row, which in zip(train, assigned, strict=True) if which != fold]
        model, _ = fit_quantile_heads(inside, ceiling)
        held = np.flatnonzero(assigned == fold)
        oof[held] = head_logs(model, [train[position] for position in held], offsets=False)
    return oof


def conformal_offsets(train, ceiling):
    """CQR offsets from training-only out-of-fold residuals, with before/after OOF coverage."""
    actual = np.log1p([observed_work(sample, "totalTokens") for sample in train])
    oof = oof_head_logs(train, ceiling)
    offsets, coverage = {}, {}
    for index, (name, level) in enumerate(QUANTILE_LEVELS.items()):
        raw = float(np.quantile(actual - oof[:, index], level))
        offsets[name] = float(np.clip(raw, -OFFSET_LIMIT, OFFSET_LIMIT))
        coverage[name] = {
            "nominal": level,
            "offset": offsets[name],
            "clamped": offsets[name] != raw,
            "before": float(np.mean(actual <= oof[:, index])),
            "after": float(np.mean(actual <= oof[:, index] + offsets[name])),
        }
    return offsets, coverage


def fit_calibrated_heads(train, ceiling):
    """Fit the heads, then store offsets computed from training rows alone."""
    model, median_log = fit_quantile_heads(train, ceiling)
    model["offsets"], coverage = conformal_offsets(train, ceiling)
    return model, median_log, coverage


def stability_probe(train, heldout, ceiling, cap, full_pinball):
    """Report-only: refit without the newest training rows and score the same held-out rows."""
    older = sorted(train, key=lambda sample: sample["_start"])[:-STABILITY_DROPPED]
    if len(older) < 2:
        return None
    model, _, _ = fit_calibrated_heads(older, ceiling)
    pinball = mean_pinball(score_quantile_model(model, heldout, cap))
    return {
        "droppedNewest": STABILITY_DROPPED,
        "meanPinball": pinball,
        "gap": abs(pinball - full_pinball),
    }


def fit_quantile_model(train, heldout, ceiling):
    """Fit quantile tree heads, then score them on the held-out block."""
    model, median_log, oof_coverage = fit_calibrated_heads(train, ceiling)
    params = model["nodeCount"]
    actual = np.array([observed_work(s, "totalTokens") for s in heldout])
    cap = math.log1p(ceiling) if ceiling is not None else 30.0
    metrics = score_quantile_model(model, heldout, cap)
    baseline_pinball = {
        name: float(np.mean(pinball_loss(q, np.log1p(actual) - median_log)))
        for name, q in QUANTILE_LEVELS.items()
    }
    covered = all(
        metrics[name]["coverage"] >= target_coverage
        for name, target_coverage in (("p80", 0.8), ("p95", 0.95))
    )
    improves = mean_pinball(metrics) < float(np.mean(list(baseline_pinball.values())))
    validation = {
        "status": "validated" if covered and improves else "experimental",
        "sampleCount": len(heldout),
        "groupCount": len(groups(heldout)),
        "quantiles": metrics,
        "meanPinball": mean_pinball(metrics),
        "baselinePinball": baseline_pinball,
        "beatsPinballBaseline": improves,
        "nodeCount": params,
        "offsetSource": OFFSET_SOURCE,
        "offsetFolds": min(OFFSET_FOLDS, len(groups(train))),
        "oofCoverage": oof_coverage,
        "fit": TREE_PARAMS,
        "stability": stability_probe(train, heldout, ceiling, cap, mean_pinball(metrics)),
        "limitations": [
            "Independent quantile heads are rearranged, so fitted head values are not a density.",
            "Offsets are conformal shifts from training-only out-of-fold residuals; oofCoverage ignores the ceiling cap and rearrangement.",
            "Coverage is the held-out block that also selected artifacts; it is not an independent test.",
        ],
    }
    return model, validation


def select_alpha(train, workload_metric):
    """Pick the ridge alpha by older-group out-of-fold log MSE; ties prefer the larger alpha."""
    folds_list = list(folds(train))
    if not folds_list:
        raise ValueError("No strict older-group folds available for residual calibration")
    scores, residuals_by_alpha = [], {}
    for alpha in ALPHAS:
        residuals = []
        for older, validation in folds_list:
            prediction = predict_work(fit_model(older, alpha, workload_metric), validation)
            residuals.extend(
                (sample, float(value)) for sample, value in zip(validation, prediction, strict=True)
            )
        mse = float(
            np.mean(
                [
                    (math.log1p(observed_work(sample, workload_metric)) - math.log1p(value)) ** 2
                    for sample, value in residuals
                ]
            )
        )
        scores.append({"alpha": alpha, "oofLogMse": mse})
        residuals_by_alpha[alpha] = residuals
    best = min(scores, key=lambda score: (score["oofLogMse"], -score["alpha"]))["alpha"]
    return best, scores, residuals_by_alpha


def feature_ranges(train):
    """Training min/max and known/missing counts per feature."""
    ranges = []
    for name in FEATURES:
        values = [
            sample["features"][name] for sample in train if sample["features"][name] is not None
        ]
        ranges.append(
            {
                "min": min(values) if values else None,
                "max": max(values) if values else None,
                "known": len(values),
                "missing": len(train) - len(values),
            }
        )
    return ranges


def add_session_channel_validation(validation, train, heldout, quotes):
    """Input and total token error, baseline and coverage for completed-session artifacts."""
    validation["limitations"].append(
        "Observed zero-usage calibration sessions contribute a fixed empirical point mass at zero, with zero component fractions; its frequency is not learned from request features."
    )
    channels = [
        ("inputTokens", lambda sample: sample["outcomes"]["inputTokens"]),
        (
            "totalTokens",
            lambda sample: sample["outcomes"]["inputTokens"] + sample["outcomes"]["outputTokens"],
        ),
    ]
    for channel, outcome in channels:
        observed_channel = [outcome(sample) for sample in heldout]
        baseline_channel = float(np.median([outcome(sample) for sample in train]))
        validation[channel] = errors(observed_channel, [row[channel]["p50"] for row in quotes])
        validation[f"baseline{channel[0].upper()}{channel[1:]}"] = errors(
            observed_channel, [baseline_channel] * len(heldout)
        )
        validation[f"{channel.removesuffix('Tokens')}Coverage"] = {
            name: float(
                np.mean(
                    [
                        value <= row[channel][name]
                        for value, row in zip(observed_channel, quotes, strict=True)
                    ]
                )
            )
            for name in QUANTILES
        }


def fit_quantile_section(eligible, split, validation, champion_path):
    """Fit the quantile trees and attach validation; without trees no quantile validation exists."""
    if not eligible:
        # Without trees there is nothing to compare; a gate must see no quantile validation.
        validation.pop("quantileModel", None)
        return None, None
    model, quantile_validation = fit_quantile_model(*split)
    validation["quantileModel"] = quantile_validation
    if champion_path is not None:
        challenger = (model, quantile_cap(model["ceiling"]))
        quantile_validation["champion"] = score_champion(champion_path, split[1], challenger)
    return model, quantile_validation


def build_artifact(dataset, champion_path=None):
    samples, rejected = validate_dataset(dataset)
    scope = dataset_scope(dataset)
    token_yield_basis = "workload" if scope == "completed-session" else "actions"
    workload_metric = "totalTokens" if scope == "completed-session" else "toolCalls"
    train, heldout, purged = frozen_split(samples)
    alpha, scores, residuals_by_alpha = select_alpha(train, workload_metric)
    model = fit_model(train, alpha, workload_metric)
    scenarios = [
        scenario(sample, value, token_yield_basis) for sample, value in residuals_by_alpha[alpha]
    ]
    model["residualQuantiles"] = quantiles([row["logResidual"] for row in scenarios])
    model["featureRanges"] = feature_ranges(train)
    work = [observed_work(s, workload_metric) for s in train]
    observed = [observed_work(s, workload_metric) for s in heldout]
    output = [s["outcomes"]["outputTokens"] for s in heldout]
    # The training maximum bounds scenario pricing, so a fat residual tail cannot
    # quote usage beyond anything ever measured. Actions artifacts keep no ceiling.
    ceiling = float(max(work)) if work and token_yield_basis == "workload" else None
    quotes = quote(model, scenarios, heldout, token_yield_basis, ceiling)
    predicted = [q["work"]["p50"] for q in quotes]
    predicted_output = [q["outputTokens"]["p50"] for q in quotes]
    baseline_work = float(np.median(work))
    baseline_output = float(np.median([s["outcomes"]["outputTokens"] for s in train]))
    model_error = errors(observed, predicted)
    baseline_error = errors(observed, [baseline_work] * len(heldout))
    coverage = {
        name: float(
            np.mean(
                [
                    observed_work(s, workload_metric) <= q["work"][name]
                    for s, q in zip(heldout, quotes, strict=True)
                ]
            )
        )
        for name in QUANTILES
    }
    output_coverage = {
        name: float(
            np.mean(
                [
                    s["outcomes"]["outputTokens"] <= q["outputTokens"][name]
                    for s, q in zip(heldout, quotes, strict=True)
                ]
            )
        )
        for name in QUANTILES
    }
    # Token totals span five orders of magnitude, so raw-token MAE is decided by a handful of
    # extreme sessions. The fit minimizes log error, so selection uses the same log-scale metric.
    improves = model_error["rmsle"] < baseline_error["rmsle"]
    has_signal = any(weight > 1e-8 for weight in model["coefficients"])
    # A tiny holdout can falsify a candidate but cannot establish accuracy.
    enough = len(groups(heldout)) >= 10 and len(scenarios) >= 30
    covered = all(
        channel["p80"] >= 0.8 and channel["p95"] >= 0.95 for channel in (coverage, output_coverage)
    )
    status = "validated" if enough and improves and has_signal and covered else "experimental"
    training = {
        "sampleIds": [s["sampleId"] for s in train],
        "sampleCount": len(train),
        "groupCount": len(groups(train)),
        "asOf": max(s["completedAt"] for s in train),
        "alpha": alpha,
        "featureVersion": dataset.get("featureVersion", "unspecified"),
        "fittingLibraries": {
            "numpy": np.__version__,
            "scipy": scipy.__version__,
            "scikit-learn": sklearn.__version__,
        },
        "oofSampleCount": len(scenarios),
        "oofGroupCount": len({s["groupId"] for s, _ in residuals_by_alpha[alpha]}),
        "providers": dict(Counter(str(s.get("provider", "unknown")) for s in train)),
    }
    scope_description = (
        "one inactive observed session snapshot, including interruptions and recorded errors; not human hours"
        if scope == "completed-session"
        else "one measured root-agent run; not whole issues or human hours"
    )
    validation = {
        "status": status,
        "scope": scope_description,
        "sampleCount": len(heldout),
        "groupCount": len(groups(heldout)),
        "sampleIds": [s["sampleId"] for s in heldout],
        "purgedSampleCount": len(purged),
        "splitPolicy": "newest 20% thread groups by earliest run start; every training group completed before earliest target start",
        "workloadMetric": workload_metric,
        "work": model_error,
        "baselineWork": baseline_error,
        "outputTokens": errors(output, predicted_output),
        "baselineOutputTokens": errors(output, [baseline_output] * len(heldout)),
        "workCoverage": coverage,
        "beatsWorkBaseline": improves,
        "outputCoverage": output_coverage,
        "hasLearnedComplexitySignal": has_signal,
        "providers": dict(Counter(str(s.get("provider", "unknown")) for s in heldout)),
        "limitations": [
            (
                "Observed logged session snapshots include later conversation changes, interruptions, and errors, not just initial intent; unlogged work and human time remain unobserved."
                if scope == "completed-session"
                else "Observational root-run outcomes omit unlogged child-agent work and human time."
            ),
            "Prework feature extraction uncertainty is not identified by this sample.",
            "Empirical OOF intervals are not coverage guarantees or risk-neutral prices.",
            "Alpha selection and residual calibration share older-group folds; newest groups remain untouched.",
            "Token yields reflect historical provider, tool, and context policy mixtures.",
        ],
        "selection": scores,
        "rejected": rejected,
    }
    if scope == "completed-session":
        add_session_channel_validation(validation, train, heldout, quotes)
    oof_ids = {s["sampleId"] for s, _ in residuals_by_alpha[alpha]}
    cohort_audit = {
        "sourceSamples": len(dataset["samples"]),
        "acceptedSamples": len(samples),
        "rejectedSamples": sum(rejected.values()),
        "rejectedByReason": rejected,
        "trainingSamples": len(train),
        "heldoutSamples": len(heldout),
        "temporalPurgedSamples": len(purged),
        "oofSamples": len(oof_ids),
        "trainingSamplesWithoutOof": len(train) - len(oof_ids),
        "acceptedZeroActionSamples": sum(s["outcomes"].get("toolCalls") == 0 for s in samples),
        "acceptedZeroUsageSamples": sum(
            s["outcomes"]["inputTokens"] + s["outcomes"]["outputTokens"] == 0
            for s in samples
            if finite(s["outcomes"].get("inputTokens"))
            and finite(s["outcomes"].get("outputTokens"))
        ),
        "oofZeroUsageScenarios": sum(bool(s.get("zeroWork")) for s in scenarios),
        "optionalAccountingMissing": {
            name: sum(s["outcomes"].get(name) is None for s in samples)
            for name in ("toolCalls", "toolRounds", "nonCachedInputTokens", "cachedInputTokens")
        },
    }
    source_counts = (
        count_tree(dataset.get("audit", {}).get("discovery"))
        if isinstance(dataset.get("audit"), dict)
        else {}
    )
    if source_counts:
        cohort_audit["discovery"] = source_counts
    candidate_workload = candidate_validation = candidate_scenarios = None
    estimator = "complexity"
    selection_reason = None
    if scope == "completed-session":
        # The held-out block selects the serving estimator. It is therefore a
        # validation selection set, not an independent test of that selection.
        candidate_workload = copy.deepcopy(model)
        candidate_validation = copy.deepcopy(validation)
        candidate_scenarios = copy.deepcopy(scenarios)
        validation["candidateHasLearnedComplexitySignal"] = has_signal
        validation["candidateMetricsNonfinite"] = not math.isfinite(model_error["rmsle"])
        if not math.isfinite(model_error["rmsle"]) or not improves:
            estimator = "historical-baseline"
            selection_reason = "Candidate total-token log error (RMSLE) did not beat the training-median baseline on held-out sessions."
            model = {
                **model,
                "intercept": float(math.log1p(baseline_work)),
                "coefficients": [0.0] * len(FEATURES),
                "missingCoefficients": [0.0] * len(FEATURES),
            }
            # Rebuild the full empirical training distribution. Candidate OOF
            # residuals must never distort a constant historical baseline.
            scenarios = [scenario(s, baseline_work, token_yield_basis) for s in train]
            model["residualQuantiles"] = quantiles([s["logResidual"] for s in scenarios])
            validation["hasLearnedComplexitySignal"] = False
            validation["status"] = "experimental"
        training["scenarioCount"] = len(scenarios)
        training["calibration"] = (
            "empirical-training-distribution"
            if estimator == "historical-baseline"
            else "chronological-out-of-fold"
        )
        cohort_audit["activeScenarios"] = len(scenarios)
        cohort_audit["activeZeroUsageScenarios"] = sum(bool(s.get("zeroWork")) for s in scenarios)
        active_quotes = quote(model, scenarios, heldout, token_yield_basis, ceiling)
        active_channels = [
            ("Work", "work", observed),
            ("OutputTokens", "outputTokens", output),
            ("InputTokens", "inputTokens", [s["outcomes"]["inputTokens"] for s in heldout]),
            ("TotalTokens", "totalTokens", observed),
        ]
        validation["activeCoverage"] = {}
        for label, channel, actual in active_channels:
            validation[f"active{label}"] = errors(
                actual, [q[channel]["p50"] for q in active_quotes]
            )
            key = channel.removesuffix("Tokens")
            validation["activeCoverage"][key] = {
                name: float(
                    np.mean(
                        [
                            value <= q[channel][name]
                            for value, q in zip(actual, active_quotes, strict=True)
                        ]
                    )
                )
                for name in QUANTILES
            }
        validation["selectionReason"] = selection_reason
        validation["limitations"].append(
            "The held-out block selected the active estimator; its active metrics are validation-selection results, not independent test performance."
        )
    quantile_model, quantile_validation = fit_quantile_section(
        scope == "completed-session" and all(quantile_text(sample) for sample in samples),
        (train, heldout, ceiling),
        validation,
        champion_path,
    )
    artifact = {
        "schemaVersion": 1,
        "method": "nonnegative-ridge-log-work-v1",
        "workUnit": "observed_session_total_tokens"
        if scope == "completed-session"
        else "observed_logged_tool_calls",
        "workloadMetric": workload_metric,
        "scope": scope,
        "tokenYieldBasis": token_yield_basis,
        "cohortAudit": cohort_audit,
        "featureNames": FEATURES,
        "workload": model,
        "quantileModel": quantile_model,
        "scenarios": scenarios,
        "workCutoffs": {
            "trivialMax": float(np.quantile(work, 1 / 3)),
            "deepMin": float(np.quantile(work, 2 / 3)),
        },
        "workloadCeiling": ceiling,
        "training": training,
        "validation": validation,
    }
    # Safe aggregate report deliberately omits sample IDs and raw features.
    report = {
        "schemaVersion": 1,
        "method": artifact["method"],
        "workUnit": artifact["workUnit"],
        "workloadMetric": workload_metric,
        "scope": scope,
        "tokenYieldBasis": token_yield_basis,
        "cohortAudit": cohort_audit,
        "formula": f"log1p({workload_metric})=intercept+sum(nonnegative_weight*feature/scale)+sum(missing_weight*is_missing)",
        "featureNames": FEATURES,
        "workload": model,
        "quantileModel": quantile_validation,
        "workCutoffs": artifact["workCutoffs"],
        "workloadCeiling": ceiling,
        "training": {k: v for k, v in training.items() if k != "sampleIds"},
        "validation": {k: v for k, v in validation.items() if k != "sampleIds"},
    }
    if scope == "completed-session":
        artifact.update(
            estimator=estimator,
            selectionReason=selection_reason,
            candidateWorkload=candidate_workload,
            candidateValidation=candidate_validation,
            candidateScenarios=candidate_scenarios,
        )
        report.update(
            estimator=estimator,
            selectionReason=selection_reason,
            candidateWorkload=candidate_workload,
            candidateValidation={k: v for k, v in candidate_validation.items() if k != "sampleIds"},
            candidateScenarioCount=len(candidate_scenarios),
        )
    return finite_metadata(artifact), finite_metadata(public_metadata(report))


def private_write(path, value):
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(value, handle, indent=2, allow_nan=False)
        handle.write("\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--champion", help="installed artifact whose quantileModel is scored")
    args = parser.parse_args()
    with open(args.dataset) as handle:
        dataset = json.load(handle)
    artifact, report = build_artifact(dataset, args.champion)
    private_write(args.output, artifact)
    private_write(args.report, report)
    print(
        json.dumps(
            {
                "status": artifact["validation"]["status"],
                "trainingSamples": artifact["training"]["sampleCount"],
                "heldoutSamples": artifact["validation"]["sampleCount"],
                "oofSamples": artifact["training"]["oofSampleCount"],
                "scenarioCount": len(artifact["scenarios"]),
                "estimator": artifact.get("estimator", "complexity"),
            }
        )
    )


if __name__ == "__main__":
    main()
