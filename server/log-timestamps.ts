// Import first in server/index.ts: stamps every stdout/stderr line (console.*, direct writes) before anything logs.
import { stampLines } from "./log-stamp.ts";

stampLines(process.stdout);
stampLines(process.stderr);
