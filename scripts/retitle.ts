// One-off backfill: give threads that still carry their folder-name title a real one, from their first substantial message.
// Goes through the running server's websocket `update` (like the Rename menu), so the server stays the only writer of threads.json.
//   node scripts/retitle.ts            apply
//   node scripts/retitle.ts --dry      only print what would change
import path from "node:path";
import { WebSocket } from "ws";
import { makeToken } from "../server/auth.ts";
import { suggestTitle } from "../server/providers/title.ts";

const BASE = process.env.BASE || "http://127.0.0.1:7070";
const dry = process.argv.includes("--dry");
const ws = new WebSocket(BASE.replace("http", "ws") + "/ws", {
  headers: { cookie: `__Host-ac_session=${makeToken()}`, origin: BASE },
});
const inbox: any[] = [];
ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
await new Promise<void>((res, rej) => {
  ws.on("open", () => res());
  ws.on("error", rej);
});
const waitFor = async (pred: (m: any) => boolean, ms = 10_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const m = inbox.find(pred);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
};

const hello = await waitFor((m) => m.t === "hello");
if (!hello) throw new Error("No hello from the server.");
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

for (const t of hello.threads as any[]) {
  const label = `${t.id.slice(0, 8)} [${t.provider}]`;
  if (t.title !== path.basename(t.cwd)) {
    console.log(`skip   ${label} already named "${t.title}"`);
    continue;
  }
  inbox.length = 0;
  ws.send(JSON.stringify({ t: "open", thread: t.id }));
  const hist = await waitFor((m) => m.t === "history" && m.thread === t.id);
  const first = (hist?.events ?? []).find(
    (e: any) => e.type === "user_input" && !e.auto && words(e.text ?? "") >= 3,
  );
  if (!first) {
    console.log(`skip   ${label} no substantial first message`);
    continue;
  }
  const title = await suggestTitle(first.text);
  if (!title) {
    console.log(
      `skip   ${label} no title produced for: ${first.text.slice(0, 60).replace(/\s+/g, " ")}`,
    );
    continue;
  }
  console.log(
    `${dry ? "would " : "rename"} ${label} "${t.title}" -> "${title}"   (${first.text.slice(0, 60).replace(/\s+/g, " ")})`,
  );
  if (!dry) ws.send(JSON.stringify({ t: "update", thread: t.id, title }));
}
await new Promise((r) => setTimeout(r, 300)); // let the last update flush before closing
ws.close();
