/**
 * Design system specification test
 * This test verifies that the design system specification document exists
 * and contains the required sections.
 */

const fs = require('fs');
const path = require('path');

describe('Design System Specification', () => {
  const docPath = path.join(__dirname, '..', 'docs', 'design-system.md');

  it('design-system.md should exist', () => {
    expect(fs.existsSync(docPath)).toBe(true);
  });

  it('design-system.md should contain tokens section', () => {
    const content = fs.readFileSync(docPath, 'utf8');
    expect(content).toContain('Tokens');
  });

  it('design-system.md should contain components section', () => {
    const content = fs.readFileSync(docPath, 'utf8');
    expect(content).toContain('Components');
  });

  it('design-system.md should contain usage guidelines section', () => {
    const content = fs.readFileSync(docPath, 'utf8');
    expect(content).toContain('Usage Guidelines');
  });
});