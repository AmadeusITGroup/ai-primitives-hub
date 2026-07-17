/**
 * Tests for `framework/table.ts`.
 *
 * `renderTable` produces fixed-width, newline-terminated text tables from
 * column definitions and row data.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  renderTable,
} from '../../src/framework';

interface Row {
  name: string;
  count: number;
}

describe('renderTable', () => {
  it('renders a fixed-width table with headers and rows', () => {
    const out = renderTable<Row>({
      columns: [
        { header: 'Name', get: (r) => r.name },
        { header: 'Count', get: (r) => String(r.count), align: 'right' }
      ],
      rows: [
        { name: 'prompts', count: 3 },
        { name: 'skills', count: 42 }
      ]
    });
    const lines = out.split('\n').filter((line) => line.length > 0);
    expect(lines[0]).toContain('Name');
    expect(lines[1]).toContain('prompts');
    expect(lines[2]).toContain('42');
  });

  it('honors fixed column widths', () => {
    const out = renderTable<Row>({
      columns: [
        { header: 'Name', get: (r) => r.name, width: 12 },
        { header: 'Count', get: (r) => String(r.count), width: 5 }
      ],
      rows: [{ name: 'x', count: 1 }]
    });
    const [header] = out.split('\n');
    expect(header).toBe('Name          Count');
  });

  it('right-aligns columns', () => {
    const out = renderTable<Row>({
      columns: [
        { header: 'Count', get: (r) => String(r.count), align: 'right' }
      ],
      rows: [{ name: 'x', count: 7 }]
    });
    const [, data] = out.split('\n');
    expect(data).toMatch(/^\s+7$/);
  });

  it('returns the empty message when there are no rows', () => {
    const out = renderTable<Row>({
      columns: [{ header: 'Name', get: (r) => r.name }],
      rows: []
    });
    expect(out).toBe('No items.\n');
  });

  it('honors a custom empty message', () => {
    const out = renderTable<Row>({
      columns: [{ header: 'Name', get: (r) => r.name }],
      rows: [],
      emptyMessage: 'Nothing here.\n'
    });
    expect(out).toBe('Nothing here.\n');
  });
});
