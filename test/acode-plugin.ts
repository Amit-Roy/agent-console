import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../acode-plugin/main.js", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../acode-plugin/plugin.json", import.meta.url), "utf8"));
assert.equal(manifest.minVersionCode, 1011); // Acode v1.13.5 config.xml.

type Event = { preventDefault(): void; respondWith?(value: Promise<boolean>): void };
const opened: MockFile[] = [];
class MockFile {
  filename: string;
  text: string;
  docVersion = 0;
  savedVersion = 0;
  isUnsaved = false;
  persistInSession = true;
  events: Record<string, (event: Event) => void> = {};
  session = {
    getValue: () => this.text,
    setValue: (text: string) => { this.text = text; this.docVersion++; this.isUnsaved = true; },
    doc: {},
  };
  constructor(filename: string, options: { text: string }) {
    this.filename = filename;
    this.text = options.text;
    opened.push(this);
  }
  on(event: string, callback: (event: Event) => void) { this.events[event] = callback; }
  makeActive() {}
  markSaved({ savedVersion = this.docVersion } = {}) {
    this.savedVersion = savedVersion;
    this.isUnsaved = this.docVersion !== savedVersion;
  }
  edit(text: string) { this.session.setValue(text); }
}

let init: () => void;
let handler: (event: { module: string; action: string; value: string; preventDefault(): void }) => void;
let remote = { token: "token-1", path: "/tmp/file with spaces.js", content: "initial", revision: "r1" };
let conflict = false;
let releaseWrite: (() => void) | undefined;
let gate: Promise<void> | undefined;
const calls: { url: string; options: any }[] = [];
const alerts: string[] = [];
const positions: number[][] = [];
vm.runInNewContext(source, {
  URL,
  fetch: async (url: string, options: any) => {
    calls.push({ url, options });
    if (url.endsWith("/exchange")) return { ok: true, json: async () => ({ ...remote }) };
    if (gate) await gate;
    return { ok: !conflict, status: conflict ? 409 : 200, json: async () => ({ revision: "r2" }) };
  },
  acode: {
    require: (name: string) => ({
      intent: { addHandler: (cb: typeof handler) => { handler = cb; }, removeHandler() {} },
      editorFile: MockFile,
      alert: (_title: string, message: string) => { alerts.push(message); },
    })[name],
    setPluginInit: (_id: string, callback: () => void) => { init = callback; },
    setPluginUnmount() {},
  },
  editorManager: { editor: { gotoLine: (...position: number[]) => positions.push(position) } },
});
init!();
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
async function launch() {
  let prevented = false;
  handler!({
    module: "agent-console", action: "edit",
    value: encodeURIComponent(JSON.stringify({ endpoint: "https://console.example", ticket: "test-ticket", line: 8, column: 5 })),
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, true);
  await settle();
}
function save(file: MockFile) {
  let response: Promise<boolean> | undefined;
  let prevented = false;
  file.events.save({ preventDefault() { prevented = true; }, respondWith(value) { response = value; } });
  assert.equal(prevented, true);
  assert.ok(response);
  return response;
}

await launch();
const file = opened[0];
assert.equal(file.text, "initial");
assert.equal(file.filename, "file with spaces.js");
assert.equal(file.persistInSession, false);
assert.deepEqual(positions[0], [8, 4]);
assert.equal(JSON.parse(calls[0].options.body).ticket, "test-ticket");
file.edit("edited");
assert.equal(await save(file), true);
assert.equal(file.isUnsaved, false);
const firstWrite = calls.find((call) => call.options.method === "PUT")!;
assert.equal(firstWrite.options.headers.Authorization, "Bearer token-1");
assert.deepEqual(JSON.parse(firstWrite.options.body), { content: "edited", revision: "r1" });

remote = { ...remote, token: "token-2", content: "external change", revision: "external-r" };
await launch();
assert.equal(opened.length, 1);
assert.equal(file.text, "external change");
assert.equal(file.isUnsaved, false);
file.edit("my unsaved edit");
remote = { ...remote, token: "token-3", content: "another external change", revision: "another-r" };
await launch();
assert.equal(file.text, "my unsaved edit");
assert.equal(file.isUnsaved, true);
conflict = true;
assert.equal(await save(file), false);
assert.equal(file.text, "my unsaved edit");
assert.equal(file.isUnsaved, true);
assert.match(alerts.at(-1)!, /changed on the server/);
const conflictWrite = calls.at(-1)!;
assert.equal(conflictWrite.options.headers.Authorization, "Bearer token-3");
assert.equal(JSON.parse(conflictWrite.options.body).revision, "external-r");

conflict = false;
gate = new Promise<void>((resolve) => { releaseWrite = resolve; });
const before = calls.length;
const save1 = save(file);
const save2 = save(file);
assert.equal(save1, save2);
assert.equal(calls.length, before + 1);
file.edit("new edit during save");
releaseWrite!();
assert.equal(await save1, true);
assert.equal(file.isUnsaved, true);
gate = undefined;
file.events.close({ preventDefault() {} });
await launch();
assert.equal(opened.length, 2);
assert.equal(opened[1].text, remote.content);
assert.equal(opened[1].isUnsaved, false);
// Released Acode 1.13.5 has preventDefault but no SaveFileEvent.respondWith.
opened[1].edit("legacy save event");
let legacyPrevented = false;
opened[1].events.save({ preventDefault() { legacyPrevented = true; } });
await settle();
assert.equal(legacyPrevented, true);
assert.equal(opened[1].isUnsaved, false);
console.log("Acode plugin passed: launch, save, conflict, single flight, refresh, navigation, reopen.");
