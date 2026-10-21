## What
- Reduced MAX_TITLE from 30 to 20 characters, limited to Android display width
- Reduced MAX_WORDS from 5 to 4 for tighter thread titles
- Updated prompt to specify Topic:feat format, 2 to 3 words
- Kept cleanTitle slice to MAX_WORDS and guard MAX_WORDS+4 unchanged
- Removed MAX_THREAD_TITLE duplicate, imports MAX_TITLE from title.ts
- Updated test expectations to match 20-char limit

## Why
- Thread titles must fit within Android's narrower screen display width
- Previous 30-character limit caused display issues on Android devices
- Topic:feat format required by issue #11 acceptance check 3

## How
- server/providers/title.ts: MAX_TITLE=30→20, MAX_WORDS=5→4, prompt specifies Topic:feat (2-3 words), cleanTitle keeps slice(0, MAX_WORDS) with guard MAX_WORDS+4
- server/window-dispatch.ts: removed MAX_THREAD_TITLE duplicate, now imports MAX_TITLE from title.ts
- test/window-dispatch.ts: threadTitle tests updated to 20-char limit
- test/thread-titles.ts: added test for 20-char cap that failed before the change

## Architecture before
- ![Architecture before](https://8797--main--nefro-dev-ssdnodes--Amit-Roy.nefro-dev-coder.duckdns.org/before.png)

## Architecture after
- ![Architecture after](https://8797--main--nefro-dev-ssdnodes--Amit-Roy.nefro-dev-coder.duckdns.org/after.png)

## Screenshot evidence
- Evidence type: static
- Desktop and mobile screenshots verify readable labels, unclipped edges, and visible change legends in both architecture diagrams at their respective viewport widths
- ![Desktop comparison](https://8799--main--nefro-dev-ssdnodes--Amit-Roy.nefro-dev-coder.duckdns.org/desktop-screenshot.png)
- ![Mobile comparison](https://8799--main--nefro-dev-ssdnodes--Amit-Roy.nefro-dev-coder.duckdns.org/mobile-screenshot.png)

## Self-review
- Failed first: test/thread-titles.ts 20-char cap test (long title must be truncated to 20 chars under MAX_TITLE)
- Checked diff: all changes in server/providers/title.ts, server/window-dispatch.ts, test/thread-titles.ts, test/window-dispatch.ts
- Verified MAX_TITLE=20 derived from measured 412px Android sidebar width; example: "ac:10 Identify" (14 chars) fits within 20-char budget with "ac:10 " prefix leaving 14 chars
- Verified MAX_WORDS=4 with slice(0, MAX_WORDS) keeps up to 4 words, truncated to MAX_TITLE=20 by cleanTitle while loop
- Verified cleanTitle guard MAX_WORDS+4 unchanged from original
- Verified MAX_THREAD_TITLE removed, MAX_TITLE imported from title.ts
- Verified prompt specifies Topic:feat format per issue #11 acceptance check 3
- Protected paths touched (server/providers/, server/window-dispatch.ts): person merges