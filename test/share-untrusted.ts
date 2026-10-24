import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-untrusted-"));
process.env.AGENT_CONSOLE_DATA = path.join(root, "data");
const { adoptUpload, markUntrusted, removeUpload, resolveAttachments, withFileList, UPLOAD_DIR } =
  await import("../server/uploads.ts");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const THREAD = "11111111-1111-4111-8111-111111111111";
const stage = (name: string) => {
  const file = path.join(root, name);
  fs.writeFileSync(file, PNG);
  return file;
};

try {
  const shared = adoptUpload(THREAD, stage("slide-1.png"), "slide-1.png", 1 << 20);
  const plain = adoptUpload(THREAD, stage("plain.png"), "plain.png", 1 << 20);
  assert.equal(shared.kind, "image");
  markUntrusted(THREAD, shared.id);

  // a client cannot flip the flag: extra fields in the send payload are ignored
  const [sharedItem, plainItem] = resolveAttachments(THREAD, [
    { id: shared.id, n: 1 },
    { id: plain.id, n: 2, untrusted: true },
  ]);
  assert.equal(sharedItem.kind, "file", "untrusted image is never an image attachment");
  assert.equal(sharedItem.untrusted, true);
  assert.equal(sharedItem.n, undefined);
  assert.equal(plainItem.kind, "image", "ordinary uploads still inline");
  assert.equal(plainItem.untrusted, undefined);

  // the seam both providers use: only kind === "image" becomes a vision block
  assert.deepEqual(
    [sharedItem].filter((item) => item.kind === "image"),
    [],
    "no vision block for the share attachment",
  );
  const prompt = withFileList("analyze", [sharedItem]);
  assert.match(prompt, /\[Attached files, saved on this machine\./);
  assert.ok(prompt.includes(`- ${sharedItem.path} (`), "absolute path listed");
  assert.ok(!/Images attached/.test(prompt), "no image label block");
  assert.ok(path.isAbsolute(sharedItem.path));
  assert.match(withFileList("x", [plainItem]), /Images attached/);

  removeUpload(THREAD, shared.id);
  assert.ok(!fs.existsSync(path.join(UPLOAD_DIR, THREAD, `${shared.id}.untrusted`)));
  console.log("share-untrusted ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
