// App ideas: a private git repo of markdown. index.md lists one idea per line, `- [Name](slug.md) — one line`, and each
// slug.md holds that app's features. Adding an idea writes both files in one commit, then pushes if the branch tracks a remote.
// Hand edits stay welcome: only list lines with a link to a root .md file count as ideas; every other line is left alone.

import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Idea = { slug: string; name: string; line: string };
export class IdeaError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENTRY = /^\s*[-*]\s+\[([^\]]+)\]\(([^)\s]+)\.md\)\s*(?:[—–:-]\s*(.*?))?\s*$/;
export const SECTIONS = ["Features", "Implementation", "Others"] as const;
export type Section = (typeof SECTIONS)[number];
const PLACEHOLDER = /^_None yet\..*_\s*$/;
const HEADER = "# App ideas\n\nOne line per idea. Each links to its feature list.\n\n";

export const slugify = (name: string) =>
  name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");

export function parseIndex(text: string): Idea[] {
  const out: Idea[] = [];
  for (const l of text.split("\n")) {
    const m = ENTRY.exec(l);
    if (m && SLUG.test(m[2])) out.push({ slug: m[2], name: m[1].trim(), line: m[3] ?? "" });
  }
  return out;
}

function field(v: unknown, what: string, max: number): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) throw new IdeaError(`Give the idea a ${what}.`);
  if (/[\r\n]/.test(s)) throw new IdeaError(`Keep the ${what} to one line.`);
  if (s.length > max) throw new IdeaError(`Keep the ${what} under ${max} characters.`);
  return s;
}

