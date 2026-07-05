/**
 * Shared table renderer for CLI list commands.
 *
 * Produces fixed-width aligned text tables from header + row data.
 * Used by any command that emits a list of records in text mode.
 *
 * Ported from feat/cli-backup (commit 44c5678, author: Waldek Herka).
 */

export interface TableColumn<T = unknown> {
  header: string;
  get: (row: T) => string;
  width?: number;
  align?: 'left' | 'right';
}

export interface RenderTableOptions<T = unknown> {
  columns: TableColumn<T>[];
  rows: T[];
  gap?: number;
  emptyMessage?: string;
}

export const renderTable = <T>(opts: RenderTableOptions<T>): string => {
  const { columns, rows, gap = 2, emptyMessage = 'No items.\n' } = opts;

  if (rows.length === 0) {
    return emptyMessage;
  }

  const widths = columns.map((col) => {
    if (col.width !== undefined) {
      return col.width;
    }
    const headerLen = col.header.length;
    const maxDataLen = Math.max(...rows.map((r) => col.get(r).length));
    return Math.max(headerLen, maxDataLen);
  });

  const pad = (text: string, width: number, align: 'left' | 'right'): string =>
    align === 'right' ? text.padStart(width) : text.padEnd(width);

  const fmtRow = (cells: string[]): string =>
    cells.map((c, i) => pad(c, widths[i], columns[i].align ?? 'left')).join(' '.repeat(gap));

  const lines: string[] = [
    fmtRow(columns.map((c) => c.header)),
    ...rows.map((r) => fmtRow(columns.map((c) => c.get(r))))
  ];

  return lines.join('\n') + '\n';
};
