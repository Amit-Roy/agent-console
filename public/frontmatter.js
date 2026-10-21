/** Strip YAML frontmatter (--- ... ---) from markdown source. Returns content string with frontmatter removed. */
export function stripFrontmatter(src) {
  if (!src) return src;
  const lines = src.split(/\r?\n/);
  if (!/^---\s*$/.test(lines[0])) return src;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^(---|\.\.\.)\s*$/.test(lines[i])) { end = i; break; }
  }
  if (end === -1) return src;
  const body = lines.slice(1, end).join('\n');
  // Only strip when body looks like frontmatter (key: value lines) or is empty.
  if (body && !/^[^\S\r\n]*[a-zA-Z_]+\s*:/m.test(body)) return src;
  return lines.slice(end + 1).join('\n');
}