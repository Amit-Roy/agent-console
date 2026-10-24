#!/usr/bin/env python3
"""Incremental fetch of the SWE-chat dataset, reduced to effort-model benchmark rows.

Writes rows.jsonl plus manifest.json under ~/.cache/agent-console/effort-data/swe-chat.
Success prints one line; failures print `effort-data: <stage>: <msg>` and exit 1.
"""

import argparse
import collections
import datetime
import hashlib
import json
import os
import shutil
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import pyarrow as arrow
import pyarrow.compute as compute
import pyarrow.parquet as parquet_io

sys.dont_write_bytecode = True

DATASET = "SALT-NLP/SWE-chat"
API_URL = f"https://huggingface.co/api/datasets/{DATASET}"
RESOLVE_URL = f"https://huggingface.co/datasets/{DATASET}/resolve"
LICENSE = "odc-by"
PARQUETS = ("sessions.parquet", "conversations.parquet")
KEPT_AGENTS = ("Claude Code", "Codex", "Pi")
AGENT_TURNS = ("assistant_response", "tool_use")
TOKEN_KEY = "HUGGING_FACE_TOKEN"
ENV_FILE = Path.home() / ".config/agent-console/env"
DEFAULT_DIR = Path.home() / ".cache/agent-console/effort-data/swe-chat"
ROW_FIELDS = (
    "session_id",
    "repo_id",
    "user_id",
    "agent",
    "model",
    "created_at",
    "request_text",
    "total_tokens",
    "input_total",
    "output_total",
    "cache_read_total",
)
INPUT_COLUMNS = ("input_tokens", "cache_creation_tokens", "cache_read_tokens")
SESSION_COLUMNS = (
    "session_id",
    "repo_id",
    "user_id",
    "agent",
    "model",
    "created_at",
    *INPUT_COLUMNS,
    "output_tokens",
    *(f"subagent_{name}" for name in (*INPUT_COLUMNS, "output_tokens")),
)
CHUNK_BYTES = 1 << 20
HTTP_TIMEOUT_SECONDS = 60


class StageError(Exception):
    """A failure attributed to one named stage."""

    def __init__(self, stage, message):
        super().__init__(message)
        self.stage = stage


def load_token():
    """Return the Hugging Face token from env or the agent-console env file, or None."""
    token = os.environ.get(TOKEN_KEY)
    if token:
        return token.strip()
    try:
        lines = ENV_FILE.read_text().splitlines()
    except OSError:
        return None
    for line in lines:
        key, _, value = line.removeprefix("export ").partition("=")
        if key.strip() == TOKEN_KEY:
            return value.strip().strip("'\"") or None
    return None


class DropAuthOnRedirect(urllib.request.HTTPRedirectHandler):
    """Do not forward the bearer token to a different host (CDN signed URLs)."""

    def redirect_request(self, req, body, code, msg, headers, newurl):
        redirected = super().redirect_request(req, body, code, msg, headers, newurl)
        if (
            redirected
            and urllib.parse.urlsplit(newurl).netloc != urllib.parse.urlsplit(req.full_url).netloc
        ):
            redirected.headers.pop("Authorization", None)
            redirected.unredirected_hdrs.pop("Authorization", None)
        return redirected


def open_url(url, token):
    """Open a URL with an optional bearer header, never placing the token in argv."""
    request = urllib.request.Request(url)
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    opener = urllib.request.build_opener(DropAuthOnRedirect)
    return opener.open(request, timeout=HTTP_TIMEOUT_SECONDS)


def resolve_revision(token):
    """Return the dataset's current HF revision sha."""
    try:
        with open_url(API_URL, token) as response:
            sha = json.load(response).get("sha")
    except (OSError, ValueError) as error:
        raise StageError("revision", f"lookup failed: {error}") from error
    if not sha:
        raise StageError("revision", "response has no sha")
    return sha


