#!/usr/bin/env python3
"""Redact credentials from explicitly supported transcript stores, without backups."""

import argparse
import fcntl
import json
import os
import re
import sqlite3
import stat
import sys
from pathlib import Path

SECRET_NAME = re.compile(r"(?:api.?key|token|password|secret|authorization|credential)s?$", re.I)
TOKEN = re.compile(
    r"(?<![A-Za-z0-9_/-])(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|nvapi-[A-Za-z0-9_-]{16,}|(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}|(?:hf_|pplx-|gsk_)[A-Za-z0-9_-]{24,}|AIza[A-Za-z0-9_-]{25,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{15,})(?![A-Za-z0-9_/-])"
)
ASSIGN = re.compile(
    r"""(?ix)(?<![\w.-])(?:[a-z][a-z0-9]*[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization|credential)["']?\s*[:=]\s*(?:["']([^"'\r\n]{12,})["']|([^\s,"'{}\[\]]{12,}))"""
)
BEARER = re.compile(r"(?i)\bBearer\s+([A-Za-z0-9._~+/-]{12,}=*)")
PEM = re.compile(
    r"-----BEGIN (?:[A-Z0-9 ]* )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]* )?PRIVATE KEY-----"
)
JSON_STRING = re.compile(r'"(?:[^"\\]|\\.)*"')
ESCAPE = re.compile(r"\\u[0-9a-fA-F]{4}|\\.|[^\\\r\n]")
DATABASE_NAMES = ("thread_history_1", "state_5", "logs_2", "memories_1", "queue_1", "goals_1")
ARCHIVES = (".gz", ".zip", ".xz", ".bz2", ".zst", ".tar", ".tgz", ".7z")


class RedactionError(Exception):
    """An intentionally content-free operational error."""


def meaningful(value):
    return (
        isinstance(value, str)
        and len(value) >= 8
        and len(set(value)) >= 4
        and not re.fullmatch(
            r"(?i)(?:\*+|x+|<.*>|\$.*|your[-_ ].*|example.*|placeholder.*|redacted.*|undefined|none|null)",
            value,
        )
    )


def merge_spans(spans):
    merged = []
    for start, end in sorted(spans):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
        else:
            merged.append((start, end))
    return merged


def mask(value):
    def replacement(found):
        segment = found.group()
        if segment.startswith("\\u"):
            return "\\u002a"
        if segment.startswith("\\"):
            return "\\/"
        return "*" * len(segment.encode("utf-8", "surrogateescape"))

    return ESCAPE.sub(replacement, value)


class Scrubber:
    def __init__(self, secrets):
        self.secrets = set(secrets)
        self.variants = set(secrets)
        for secret in secrets:
            self.variants.add(json.dumps(secret, ensure_ascii=True)[1:-1])
            self.variants.add(json.dumps(secret, ensure_ascii=False)[1:-1])

    def spans(self, text):
        spans = [match.span() for match in TOKEN.finditer(text)]
        spans.extend(match.span() for match in PEM.finditer(text))
        for secret in self.variants:
            offset = text.find(secret)
            while offset >= 0:
                spans.append((offset, offset + len(secret)))
                offset = text.find(secret, offset + len(secret))
        return merge_spans(spans)

    def candidates(self, text):
        spans = []
        for pattern in (ASSIGN, BEARER):
            for match in pattern.finditer(text):
                value = next((group for group in match.groups() if group is not None), "")
                if meaningful(value) and value.lower() != "authentication":
                    spans.append(match.span())
        return len(merge_spans(spans))

    def scrub(self, text):
        spans = self.spans(text)
        spans.extend(self.escaped_spans(text))
        spans = merge_spans(spans)
        cleaned = text
        for start, end in reversed(spans):
            cleaned = cleaned[:start] + mask(text[start:end]) + cleaned[end:]
        return cleaned, len(spans), self.candidates(cleaned), spans

    def escaped_spans(self, text):
        spans = []
        for token in JSON_STRING.finditer(text):
            raw = token.group()[1:-1]
            if "\\" not in raw:
                continue
            try:
                decoded = json.loads(token.group())
                mapping = string_mapping(raw)
                for start, end in self.spans(decoded):
                    spans.append(
                        (
                            token.start() + 1 + mapping[start][0],
                            token.start() + 1 + mapping[end - 1][1],
                        )
                    )
            except (ValueError, IndexError):
                continue
        return spans


