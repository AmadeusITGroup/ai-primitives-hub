import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  fillTemplate,
  TEMPLATES,
} from '../../../src/security/rating/security-rating-templates';

describe('fillTemplate', () => {
  it('escapes a slot as a table cell by default', () => {
    expect(fillTemplate('| {{name}} |', { name: 'a|b\nc' })).toBe(String.raw`| a\|b c |`);
  });

  it('escapes a slot as HTML text with the html filter', () => {
    expect(fillTemplate('<code>{{name|html}}</code>', { name: '<img src=x> & y' })).toBe('<code>&lt;img src=x&gt; &amp; y</code>');
  });

  it('inserts a slot as is with the raw filter', () => {
    expect(fillTemplate('{{name|raw}}', { name: '**bold** | x' })).toBe('**bold** | x');
  });

  it('does not expand slots found inside a value', () => {
    expect(fillTemplate('{{a|raw}} {{b|raw}}', { a: '{{b}}', b: 'x' })).toBe('{{b}} x');
  });

  it('fails on a slot without a value instead of dropping it', () => {
    expect(() => fillTemplate('{{missing}}', {})).toThrow('Template slot "missing" has no value');
    expect(() => fillTemplate('{{toString}}', {})).toThrow('has no value');
  });

  it('fills every slot of the report templates it is given values for', () => {
    expect(fillTemplate(TEMPLATES.findingRow, { points: '20', ruleId: 'A-1', title: 'T', where: 'a.md:3', fix: 'F' }))
      .toBe('| -20 | `A-1` T | `a.md:3` | F |');
  });
});
