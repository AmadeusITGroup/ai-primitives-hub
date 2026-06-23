/**
 * Shared table renderer for CLI list commands.
 *
 * Produces fixed-width aligned text tables from header + row data.
 * Used by any command that emits a list of records in text mode.
 */

export interface TableColumn<T = unknown> {
  /** Column header text. */
  header: string;
  /** Extract cell text from a row object. */
  get: (row: T) => string;
  /** Optional fixed width (overrides auto-width). */
  width?: number;
  /** Align: 'left' (default) or 'right'. */
  align?: 'left' | 'right';
}

export interface RenderTableOptions<T = unknown> {
  /** Column definitions. */
  columns: TableColumn<T>[];
  /** Row data. */
  rows: T[];
  /** Gap between columns (default 2). */
  gap?: number;
  /** Message when rows is empty (default 'No items.\n'). */
  emptyMessage?: string;
}

/**
 * Render rows as a fixed-width text table.
 * @param opts columns, rows, gap, emptyMessage.
 * @returns Multi-line string (newline-terminated), or emptyMessage when rows is empty.
 */
export const renderTable = <T>(opts: RenderTableOptions<T>): string => {
  const { columns, rows, gap = 2, emptyMessage = 'No items.\n' } = opts;

  if (rows.length === 0) {
    return emptyMessage;
  }

  // Compute width for each column.
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

  const lines = [
    fmtRow(columns.map((c) => c.header)),
    ...rows.map((r) => fmtRow(columns.map((c) => c.get(r))))
  ];

  return lines.join('\n') + '\n';
};
