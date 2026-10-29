## What
- Auto-resume premium model threads when a provider's usage window resets, excluding archived chats
- Added `quotaPaused` field on Thread to track quota-exhausted threads
- Added `resumeQuotaPaused()` method to resume non-archived quota-paused threads
- Added `subscribeWindowReset()` callback in usage module to detect window resets
- Connected window reset detection to thread resumption in index.ts

## Why
- When a premium model hits quota exhaustion, the agent turn fails and users must manually continue
- Threads should automatically resume when the usage window reopens
- Archived chats must not be auto-resumed
- Duplicate/delayed window-open notifications must be handled gracefully

## How
- `threads.ts`: Thread marks `quotaPaused` when turn ends with rate limit error and quota is exhausted
- `threads.ts`: `resumeQuotaPaused(provider, windowLabel)` sends "Continue." to non-archived paused threads
- `usage.ts`: `subscribeWindowReset()` callback triggers when `record()` detects a window transitioning from exhausted (used >= limit) to not exhausted (used < limit)
- `index.ts`: Subscribes to window reset events and calls `threads.resumeQuotaPaused(provider, windowLabel)`
- `quotaPaused` is cleared after resumption, preventing duplicate resumes from repeated notifications
- Test first: `test/quota-resumption.ts` failed before the change (quotaPaused field didn't exist), now passes with 8 tests

## Architecture before
- ![Architecture before](https://raw.githubusercontent.com/example-owner/agent-console/issue-72-premium-models-across-providers-should-a-67d8b047/arch-evidence/output/before.png)

## Architecture after
- ![Architecture after](https://raw.githubusercontent.com/example-owner/agent-console/issue-72-premium-models-across-providers-should-a-67d8b047/arch-evidence/output/after.png)

## Screenshot evidence
- Evidence type: static
- Terminal validation: all 8 quota-resumption tests pass, confirming quota-pause marking, archived exclusion, resumption on window reset, duplicate handling, and multi-provider isolation
- ![Test output](https://raw.githubusercontent.com/example-owner/agent-console/issue-72-premium-models-across-providers-should-a-67d8b047/arch-evidence/test-output.png)

## Self-review
- Checked: quotaPaused field added to Thread interface, resumeQuotaPaused skips archived threads, usage module detects window resets, index.ts subscribes to reset notifications, duplicate notifications handled by clearing quotaPaused after first resume
- Fixed: Added `quota-resume` to the `auto` option type in the `send` method signature
- Test that failed first: `test/quota-resumption.ts` — failed at assertion "Thread should be marked as quota-paused" because `quotaPaused` field did not exist

- A Sonnet or Sol review must approve before merge.