def string_mapping(raw):
    mapping = []
    offset = 0
    while offset < len(raw):
        width = 1
        if raw[offset] == "\\":
            width = 6 if raw[offset : offset + 2] == "\\u" else 2
            if width == 6 and re.match(
                r"\\u[dD][89aAbB][0-9a-fA-F]{2}\\u[dD][c-fC-F][0-9a-fA-F]{2}", raw[offset:]
            ):
                width = 12
        mapping.append((offset, offset + width))
        offset += width
    return mapping


def collect_credentials(value):
    found = set()
    if isinstance(value, dict):
        for key, child in value.items():
            if SECRET_NAME.search(key) and meaningful(child):
                found.add(child)
            found.update(collect_credentials(child))
    elif isinstance(value, list):
        for child in value:
            found.update(collect_credentials(child))
    return found


def auth_files(home, data, codex_homes):
    paths = [
        home / name
        for name in (
            ".claude/.credentials.json",
            ".claude-secondary/.credentials.json",
            ".pi/agent/auth.json",
            ".pi/agent/mcp-auth.json",
            ".config/gh/hosts.yml",
            ".npmrc",
            ".mcp.json",
        )
    ]
    paths += [
        data / name
        for name in (
            ".env",
            "env",
            "tool-env.sh",
            "password",
            "secret",
            "artificial-analysis.key",
            "model-rate-token",
        )
    ]
    paths += [root / "auth.json" for root in codex_homes]
    paths += [
        root / name
        for root in (data / "auto-runtime").glob("*/*")
        if root.name in ("claude", "pi")
        for name in (".credentials.json", "auth.json", "mcp-auth.json")
    ]
    paths += [
        Path(value).expanduser()
        for value in re.split(r"[:,]", os.environ.get("AGENT_CONSOLE_ENV_FILES", ""))
        if value and configured_path(Path(value).expanduser(), home)
    ]
    return paths


def load_secrets(paths):
    secrets = {
        value for key, value in os.environ.items() if SECRET_NAME.search(key) and meaningful(value)
    }
    for path in paths:
        if not path.is_file():
            continue
        source = path.read_text(encoding="utf-8")
        if path.name in (
            "password",
            "secret",
            "artificial-analysis.key",
            "model-rate-token",
        ) and meaningful(source.strip()):
            secrets.add(source.strip())
        try:
            secrets.update(collect_credentials(json.loads(source)))
        except ValueError:
            pass
        secrets.update(match.group() for match in TOKEN.finditer(source))
        for match in ASSIGN.finditer(source):
            value = match.group(1) or match.group(2)
            if meaningful(value):
                secrets.add(value)
    return secrets


def symlink_component(path):
    return any(parent.is_symlink() for parent in (path, *path.parents))


def safe_store(path, protected):
    info = path.lstat()
    if symlink_component(path) or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise RedactionError("unsafe_alias")
    if (info.st_dev, info.st_ino) in protected:
        raise RedactionError("protected_auth")
    return info


def configured_path(path, home):
    return home == Path.home() or path.is_relative_to(home)


def provider_roots(home, data):
    codex_homes = [home / ".codex"]
    configured = Path(os.environ.get("CODEX_HOME", str(home / ".codex"))).expanduser()
    if configured_path(configured, home):
        codex_homes.append(configured)
    providers = [(home / name, "claude") for name in (".claude", ".claude-secondary")]
    providers += [(home / name, "pi") for name in (".pi/agent", ".pi-agent", ".config/pi")]
    providers += [
        (path, path.name)
        for path in (data / "auto-runtime").glob("*/*")
        if path.name in ("codex", "claude", "pi")
    ]
    codex_homes.extend(path for path, provider in providers if provider == "codex")
    providers += [(path, "codex") for path in codex_homes]
    return providers, list(set(codex_homes))


