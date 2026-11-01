# Codemap

Codemap is an in-house codebase map for local and GitHub repos. It is our take on [haydenschmitty/floorplan](https://github.com/haydenschmitty/floorplan). The scanner is vendored under `server/vendor/floorplan/` (MIT, see its `LICENSE` and `UPSTREAM.txt`). Issue [#405](https://github.com/Amit-Roy/agent-console/issues/405).

## Use

- **Web:** More (⋯) menu > **Map a repo**, or open `/maps`. Paste a local path under `~/repos`, `owner/repo`, or a `github.com` URL. Cards show status; drill into modules and flows.
- **CLI:** `bin/codemap` (on PATH via `dotfiles`):

```sh
codemap add <path|owner/repo|github-url> [--wait]
codemap list
codemap status <slug>
codemap show <slug> [--module ID]
codemap spec <slug> [--module ID] [--flow ID]
codemap refresh <slug> [--describe]
codemap rm <slug>
```

`show` prints a compact text brief for agents. `spec` prints architecture JSON (the `arch` block format used by `public/arch.js`). Open `https://<console>/maps#/<slug>` to view; that requires an Agent Console session.

## Pipeline

1. **Clone** (GitHub sources only): `git clone --depth 1 --single-branch --no-tags`, with `core.hooksPath=/dev/null`, `core.symlinks=false`, `GIT_TERMINAL_PROMPT=0`, a 120 s timeout. Refresh uses `fetch --depth 1` plus `reset --hard FETCH_HEAD`. Local sources are used in place after a realpath check.
2. **Scan:** the vendored `scan.mjs` runs as a child Node process (180 s timeout) and writes `scan.json`. It never writes into the repo.
3. **Quick map:** folders become systems and modules; external hosts become external nodes (`heuristicArchitecture`). Shown immediately with status `describing`.
4. **Naming pass:** Sonnet via `claude --print --tools ""` with no MCP and no slash commands, system prompt fixed, 300 s timeout. Input is a bounded digest (40 KB cap) wrapped in `<untrusted_repo_data>` tags; the model is told to treat it as data. Output must be valid JSON that passes validation; one retry, then the quick map is kept with an error note.
5. **Views:** `assembleMap` writes `map.json`; `public/maps.js` draws it with the shared `public/arch.js` renderer.

One build runs at a time. A server restart marks in-flight builds `failed: interrupted`. Re-running `refresh` reuses the kept naming output unless the top-level folders changed or `--describe` is passed.

## Storage

`~/.config/agent-console/maps/<slug>/` (honours `AGENT_CONSOLE_DATA`): `meta.json`, `scan.json`, `architecture.json`, `map.json`, and `clone/` for GitHub sources. Slugs match `^[a-z0-9][a-z0-9-]{0,99}$`. Up to 30 maps.

## Safety

- No repo code is executed by codemap itself. The scanner runs on the repo files; git hooks are disabled and clones use `core.symlinks=false`.
- GitHub clones go under the console data dir, never under `~/repos`. Local sources must already live under `~/repos` and be git checkouts.
- Size limits for GitHub clones: 300 MB and 25,000 files; a breach deletes the clone. (Local sources are not limit-checked.)
- Private GitHub repos: the `gh` credential helper is used only when the repo owner equals the authenticated `gh` login. Other owners get no credentials.
- The digest and naming output are untrusted: the model has no tools, and wrapper-tag occurrences in repo text are neutralized.
- Map endpoints sit behind the console auth gate; writes are same-origin only.

## Tests

`npm run test:codemap-ui` (Playwright, `test/codemap-ui.ts`). The `codemap-*.ts` node tests run in `npm test`.