/** Put `- text` under `## section`, creating the heading in canonical order and dropping the "None yet" placeholder. */
export function addBullet(markdown: string, section: Section, text: string): string {
  const lines = markdown.replace(/\n+$/, "").split("\n");
  const heading = (l: string) => /^##\s/.test(l);
  const at = lines.findIndex((l) => l.trim() === `## ${section}`);
  if (at < 0) {
    const later = lines.findIndex((l) =>
      SECTIONS.slice(SECTIONS.indexOf(section) + 1).some((n) => l.trim() === `## ${n}`),
    );
    const block = [`## ${section}`, "", `- ${text}`, ""];
    if (later < 0) return `${[...lines, "", ...block.slice(0, -1)].join("\n")}\n`;
    return `${[...lines.slice(0, later), ...block, ...lines.slice(later)].join("\n")}\n`;
  }
  let end = lines.findIndex((l, i) => i > at && heading(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(at + 1, end).filter((l) => !PLACEHOLDER.test(l.trim()));
  while (body.length && !body[body.length - 1].trim()) body.pop();
  while (body.length && !body[0].trim()) body.shift();
  const next = [
    ...lines.slice(0, at + 1),
    "",
    ...body,
    `- ${text}`,
    ...(end < lines.length ? [""] : []),
    ...lines.slice(end),
  ];
  return `${next.join("\n")}\n`;
}

export class Ideas {
  dir: string;
  private chain: Promise<unknown> = Promise.resolve(); // adds run one at a time, so two never race on index.md

  constructor(opts: { dir?: string } = {}) {
    this.dir =
      opts.dir ?? process.env.AGENT_CONSOLE_IDEAS ?? path.join(os.homedir(), "repos", "app-ideas");
  }

  private get index() {
    return path.join(this.dir, "index.md");
  }
  private git(...args: string[]) {
    return execFileSync(
      "git",
      [
        "-C",
        this.dir,
        "-c",
        "user.name=Agent Console",
        "-c",
        "user.email=agent-console@localhost" /* fallback identity; GIT_AUTHOR_* in the environment wins */,
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  }

  list(): { dir: string; ideas: Idea[] } {
    let text = "";
    try {
      text = fs.readFileSync(this.index, "utf8");
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
    } // no index yet: no ideas
    return { dir: this.dir, ideas: parseIndex(text) };
  }

  read(slug: string): Idea & { markdown: string } {
    const idea = SLUG.test(slug) ? this.list().ideas.find((i) => i.slug === slug) : undefined;
    if (!idea) throw new IdeaError("No such idea.", 404);
    try {
      return { ...idea, markdown: fs.readFileSync(path.join(this.dir, `${slug}.md`), "utf8") };
    } catch {
      throw new IdeaError(`No feature file yet: ${slug}.md is missing.`, 404);
    }
  }

  add(input: {
    name?: unknown;
    line?: unknown;
  }): Promise<{ idea: Idea; commit: string; pushed: boolean | null; pushError?: string }> {
    const run = this.chain.then(() => this.addNow(input));
    this.chain = run.catch(() => {});
    return run;
  }

  private async addNow(input: { name?: unknown; line?: unknown }) {
    const name = field(input.name, "name", 80);
    const line = field(input.line, "one-line description", 200);
    if (/[[\]]/.test(name)) throw new IdeaError("Leave square brackets out of the name.");
    const slug = slugify(name);
    if (!slug) throw new IdeaError("The name needs at least one Latin letter or digit.");
    const file = path.join(this.dir, `${slug}.md`);
    if (this.list().ideas.some((i) => i.slug === slug) || fs.existsSync(file))
      throw new IdeaError(`An idea named “${name}” already exists.`, 409);

    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(path.join(this.dir, ".git"))) this.git("init", "-q");
    const before = fs.existsSync(this.index) ? fs.readFileSync(this.index, "utf8") : null;
    const base =
      before === null ? HEADER : before && !before.endsWith("\n") ? `${before}\n` : before;
    const idea = { slug, name, line };
    try {
      fs.writeFileSync(
        file,
        `# ${name}\n\n${line}\n\n${SECTIONS.map((n) => `## ${n}\n\n_None yet. Edit ${slug}.md to add them._\n`).join("\n")}`,
        { flag: "wx" },
      );
      fs.writeFileSync(this.index, `${base}- [${name}](${slug}.md) — ${line}\n`);
      this.git("add", "--", "index.md", `${slug}.md`);
      this.git("commit", "-q", "-m", `Add idea: ${name}`, "--", "index.md", `${slug}.md`);
    } catch (e: any) {
      // Undo both files so a failed commit never leaves a half-added idea for the next one to sweep up.
      try {
        this.git("reset", "-q", "--", "index.md", `${slug}.md`);
      } catch {} // nothing staged yet; the files below are what matter
      fs.rmSync(file, { force: true });
      if (before === null) fs.rmSync(this.index, { force: true });
      else fs.writeFileSync(this.index, before);
      throw new IdeaError(
        `Could not commit the idea: ${
          String(e?.stderr || e?.message || e)
            .trim()
            .split("\n")[0]
        }`,
        500,
      );
    }
    return { idea, ...(await this.publish()) };
  }

  addBullet(
    slug: string,
    input: { section?: unknown; text?: unknown },
  ): Promise<{ commit: string; pushed: boolean | null; pushError?: string }> {
    const run = this.chain.then(() => this.addBulletNow(slug, input));
    this.chain = run.catch(() => {});
    return run;
  }

  private async addBulletNow(slug: string, input: { section?: unknown; text?: unknown }) {
    const idea = this.read(slug);
    const section = SECTIONS.find((n) => n === input.section);
    if (!section) throw new IdeaError(`Pick a section: ${SECTIONS.join(", ")}.`);
    const text = field(input.text, "bullet", 300);
    const file = path.join(this.dir, `${slug}.md`);
    try {
      fs.writeFileSync(file, addBullet(idea.markdown, section, text));
      this.git("add", "--", `${slug}.md`);
      this.git(
        "commit",
        "-q",
        "-m",
        `Add ${section.toLowerCase()} bullet: ${idea.name}`,
        "--",
        `${slug}.md`,
      );
    } catch (e: any) {
      try {
        this.git("reset", "-q", "--", `${slug}.md`);
      } catch {} // nothing staged yet; restoring the file is what matters
      fs.writeFileSync(file, idea.markdown);
      throw new IdeaError(
        `Could not commit the bullet: ${
          String(e?.stderr || e?.message || e)
            .trim()
            .split("\n")[0]
        }`,
        500,
      );
    }
    return this.publish();
  }

  /** After a commit: report its hash, then push if the branch tracks a remote. */
  private async publish(): Promise<{ commit: string; pushed: boolean | null; pushError?: string }> {
    const commit = this.git("rev-parse", "--short", "HEAD");
    let upstream = "";
    try {
      upstream = this.git("rev-parse", "--abbrev-ref", "@{u}");
    } catch {} // no upstream: commit only
    if (!upstream) return { commit, pushed: null };
    const pushError = await new Promise<string | undefined>((resolve) =>
      execFile(
        "git",
        ["-C", this.dir, "push", "-q"],
        { timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
        (err, _out, stderr) =>
          resolve(
            err
              ? (String(stderr).trim().split("\n")[0] || "push failed").replace(
                  /\/\/[^@/\s]+@/g,
                  "//",
                ) /* never echo URL credentials */
              : undefined,
          ),
      ),
    );
    return pushError ? { commit, pushed: false, pushError } : { commit, pushed: true };
  }
}