def native_locations(providers):
    roots, files, databases = [], [], []
    for root, provider in providers:
        leaves = {
            "codex": ("sessions", "archived_sessions", "log"),
            "claude": ("projects", "projects-archive", "debug"),
            "pi": ("sessions",),
        }[provider]
        roots.extend(root / leaf for leaf in leaves)
        files.extend(root / name for name in ("history.jsonl", "session_index.jsonl"))
        if provider == "codex":
            databases.extend(root / (name + ".sqlite") for name in DATABASE_NAMES)
    return roots, files, databases


def discover(home, data, scope, skip_catalog):
    providers, codex_homes = provider_roots(home, data)
    auth = auth_files(home, data, codex_homes)
    roots, files, databases = native_locations(providers) if scope != "console" else ([], [], [])
    if scope != "native":
        roots += [data / name for name in ("logs", "pi-sessions", "pi-research")]
        files.extend(data.glob("turns.jsonl*"))
        if not skip_catalog:
            files.append(data / "threads.json")
        databases.append(data / "session-search.sqlite")
    unsupported = []
    for root in roots:
        if not root.exists():
            continue
        if symlink_component(root):
            unsupported.append(("unsafe_alias", "transcript"))
            continue
        walk_store(root, files, unsupported)
    for path in files[:]:
        if path.suffix in ARCHIVES:
            unsupported.append(("unsupported_archive", "transcript"))
            files.remove(path)
    return (
        sorted(set(path for path in files if path.exists() or path.is_symlink())),
        sorted(set(path for path in databases if path.exists() or path.is_symlink())),
        auth,
        unsupported,
    )


def walk_store(root, files, errors):
    for directory, children, names in os.walk(root, followlinks=False):
        base = Path(directory)
        filter_children(base, children, errors)
        for name in names:
            path = base / name
            if path.suffix in ARCHIVES:
                errors.append(("unsupported_archive", "transcript"))
            elif (
                path.suffix in (".json", ".jsonl", ".ndjson", ".log", ".txt")
                or ".jsonl.backup" in name
            ):
                files.append(path)


def filter_children(base, children, errors):
    for child in children[:]:
        if child in ("node_modules", "venv", ".venv", "plugins", "site-packages", ".git"):
            children.remove(child)
            continue
        if (base / child).is_symlink():
            errors.append(("unsafe_alias", "transcript"))
            children.remove(child)


class JsonLocations:
    """Locate JSON string values without serializing or changing byte offsets."""

    def __init__(self, text):
        self.text = text
        self.offset = 0
        self.locations = []
        self.decoder = json.JSONDecoder()

    def whitespace(self):
        while self.offset < len(self.text) and self.text[self.offset].isspace():
            self.offset += 1

    def value(self, path=()):
        self.whitespace()
        character = self.text[self.offset]
        if character == "{":
            self.container(path, True)
        elif character == "[":
            self.container(path, False)
        else:
            start = self.offset
            value, self.offset = self.decoder.raw_decode(self.text, self.offset)
            if isinstance(value, str):
                self.locations.append((path, start, self.offset))

    def container(self, path, object_mode):
        self.offset += 1
        self.whitespace()
        index = 0
        closing = "}" if object_mode else "]"
        while self.text[self.offset] != closing:
            key = index
            if object_mode:
                key, self.offset = self.decoder.raw_decode(self.text, self.offset)
                self.whitespace()
                self.offset += 1
            self.value((*path, key))
            index += 1
            self.whitespace()
            if self.text[self.offset] == ",":
                self.offset += 1
                self.whitespace()
        self.offset += 1


