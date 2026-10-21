# App ideas

Open sidebar ⋯ → **App ideas** (`/ideas`). The page lists app ideas from a private
git repo, adds new ones, and opens each idea's feature file.

## Platform

Browser only: a page inside the Console PWA, not a separate Android APK. The PWA
already installs on Android and ChromeOS and already runs next to the git repo, so
there is no second login, no store build and no token on the phone. Commits happen
on the server, never in the browser.

## Repository

`~/repos/app-ideas` by default; `AGENT_CONSOLE_IDEAS` overrides it. The first idea
creates the folder and runs `git init` if needed. To back it up privately, add a
remote and set an upstream once (`git push -u origin main`). After that every add
is pushed too. A failed push keeps the local commit and the page says so.

`index.md` lists one idea per line, each linking to its feature file:

```markdown
# App ideas

One line per idea. Each links to its feature list.

- [Plant Pal](plant-pal.md) — Reminds me to water plants
```

Only list lines of the form `- [Name](slug.md) — one line` count as ideas. The
separator may be `—`, `–`, `-` or `:`. Other lines, such as headings and notes, are
kept as they are. Edit the repo by hand whenever you like.

`<slug>.md` holds the features. The slug is the name in lower case, with runs of
other characters turned into `-`. A new file starts as:

```markdown
# Plant Pal

Reminds me to water plants

## Features

_None yet. Edit plant-pal.md to add them._
```

## Adding

Name (up to 80 characters, no square brackets) and one line (up to 200). A name
whose slug is taken is refused. One commit, `Add idea: <name>`, holds `index.md`
and the new file. If the commit fails, both files are restored, so a half-added
idea is never left behind.

Endpoints require the Console login. `POST` also requires the same origin.

- `GET /api/ideas`: `{dir, ideas: [{slug, name, line}]}`
- `GET /api/ideas/<slug>`: `{slug, name, line, markdown}`
- `POST /api/ideas` `{name, line}`: `201 {idea, commit, pushed, pushError?}`, where `pushed` is `null` without an upstream
