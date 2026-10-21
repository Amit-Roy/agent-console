## What
- Fixed PNG file preview not showing in the Read/file viewer
- Removed `O_NONBLOCK` flag from `openScoped` in `server/files.ts`

## Why
- `O_NONBLOCK` flag could cause `handle.read()` to return fewer bytes than requested
- `imageType()` requires at least 8 bytes to detect PNG

## How
- Removed `O_NONBLOCK` from `fs.open()` call in `openScoped` (line 96)

## Architecture before
- ![Architecture before](<https://raw.githubusercontent.com/Amit-Roy/agent-console/issue-14-read-should-show-an-online-file-preview-5b55c39e/pr-arch/output/before.png>)

## Architecture after
- ![Architecture after](<https://raw.githubusercontent.com/Amit-Roy/agent-console/issue-14-read-should-show-an-online-file-preview-5b55c39e/pr-arch/output/after.png>)

## Screenshot evidence
- Evidence type: static
- ![Screenshot](<https://raw.githubusercontent.com/Amit-Roy/agent-console/issue-14-read-should-show-an-online-file-preview-5b55c39e/pr-arch/output/after.png>)

## Self-review
- **What was checked**: Reviewed the `openScoped` function in `server/files.ts` and identified that the `O_NONBLOCK` flag could cause unreliable file reads, preventing PNG signature detection.
- **What was fixed**: Removed the `O_NONBLOCK` flag from the `fs.open()` call in `openScoped`.
- **Test that failed first**: PNG file preview in the Read/file viewer — PNG files were not displayed as images because the `imageType()` function could not detect the PNG signature when `handle.read()` returned fewer than 8 bytes due to the `O_NONBLOCK` flag.
