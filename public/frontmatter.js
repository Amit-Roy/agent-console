/** Split YAML frontmatter (--- ... ---) from markdown source. Returns { meta, body }; meta is the raw block or null. */
export function splitFrontmatter(src) {
  const lines = src.split(/\r?\n/);
  if (!/^---\s*$/.test(lines[0])) return { meta: null, body: src };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^(---|\.\.\.)\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end === -1) return { meta: null, body: src };
  const meta = lines.slice(1, end).join("\n");
  // Only treat as frontmatter when the block looks like key: value lines or is empty.
  if (meta && !/^[^\S\r\n]*[a-zA-Z_]+\s*:/m.test(meta)) return { meta: null, body: src };
  return { meta, body: lines.slice(end + 1).join("\n") };
}

const cell = (s) => s.replace(/\|/g, "\\|");
const unquote = (s) => s.trim().replace(/^(["'])(.*)\1$/, "$2");

/** Markdown source with its frontmatter shown as a Field/Value table above the body (GitHub style). */
export function frontmatterToMarkdown(src) {
  if (!src) return src;
  const { meta, body } = splitFrontmatter(src);
  if (!meta) return body;
  const rows = [];
  for (const line of meta.split("\n")) {
    const m = /^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (m) rows.push([m[1], unquote(m[2])]);
    else if (rows.length && line.trim()) {
      const item = unquote(line.trim().replace(/^-\s+/, ""));
      const last = rows[rows.length - 1];
      last[1] = last[1] ? `${last[1]}, ${item}` : item;
    }
  }
  if (!rows.length) return body;
  const table = [
    "| Field | Value |",
    "| --- | --- |",
    ...rows.map(([k, v]) => `| ${cell(k)} | ${cell(v)} |`),
  ];
  return `${table.join("\n")}\n\n${body}`;
}
