// prompt overhead: byte accounting of instruction files, imports, skills and agents from a temp HOME; never reads the real home or leaks file text.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SENTINEL = "SENTINEL-7f3a9c-do-not-leak";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-overhead-"));
fs.writeFileSync(path.join(root, "style.md"), `# Style\n${SENTINEL}\n`);
fs.mkdirSync(path.join(root, "bin"));
fs.writeFileSync(path.join(root, "bin", "brain"), "#!/bin/sh\n", { mode: 0o755 });
process.env.AGENT_CONSOLE_STYLE = path.join(root, "style.md");
process.env.AGENT_CONSOLE_BRAIN = path.join(root, "bin", "brain");
delete process.env.CLAUDE_CONFIG_DIR;
const { promptOverhead } = await import("../server/prompt-overhead.ts");

const put = (file: string, body: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); return file; };
let n = 0;
const newHome = () => { const h = path.join(root, `home${n++}`); fs.mkdirSync(path.join(h, "repos"), { recursive: true }); return h; };
const claude = (r: Awaited<ReturnType<typeof promptOverhead>>) => r.providers.find(p => p.id === "claude")!;
const skills = (r: Awaited<ReturnType<typeof promptOverhead>>) => claude(r).sources.find(s => s.kind === "skills");
const skill = (home: string, dir: string, name: string, extra = "") => put(path.join(home, ".claude", "skills", dir, "SKILL.md"), `---\nname: ${name}\ndescription: Does ${name} things ${SENTINEL}\n${extra}---\nbody ${SENTINEL}\n`);

