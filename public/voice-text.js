// Pure text helpers for voice (no DOM, no imports) so Node tests can load them.

const NUMBER_WORDS = [
  ["one", "first", "1st", "1"],
  ["two", "second", "2nd", "2"],
  ["three", "third", "3rd", "3"],
  ["four", "fourth", "4th", "4"],
  ["five", "fifth", "5th", "5"],
];

const normalize = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

function ordinalIndex(spoken, count) {
  const words = spoken.replace(/^(option|number|choice|answer)\s+/, "").split(" ");
  if (words.length > 2) return -1;
  const found = NUMBER_WORDS.findIndex((names) => names.includes(words[0]));
  return found >= 0 && found < count && words.length === 1 ? found : -1;
}

// Which option labels did the speaker choose? Exact label, a label inside the sentence, or "one" / "the second".
export function matchOptions(transcript, labels) {
  const spoken = normalize(transcript).replace(/^(the|option)\s+/, "");
  if (!spoken) return [];
  const norm = labels.map(normalize);
  const exact = norm.indexOf(spoken);
  if (exact >= 0) return [labels[exact]];
  const ordinal = ordinalIndex(spoken, labels.length);
  if (ordinal >= 0) return [labels[ordinal]];
  const padded = ` ${spoken} `;
  return labels.filter((_, index) => norm[index] && padded.includes(` ${norm[index]} `));
}

function stripMarkdown(block) {
  return block
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function splitSentences(text) {
  return (text.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) || [])
    .map((part) => part.trim())
    .filter(Boolean);
}

// First paragraph of a reply, without code blocks and tables, at most 280 characters, cut at a sentence end.
export function tldr(text, limit = 280) {
  const plain = String(text || "").replace(/```[\s\S]*?(```|$)/g, "\n\n");
  const paragraphs = plain.split(/\n\s*\n/).filter((block) => {
    const lines = block.trim().split("\n");
    return block.trim() && !lines.some((line) => /^\s*\|/.test(line));
  });
  const first = stripMarkdown(paragraphs[0] || "");
  if (first.length <= limit) return first;
  const kept = [];
  let used = 0;
  for (const sentence of splitSentences(first)) {
    if (used + sentence.length + 1 > limit) break;
    kept.push(sentence);
    used += sentence.length + 1;
  }
  return kept.length ? kept.join(" ") : `${first.slice(0, limit - 1).trimEnd()}…`;
}
