const fs = require('fs');
const path = require('path');

const cssString = fs.readFileSync(path.join(__dirname, 'src', 'design-system.css'), 'utf8');
const tokens = JSON.parse(fs.readFileSync(path.join(__dirname, 'src', 'tokens.json'), 'utf8'));

module.exports = { tokens, cssString };
module.exports.default = { tokens, cssString };