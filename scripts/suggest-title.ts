import "../server/privacy.ts";
import { suggestTitle } from "../server/providers/title.ts";

// Prints a short label-helper title for the prompt on stdin; prints nothing when none is available.
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const title = await suggestTitle(Buffer.concat(chunks).toString("utf8"));
if (title) console.log(title);
process.exit(0);