def catalog_file_spans(content, scrubber):
    value = json.loads(content)
    prefix = () if isinstance(value, list) else ("threads",)
    threads = value if isinstance(value, list) else value.get("threads")
    if not isinstance(threads, list):
        raise RedactionError("invalid_catalog")
    locations = JsonLocations(content)
    locations.value()
    spans = []
    candidates = 0
    for path, start, end in locations.locations:
        if not catalog_string_path(path, prefix):
            continue
        cleaned, unused, pending, found = scrubber.scrub(content[start:end])
        candidates += pending
        spans.extend((start + first, start + last) for first, last in found)
    return merge_spans(spans), candidates


def catalog_string_path(path, prefix):
    size = len(prefix)
    if path[:size] != prefix or len(path) < size + 2:
        return False
    if not isinstance(path[size], int):
        return False
    return path[size + 1] == "recent" or (path[size + 1] == "title" and len(path) == size + 2)


def scrub_content(content, path, scrubber):
    if path.name != "threads.json":
        return scrubber.scrub(content)
    spans, candidates = catalog_file_spans(content, scrubber)
    cleaned = content
    for start, end in reversed(spans):
        cleaned = cleaned[:start] + mask(content[start:end]) + cleaned[end:]
    return cleaned, len(spans), candidates, spans


def validate_structure(before, after, path):
    if path.suffix == ".json":
        validate_json(before, after)
    elif ".jsonl" in path.name or path.suffix == ".ndjson":
        for original, changed in zip(before.splitlines(), after.splitlines(), strict=True):
            validate_json(original, changed)


def validate_json(before, after):
    try:
        json.loads(before)
    except ValueError:
        return
    try:
        json.loads(after)
    except ValueError as error:
        raise RedactionError("invalid_json") from error


def same_file(path, snapshot):
    current = path.lstat()
    return (current.st_dev, current.st_ino) == (
        snapshot.st_dev,
        snapshot.st_ino,
    ) and not symlink_component(path)


def descriptor_matches(descriptor, snapshot):
    opened = os.fstat(descriptor)
    return (
        (opened.st_dev, opened.st_ino) == (snapshot.st_dev, snapshot.st_ino)
        and opened.st_nlink == 1
        and stat.S_ISREG(opened.st_mode)
    )


def apply_ranges(handle, path, snapshot, before, after, content, spans):
    if (
        not descriptor_matches(handle, snapshot)
        or not same_file(path, snapshot)
        or os.pread(handle, len(before), 0) != before
    ):
        raise RedactionError("concurrent_change")
    for start, end in spans:
        if not descriptor_matches(handle, snapshot) or not same_file(path, snapshot):
            raise RedactionError("concurrent_change")
        offset = len(content[:start].encode("utf-8", "surrogateescape"))
        size = len(content[start:end].encode("utf-8", "surrogateescape"))
        if os.pread(handle, size, offset) != before[offset : offset + size]:
            raise RedactionError("concurrent_change")
        if os.pwrite(handle, after[offset : offset + size], offset) != size:
            raise RedactionError("short_write")
    os.fsync(handle)
    if not same_file(path, snapshot):
        raise RedactionError("concurrent_change")
    if os.pread(handle, len(after), 0) != after:
        raise RedactionError("write_audit_failed")


def scrub_file(path, scrubber, apply, protected=frozenset()):
    snapshot = safe_store(path, protected)
    descriptor = os.open(path, (os.O_RDWR if apply else os.O_RDONLY) | os.O_NOFOLLOW)
    try:
        if not descriptor_matches(descriptor, snapshot) or not same_file(path, snapshot):
            raise RedactionError("concurrent_change")
        fcntl.flock(
            descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB if apply else fcntl.LOCK_SH | fcntl.LOCK_NB
        )
        before = os.pread(descriptor, snapshot.st_size, 0)
        content = before.decode("utf-8", "surrogateescape")
        cleaned, matches, candidates, spans = scrub_content(content, path, scrubber)
        after = cleaned.encode("utf-8", "surrogateescape")
        if len(after) != len(before):
            raise RedactionError("length_mismatch")
        validate_structure(content, cleaned, path)
        if apply and matches:
            apply_ranges(descriptor, path, snapshot, before, after, content, spans)
        if apply:
            audit = os.pread(descriptor, os.fstat(descriptor).st_size, 0).decode(
                "utf-8", "surrogateescape"
            )
            if scrub_content(audit, path, scrubber)[1]:
                raise RedactionError("concurrent_secret")
        return matches, candidates
    finally:
        os.close(descriptor)