try {
  // imports: nested resolution, ~/ and relative paths, cycle guard, code spans ignored
  const h1 = newHome();
  put(path.join(h1, ".claude", "CLAUDE.md"), `# User\n${SENTINEL}\n@a.md\n\`@ignored.md\`\nmail me@example.com\n`);
  put(path.join(h1, ".claude", "a.md"), `see @~/b.md\n${SENTINEL}\n`);
  put(path.join(h1, "b.md"), `back to @.claude/a.md and @.claude/CLAUDE.md\n${SENTINEL}\n`);
  put(path.join(h1, ".claude", "ignored.md"), "should not load");
  const r1 = await promptOverhead({ home: h1 });
  const c1 = claude(r1);
  const loaded = c1.sources.filter(s => s.kind === "instructions" || s.kind === "import").map(s => path.basename(s.path!) + (s.missing ? "?" : ""));
  assert.deepEqual(loaded, ["CLAUDE.md", "a.md", "b.md", "CLAUDE.md?"], `import chain: ${loaded}`);
  assert.ok(!c1.sources.some(s => s.path?.endsWith("ignored.md")), "inline code spans are not imports");
  assert.ok(r1.skipped.some(s => s.reason === "cycle" && s.path.endsWith("a.md")), "cycle recorded");
  assert.equal(c1.totalBytes, c1.sources.reduce((t, s) => t + s.bytes, 0));
  assert.equal(c1.tokensEst, Math.ceil(c1.totalBytes / 4));
  console.log("PASS  overhead: @-imports resolve recursively, cycles stop");

  // skipped: secret and outside-home imports
  const h2 = newHome(), outside = path.join(root, "outside.md");
  put(outside, `outside ${SENTINEL}`);
  put(path.join(h2, ".env"), `KEY=${SENTINEL}`); put(path.join(h2, "auth.json"), `{"t":"${SENTINEL}"}`);
  put(path.join(h2, ".claude", "CLAUDE.md"), `@~/.env\n@~/auth.json\n@${outside}\n@/etc/hostname\n`);
  const r2 = await promptOverhead({ home: h2 });
  const reasons = Object.fromEntries(r2.skipped.map(s => [path.basename(s.path), s.reason]));
  assert.equal(reasons[".env"], "sensitive"); assert.equal(reasons["auth.json"], "sensitive"); assert.equal(reasons["outside.md"], "outside-home");
  assert.ok(!claude(r2).sources.some(s => s.kind === "import"), "nothing imported");
  console.log("PASS  overhead: secret and outside-home imports are skipped");

  // symlink to a secret is caught by its real target
  const h3 = newHome();
  put(path.join(h3, "creds", ".env"), SENTINEL); fs.symlinkSync(path.join(h3, "creds", ".env"), path.join(h3, "friendly.md"));
  put(path.join(h3, ".claude", "CLAUDE.md"), "@~/friendly.md\n");
  const r3 = await promptOverhead({ home: h3 });
  assert.ok(r3.skipped.some(s => s.path.endsWith("friendly.md") && s.reason === "sensitive"));
  console.log("PASS  overhead: symlinked secret skipped");

  // skills: overrides and disable-model-invocation hide; dedupe by realpath across dirs
  const h4 = newHome();
  skill(h4, "shown", "shown"); skill(h4, "off", "off"); skill(h4, "inv", "inv"); skill(h4, "manual", "manual", "disable-model-invocation: true\n");
  put(path.join(h4, ".claude", "settings.json"), JSON.stringify({ skillOverrides: { off: "off", inv: "user-invocable-only", shown: "on" } }));
  fs.mkdirSync(path.join(h4, ".agents"), { recursive: true });
  fs.symlinkSync(path.join(h4, ".claude", "skills"), path.join(h4, ".agents", "skills"));
  const s4 = skills(await promptOverhead({ home: h4 }))!;
  assert.equal(s4.count, 1); assert.equal(s4.hidden, 3);
  assert.deepEqual(s4.items!.map(i => i.name), ["shown"]);
  assert.equal(s4.bytes, "shown".length + `Does shown things ${SENTINEL}`.length);
  console.log("PASS  overhead: skillOverrides and disable-model-invocation hide skills, same realpath counted once");

  // duplicates: same section in two loaded files, whole-file duplicates
  const h5 = newHome(), section = "## Always\n- obey the rules of the house at all times\n";
  put(path.join(h5, ".claude", "CLAUDE.md"), `# Global\n${section}## Unique\nonly here ${SENTINEL}\n`);
  put(path.join(h5, "repos", "CLAUDE.md"), `# Repos\n\n${section}`);
  const r5 = await promptOverhead({ home: h5 });
  const dup = r5.duplicates.find(d => d.provider === "claude" && d.heading === "Always")!;
  assert.ok(dup && dup.sources.length === 2 && dup.bytes > 20, "duplicate section reported");
  const src = claude(r5).sources.find(s => s.id === dup.sources[0])!;
  assert.deepEqual(src.dupSections[0].alsoIn, [dup.sources[1]]);
  assert.ok(!r5.duplicates.some(d => d.heading === "Unique"));
  put(path.join(h5, "x", "CLAUDE.md"), `# Global\n${section}## Unique\nonly here ${SENTINEL}\n`);
  const r5b = await promptOverhead({ home: h5, cwd: path.join(h5, "x") });
  const projectSrc = claude(r5b).sources.find(s => s.label === "Project CLAUDE.md")!;
  assert.equal(projectSrc.dupOf, claude(r5b).sources.find(s => s.label === "User CLAUDE.md")!.id, "identical file flagged dupOf");
  console.log("PASS  overhead: duplicate sections and identical files flagged");

  // agents, codex toml, missing files, cache
  const h6 = newHome();
  put(path.join(h6, ".claude", "agents", "r.md"), `---\nname: reviewer\ndescription: reviews ${SENTINEL}\n---\n${SENTINEL}`);
  put(path.join(h6, ".codex", "agents", "w.toml"), `name = "worker"\ndescription = "works ${SENTINEL}"\ndeveloper_instructions = """${SENTINEL}"""\n`);
  const r6 = await promptOverhead({ home: h6 });
  assert.equal(claude(r6).sources.find(s => s.kind === "agents")!.bytes, "reviewer".length + `reviews ${SENTINEL}`.length);
  assert.equal(r6.providers.find(p => p.id === "codex")!.sources.find(s => s.kind === "agents")!.bytes, "worker".length + `works ${SENTINEL}`.length);
  assert.ok(claude(r6).sources.find(s => s.kind === "instructions")!.missing, "absent CLAUDE.md reported missing");
  assert.ok(!r6.providers.some(p => p.id === "claude:nefro"), "no nefro column without its config dir");
  fs.mkdirSync(path.join(h6, ".claude-nefro")); put(path.join(h6, ".claude-nefro", "CLAUDE.md"), "nefro\n");
  assert.ok((await promptOverhead({ home: h6 })).providers.some(p => p.id === "claude:nefro"), "nefro column appears with its dir");
  assert.equal(await promptOverhead({ home: h6 }), await promptOverhead({ home: h6 }), "cached");
  const r6b = await promptOverhead({ home: h6 });
  assert.equal(r6b.providers.find(p => p.id === "claude")!.label, "Claude", "differing nefro setup keeps both columns");

  // identical setups (nefro files symlinked into ~/.claude) collapse into one column naming both accounts
  const h7 = newHome();
  put(path.join(h7, ".claude", "CLAUDE.md"), "shared\n"); put(path.join(h7, ".claude", "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\n"); fs.mkdirSync(path.join(h7, ".claude", "agents"));
  fs.mkdirSync(path.join(h7, ".claude-nefro"));
  for (const f of ["CLAUDE.md", "skills", "agents"]) fs.symlinkSync(path.join(h7, ".claude", f), path.join(h7, ".claude-nefro", f));
  const r7 = await promptOverhead({ home: h7 });
  assert.deepEqual(r7.providers.map(p => p.id), ["claude", "codex", "pi"], "no second Claude column when identical");
  assert.equal(claude(r7).label, "Claude (both accounts)");
  fs.rmSync(path.join(h7, ".claude-nefro", "CLAUDE.md")); put(path.join(h7, ".claude-nefro", "CLAUDE.md"), "own\n");
  const r7b = await promptOverhead({ home: h7 });
  assert.deepEqual(r7b.providers.map(p => p.id), ["claude", "claude:nefro", "codex", "pi"], "second column when instructions differ");
  assert.equal(claude(r7b).label, "Claude");
  console.log("PASS  overhead: agents, codex toml, missing files, nefro column, cache");

  // the sentinel is planted in every seeded file above and must never reach a result
  const all = JSON.stringify([r1, r2, r3, r5, r5b, r6, s4]);
  assert.ok(!all.includes(SENTINEL), "file text never appears in results");
  assert.ok(!all.includes("should not load"));
  console.log("PASS  overhead: no file text in results");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