def download(revision, name, target_dir, token):
    """Download one parquet to <name>.part, then rename it into place."""
    if not token:
        raise StageError("download", f"{TOKEN_KEY} missing from env and {ENV_FILE}")
    final = target_dir / name
    part = target_dir / f"{name}.part"
    try:
        with open_url(f"{RESOLVE_URL}/{revision}/{name}", token) as response:
            with open(part, "wb") as handle:
                shutil.copyfileobj(response, handle, CHUNK_BYTES)
    except OSError as error:
        part.unlink(missing_ok=True)
        raise StageError("download", f"{name}: {error}") from error
    part.rename(final)
    return final


def kept_sessions(path):
    """Read sessions.parquet columns, keep the agent allow-list, add token totals."""
    raw = parquet_io.read_table(path, columns=list(SESSION_COLUMNS))
    created = raw.column("created_at").cast(arrow.timestamp("us", tz="UTC"), safe=False)
    table = raw.set_column(
        raw.schema.get_field_index("created_at"), "created_at", created
    ).to_pydict()
    total_rows = len(table["session_id"])
    kept = []
    for index in range(total_rows):
        if table["agent"][index] not in KEPT_AGENTS:
            continue
        kept.append(session_record(table, index))
    return kept, total_rows


def number(table, name, index):
    """Return an integer column value, treating null as zero."""
    return int(table[name][index] or 0)


def session_record(table, index):
    """Build one session dict with created_at as ISO text and summed token totals."""
    created = table["created_at"][index]
    record = {name: table[name][index] for name in ROW_FIELDS[:5]}
    record["created_at"] = created.isoformat() if created is not None else None
    parts = (*INPUT_COLUMNS, *(f"subagent_{name}" for name in INPUT_COLUMNS))
    record["input_total"] = sum(number(table, name, index) for name in parts)
    record["output_total"] = number(table, "output_tokens", index) + number(
        table, "subagent_output_tokens", index
    )
    record["cache_read_total"] = number(table, "cache_read_tokens", index) + number(
        table, "subagent_cache_read_tokens", index
    )
    record["total_tokens"] = record["input_total"] + record["output_total"]
    return record


def row_group_turns(group, wanted):
    """Return (first agent turn per session, user prompts per session) for a row group."""
    mask = compute.is_in(group.column("session_id"), value_set=wanted)
    group = group.filter(mask)
    turn_type = group.column("turn_type")
    agent = group.filter(compute.is_in(turn_type, value_set=arrow.array(list(AGENT_TURNS))))
    first = {}
    if agent.num_rows:
        grouped = agent.group_by("session_id").aggregate([("turn_number", "min")]).to_pydict()
        first = dict(zip(grouped["session_id"], grouped["turn_number_min"], strict=True))
    users = group.filter(compute.equal(turn_type, "user_prompt")).to_pydict()
    return first, zip(users["session_id"], users["turn_number"], users["content"], strict=True)


def conversation_turns(path, session_ids):
    """Scan conversations.parquet once: first agent turn and user prompts per kept session."""
    wanted = arrow.array(sorted(session_ids))
    columns = ["session_id", "turn_number", "turn_type", "content"]
    parquet = parquet_io.ParquetFile(path)
    first_agent = {}
    prompts = collections.defaultdict(list)
    for index in range(parquet.num_row_groups):
        first, users = row_group_turns(parquet.read_row_group(index, columns=columns), wanted)
        for session, turn in first.items():
            first_agent[session] = min(turn, first_agent.get(session, turn))
        for session, turn, content in users:
            prompts[session].append((int(turn), content or ""))
    return first_agent, prompts


def request_text(prompts, cutoff):
    """Join non-blank user prompts that come before the first agent turn."""
    ordered = sorted(prompts)
    texts = [text for turn, text in ordered if (cutoff is None or turn < cutoff) and text.strip()]
    return "\n\n".join(texts)


def build_rows(sessions_path, conversations_path):
    """Return (rows, drop counts) for kept agents with request text and tokens."""
    sessions, total_sessions = kept_sessions(sessions_path)
    first_agent, prompts = conversation_turns(
        conversations_path, {item["session_id"] for item in sessions}
    )
    drops = collections.Counter(agent_excluded=total_sessions - len(sessions))
    rows = []
    for session in sessions:
        sid = session["session_id"]
        text = request_text(prompts.get(sid, []), first_agent.get(sid))
        if not text:
            drops["no_request_text"] += 1
        elif session["total_tokens"] == 0:
            drops["zero_total_tokens"] += 1
        else:
            rows.append({**session, "request_text": text})
    return rows, dict(drops)


