/** Repos whose work is applied locally before it is pushed; everything else, and all trivial and BAU review work, goes through a PR. */
export const DIRECT_REPOS = ["agent-console", "dotfiles", "brain"];

/** A PR that touches any of these is never merged by an automated reviewer: the code or rules that run the automation itself. */
export const PROTECTED = ["server/window-dispatch.ts", "server/window-opener.ts", "server/issue-review.ts", "server/automation/", "skills/", "server/auth.ts", "server/threads.ts", "server/providers/", "scripts/auto-sandbox.py", "bin/", ".github/", "package.json"];
export const isProtected = (files: string[]) => files.some(f => PROTECTED.some(p => (p.endsWith("/") ? f.startsWith(p) : f === p)));
