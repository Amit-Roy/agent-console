# Thread naming

## Inputs and previous behavior

An unnamed thread starts with its working folder's basename. After each substantive user prompt, `Threads.retitle` reads the thread's user messages from its event log. `titleText` removes media references and collapses whitespace. `titleInput` retains up to 100,000 characters, prioritizing newer messages and returning them oldest first. The naming model receives those messages, without repository paths, timestamps, assistant responses, or tool output. Later messages should determine the current subject.

The previous prompt was:

> Write a title of 2 to 4 words, at most 30 characters, for a chat from its user messages below, oldest first. Later messages matter more: name what the chat is about now. Reply with ONLY the title: no quotes, no trailing punctuation, no explanation.

It appended `Messages:` and a bullet for each cleaned message. The validator accepted unstructured text, retained up to five words, and removed trailing words until the result fit 30 characters. A separate issue-title generator reserved at least eight description characters, even when the repository and issue prefix consumed the remaining budget.

## Revised behavior

`server/providers/title.ts` asks for `Topic:feat`, where Topic identifies the subject and feat describes the feature or task. It requests at most three words total, an eight-character topic, and 20 characters including the colon. For example, `Auth:fix redirect` identifies both the subject and task. The prompt derives its limits from the validator's constants.

The validator requires a nonempty topic and feature separated by one colon. It strips a model's `Title:` or `Name:` wrapper only when another colon follows, preserving legitimate topics such as `Title:rename chats`. It reserves room for a feature, retains at most two feature words, drops complete trailing words, and clips an oversized single word without splitting surrogate pairs. Malformed replies return `undefined`, allowing the existing small-model fallback chain to try another engine. A failed naming attempt retains the current thread name.

Both automatic titles and deterministic issue titles use `fitTitle`. It enforces 20 UTF-16 code units and a conservative 174px width budget. The checked-in `title-metrics.json` records advances generated from the bundled Inter WOFF2 font with Fontkit; default glyph advances at 14px receive a 5% margin for the selected row's medium weight. Glyphs absent from the bundled font reserve 28px each for fallback rendering. This uses existing font data rather than a hand-maintained glyph-width table. Fontkit is a development dependency; naming requires no new runtime package. Run `npm run title-metrics` after changing the bundled font. The title regression suite runs the generator with `--check` to reject stale metrics.

Issue titles retain `<repo>:<issue number> <description>`. Long repository labels shrink by code point until the prefix leaves room for a short description in both budgets. The issue number remains intact. `MAX_TITLE` and the fitter are imported from the naming module; no duplicate `MAX_THREAD_TITLE` remains.

Manually supplied and manually renamed titles remain locked. Existing unlocked conversations receive the revised title after another substantive user message; this change does not bulk-rename saved conversations.

## Display measurements

Chromium measurements used the actual application, loaded fonts, selected rows, the running indicator, and the row action button. At a 412×915 viewport, the sidebar is 320px wide and the title receives 228px while idle or 220px while running. At a 1280×915 viewport, the sidebar is 264px wide and the title receives 188px while idle or 180px while running. The 174px budget leaves 6px below the narrower measured row.

The baseline `Improve thread naming prompt` clips on desktop. A character cap alone also fails: `WWW:WWWWWWWWWWWWWWWW` needs about 267px, and the 17-character `线程:修复标题显示布局过长溢出问题` needs about 227px. The revised validator shortens these to `WWW:WWWWWWWW` and `线程:修复标题`, respectively. PR #98 contains the baseline and final application screenshots and the architecture diagrams.

## Regression matrix

`test/thread-titles.ts` asserts the following model-reply transformations and the 20-character cap. `test/mobile-ui.ts` measures generated titles in idle/running selected rows on Android and desktop. `test/window-dispatch.ts` covers long repository/issue prefixes and empty descriptions.

| Model reply | Expected title | UTF-16 length |
| --- | --- | ---: |
| Auth:fix redirect | Auth:fix redirect | 17 |
| Chat:image paste | Chat:image paste | 16 |
| UI:dark mode | UI:dark mode | 12 |
| Mobile:keyboard focus | Mobile:keyboard | 15 |
| Build:cache assets | Build:cache assets | 18 |
| Tests:flaky login | Tests:flaky login | 17 |
| Search:index logs | Search:index logs | 17 |
| Costs:show usage | Costs:show usage | 16 |
| Threads:rename chats | Threads:rename chats | 20 |
| Android:sidebar width | Android:sidebar | 15 |
| Notifications:push alerts | Notifica:push alerts | 20 |
| 資料:検索を修正 | 資料:検索を修 | 7 |