def write_rows(rows, target):
    """Write rows.jsonl atomically; return its sha256 hex digest."""
    digest = hashlib.sha256()
    part = target.with_name(target.name + ".part")
    descriptor = os.open(part, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        for row in rows:
            line = (
                json.dumps({field: row[field] for field in ROW_FIELDS}, ensure_ascii=False) + "\n"
            ).encode()
            digest.update(line)
            handle.write(line)
    part.rename(target)
    return digest.hexdigest()


def write_manifest(target, revision, rows, drops, rows_sha256):
    """Write manifest.json atomically."""
    manifest = {
        "revision": revision,
        "license": LICENSE,
        "source": f"https://huggingface.co/datasets/{DATASET}",
        "fetchedAt": datetime.datetime.now(datetime.UTC).isoformat(timespec="seconds"),
        "rowCount": len(rows),
        "rowsByAgent": dict(collections.Counter(row["agent"] for row in rows)),
        "dropCounts": drops,
        "rowsSha256": rows_sha256,
    }
    part = target.with_name(target.name + ".part")
    descriptor = os.open(part, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        json.dump(manifest, handle, indent=2)
        handle.write("\n")
    part.rename(target)
    return manifest


def read_manifest(path):
    """Return the stored manifest dict, or None when missing or unreadable."""
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def prepare_dir(path):
    """Create the output directory with mode 0700."""
    try:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
        path.chmod(0o700)
    except OSError as error:
        raise StageError("storage", f"{path}: {error}") from error


def fetch_raw(args, revision, token):
    """Return (sessions path, conversations path, downloaded?) from --raw-dir or HF."""
    if args.raw_dir:
        paths = [args.raw_dir / name for name in PARQUETS]
        missing = [str(path) for path in paths if not path.is_file()]
        if missing:
            raise StageError("download", f"missing raw parquet: {missing[0]}")
        return (*paths, False)
    raw = args.dir / "raw"
    prepare_dir(raw)
    return (*(download(revision, name, raw, token) for name in PARQUETS), True)


def discard_raw(args, downloaded):
    """Delete downloaded raw parquets unless --keep-raw; never touch --raw-dir."""
    if downloaded and not args.keep_raw:
        shutil.rmtree(args.dir / "raw", ignore_errors=True)


def run(args):
    """Fetch if the revision changed; return the one-line status."""
    token = load_token()
    revision = resolve_revision(token)
    prepare_dir(args.dir)
    rows_path = args.dir / "rows.jsonl"
    manifest_path = args.dir / "manifest.json"
    stored = read_manifest(manifest_path)
    if stored and stored.get("revision") == revision and rows_path.is_file():
        return f"swe-chat up to date rev {revision[:8]} rows {stored.get('rowCount')}"
    sessions_path, conversations_path, downloaded = fetch_raw(args, revision, token)
    try:
        rows, drops = build_rows(sessions_path, conversations_path)
    except (OSError, KeyError, ValueError, arrow.ArrowException) as error:
        raise StageError("build", str(error)) from error
    digest = write_rows(rows, rows_path)
    write_manifest(manifest_path, revision, rows, drops, digest)
    discard_raw(args, downloaded)
    return f"swe-chat fetched rev {revision[:8]} rows {len(rows)} {args.dir}"


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description="Incremental SWE-chat fetch for effort benchmarks."
    )
    parser.add_argument("--dir", type=Path, default=DEFAULT_DIR, help="output directory")
    parser.add_argument("--raw-dir", type=Path, help="reuse sessions/conversations parquets here")
    parser.add_argument("--keep-raw", action="store_true", help="keep downloaded raw parquets")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        print(run(args))
    except StageError as error:
        print(f"effort-data: {error.stage}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