def identifier(value):
    return '"' + value.replace('"', '""') + '"'


def database_tables(connection):
    tables = connection.execute(
        "SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()
    shadows = {row[1] for row in connection.execute("PRAGMA table_list") if row[2] == "shadow"}
    rebuild, external = [], set()
    for name, definition in tables:
        if not definition or not re.search(r"CREATE\s+VIRTUAL\s+TABLE", definition, re.I):
            continue
        if not re.search(r"\bfts[345]\b", definition, re.I):
            raise RedactionError("unsupported_virtual_table")
        content = re.search(
            r"""\bcontent\s*=\s*(?:['"]([^'"]*)['"]|([a-zA-Z_][a-zA-Z_0-9]*))""", definition, re.I
        )
        if content and not (content.group(1) or content.group(2)):
            raise RedactionError("unsupported_contentless_fts")
        if content:
            external.add(name)
        rebuild.append(name)
    return [
        (name, definition) for name, definition in tables if name not in shadows | external
    ], rebuild


def scrub_table(connection, name, definition, scrubber, apply):
    columns = connection.execute("PRAGMA table_info(" + identifier(name) + ")").fetchall()
    primary = [column[1] for column in sorted(columns, key=lambda column: column[5]) if column[5]]
    keys = primary if re.search(r"WITHOUT\s+ROWID", definition or "", re.I) else ["rowid"]
    matches = candidates = 0
    for column in columns:
        counts = scrub_column(connection, name, column[1], keys, scrubber, apply)
        matches += counts[0]
        candidates += counts[1]
    return matches, candidates


def scrub_column(connection, table, column, keys, scrubber, apply):
    fields = ",".join(identifier(key) for key in keys + [column])
    query = (
        "SELECT "
        + fields
        + " FROM "
        + identifier(table)
        + " WHERE typeof("
        + identifier(column)
        + ")='text'"
    )
    matches = candidates = 0
    for row in connection.execute(query).fetchall():
        cleaned, count, pending, unused = scrubber.scrub(row[-1])
        matches += count
        candidates += pending
        if apply and count:
            conditions = " AND ".join(identifier(key) + " IS ?" for key in keys)
            connection.execute(
                "UPDATE "
                + identifier(table)
                + " SET "
                + identifier(column)
                + "=? WHERE "
                + conditions,
                [cleaned, *row[:-1]],
            )
    return matches, candidates


def checkpoint(connection):
    result = connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
    if result and result[0]:
        raise RedactionError("database_busy")


def audit_database_bytes(path, scrubber):
    for suffix in ("", "-wal", "-journal"):
        target = Path(str(path) + suffix)
        if (
            target.exists()
            and scrubber.scrub(target.read_bytes().decode("utf-8", "surrogateescape"))[1]
        ):
            raise RedactionError("database_raw_residual")


def scrub_database(path, scrubber, apply, protected=frozenset()):
    snapshot = safe_store(path, protected)
    for suffix in ("-wal", "-shm", "-journal"):
        sidecar = Path(str(path) + suffix)
        if sidecar.exists() or sidecar.is_symlink():
            safe_store(sidecar, protected)
    connection = sqlite3.connect(
        path.as_uri() + ("?mode=rw" if apply else "?mode=ro"), uri=True, timeout=0.2
    )
    try:
        if apply:
            connection.execute("PRAGMA secure_delete=ON")
            connection.execute("BEGIN IMMEDIATE")
        tables, rebuild = database_tables(connection)
        matches = candidates = 0
        for name, definition in tables:
            count, pending = scrub_table(connection, name, definition, scrubber, apply)
            matches += count
            candidates += pending
        if apply:
            finalize_database(connection, rebuild)
        if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RedactionError("database_integrity_failed")
        if not same_file(path, snapshot):
            raise RedactionError("concurrent_change")
    finally:
        connection.close()
    if apply or not matches:
        audit_database_bytes(path, scrubber)
    if apply:
        if scrub_database(path, scrubber, False, protected)[0]:
            raise RedactionError("database_logical_residual")
    return matches, candidates


def finalize_database(connection, rebuild):
    for name in rebuild:
        connection.execute(
            "INSERT INTO " + identifier(name) + "(" + identifier(name) + ") VALUES ('rebuild')"
        )
    connection.commit()
    checkpoint(connection)
    connection.execute("VACUUM")
    checkpoint(connection)


def catalog_transform(value, scrubber, apply):
    matches = candidates = 0
    if isinstance(value, str):
        cleaned, matches, candidates, unused = scrubber.scrub(value)
        return cleaned if apply else value, matches, candidates
    if isinstance(value, (list, dict)):
        output = {} if isinstance(value, dict) else []
        items = value.items() if isinstance(value, dict) else enumerate(value)
        for key, child in items:
            cleaned, count, pending = catalog_transform(child, scrubber, apply)
            if isinstance(output, dict):
                output[key] = cleaned
            else:
                output.append(cleaned)
            matches += count
            candidates += pending
        return output, matches, candidates
    return value, 0, 0


def catalog_stdio(scrubber, apply):
    value = json.load(sys.stdin)
    if not isinstance(value, dict) or not isinstance(value.get("threads"), list):
        raise RedactionError("invalid_catalog")
    matches = candidates = changed = 0
    for thread in value["threads"]:
        if not isinstance(thread, dict):
            raise RedactionError("invalid_catalog")
        dirty = False
        for field in ("title", "recent"):
            if field not in thread:
                continue
            original = thread[field]
            cleaned, count, pending = catalog_transform(original, scrubber, apply)
            thread[field] = cleaned
            matches += count
            candidates += pending
            dirty = dirty or cleaned != original
        changed += dirty
    return {
        "threads": value["threads"],
        "matches": matches,
        "candidates": candidates,
        "changed": changed,
    }


def pid_owns_catalog(candidate, data):
    try:
        process = int(candidate.read_text().strip())
        if process <= 0:
            return True
        os.kill(process, 0)
        process_root = Path("/proc") / str(process)
        command = (process_root / "cmdline").read_bytes()
        if b"server/index.ts" not in command:
            return False
        environment = (process_root / "environ").read_bytes().split(b"\0")
        settings = dict(item.split(b"=", 1) for item in environment if b"=" in item)
        owner_home = Path(os.fsdecode(settings.get(b"HOME", os.fsencode(Path.home()))))
        owner_data = Path(
            os.fsdecode(
                settings.get(
                    b"AGENT_CONSOLE_DATA", os.fsencode(owner_home / ".config/agent-console")
                )
            )
        )
        return owner_data.absolute() == data.absolute()
    except ProcessLookupError:
        return False
    except (OSError, ValueError):
        return True


def live_catalog(home, data, run_dir=None):
    configured = Path(os.environ.get("AGENT_CONSOLE_RUN", str(home / ".cache/agent-console")))
    run = Path(run_dir).expanduser() if run_dir else configured
    if not run_dir and not configured_path(run, home):
        run = home / ".cache/agent-console"
    paths = [run / name for name in ("server.pid", "agent-console.pid", "pid")]
    return any(pid_owns_catalog(candidate, data) for candidate in paths if candidate.exists())


def result_template(action):
    return dict(
        type="result",
        action=action,
        status="complete",
        matches=0,
        candidates=0,
        filesScanned=0,
        filesChanged=0,
        databasesScanned=0,
        errors=[],
    )


def safe_error(error):
    if isinstance(error, RedactionError):
        return str(error)
    if isinstance(error, sqlite3.OperationalError):
        return (
            "database_busy"
            if "locked" in str(error).lower() or "busy" in str(error).lower()
            else "database_error"
        )
    return "store_unreadable" if isinstance(error, OSError) else "store_invalid"


def process_stores(files, databases, scrubber, apply, protected, result, progress=False):
    for store, paths, operation, counter in (
        ("transcript", files, scrub_file, "filesScanned"),
        ("database", databases, scrub_database, "databasesScanned"),
    ):
        for path in paths:
            try:
                matches, candidates = operation(path, scrubber, apply, protected)
                result[counter] += 1
                result["matches"] += matches
                result["candidates"] += candidates
                if store == "transcript" and apply and matches:
                    result["filesChanged"] += 1
            except Exception as error:
                result["errors"].append({"code": safe_error(error), "store": store})
            if progress and (
                store == "database" or (result[counter] > 0 and result[counter] % 100 == 0)
            ):
                emit_progress(result)


def emit_progress(result):
    event = {key: value for key, value in result.items() if isinstance(value, int)}
    event.update(type="progress", action=result["action"], errors=len(result["errors"]))
    print(json.dumps(event), flush=True)


def selected_data(home, explicit):
    if explicit:
        return Path(explicit).expanduser().absolute()
    configured = (
        Path(os.environ.get("AGENT_CONSOLE_DATA", str(home / ".config/agent-console")))
        .expanduser()
        .absolute()
    )
    return configured if configured_path(configured, home) else home / ".config/agent-console"


def run(args):
    home = Path(args.home).expanduser().absolute()
    data = selected_data(home, args.data_dir)
    files, databases, auth, unsupported = discover(home, data, args.scope, args.skip_catalog)
    scrubber = Scrubber(load_secrets(auth))
    if args.catalog_stdio:
        return catalog_stdio(scrubber, args.action == "apply")
    result = result_template(args.action)
    result["errors"] = [{"code": code, "store": store} for code, store in unsupported]
    apply = args.action == "apply"
    if (
        apply
        and args.scope != "native"
        and not args.skip_catalog
        and live_catalog(home, data, args.run_dir)
    ):
        raise RedactionError("live_catalog_use_session_redact_apply")
    protected = {(path.stat().st_dev, path.stat().st_ino) for path in auth if path.exists()}
    process_stores(files, databases, scrubber, apply, protected, result, args.json)
    if result["errors"]:
        result["status"] = "incomplete"
    if args.action == "verify" and result["matches"]:
        result["status"] = "failed"
    return result


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise RedactionError("invalid_arguments")


def arguments():
    parser = SafeParser(description=__doc__)
    parser.add_argument("action", nargs="?", choices=("scan", "apply", "verify"), default="scan")
    parser.add_argument("--home", default=str(Path.home()))
    parser.add_argument("--data-dir")
    parser.add_argument("--run-dir", help="Console PID directory for offline ownership checks")
    parser.add_argument("--scope", choices=("all", "console", "native"), default="all")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--skip-catalog", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--catalog-stdio", action="store_true", help=argparse.SUPPRESS)
    return parser.parse_args()


def main():
    action = "scan"
    descriptor = None
    try:
        args = arguments()
        action = args.action
        if args.action == "apply" and not args.catalog_stdio:
            lock_path = Path("/tmp") / (
                "agent-console-transcript-redact-" + str(os.getuid()) + ".lock"
            )
            descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            lock_info = os.fstat(descriptor)
            if (
                lock_info.st_uid != os.getuid()
                or lock_info.st_nlink != 1
                or not stat.S_ISREG(lock_info.st_mode)
            ):
                raise RedactionError("unsafe_lock")
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = run(args)
    except Exception as error:
        result = result_template(action)
        result.update(
            status="failed", errors=[{"code": safe_error(error), "store": "configuration"}]
        )
    finally:
        if descriptor is not None:
            os.close(descriptor)
    print(json.dumps(result), flush=True)
    return 0 if result.get("status", "complete") == "complete" else 1


if __name__ == "__main__":
    sys.exit(main())
