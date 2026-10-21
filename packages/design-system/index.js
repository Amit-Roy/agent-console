import fs from 'fs';
import path from 'path';

const cssString = fs.readFileSync(path.join(__dirname, 'design-system.css'), 'utf8');
const tokens = JSON.parse(fs.readFileSync(path.join(__dirname, 'tokens.json'), 'utf8'));

export { tokens, cssString };
export default { tokens, cssString };