import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');

export const tokens = JSON.parse(read('./tokens.json'));
export const cssString = read('./design-system.css');
export default { tokens, cssString };
