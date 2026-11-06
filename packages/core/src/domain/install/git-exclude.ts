/**
 * The hub's section of a repository's `info/exclude` file (BR2.3).
 *
 * Local-only installs list their files, and the local-only install record,
 * below one header line. Every writer of that section (the repository-scope
 * writer's `GitInfoExclude` in infra and the install record store in app)
 * edits the text through these two pure functions, so they agree on where an
 * entry goes and when it counts as already listed. The caller reads and
 * writes the file.
 * @module domain/install/git-exclude
 */

/** Header line written above the hub's `info/exclude` entries. */
export const GIT_EXCLUDE_SECTION_HEADER = '# Prompt Registry (local)';

const isHeaderLine = (line: string): boolean => line.trim() === GIT_EXCLUDE_SECTION_HEADER;

/**
 * Whether a line of the file lists `entry`, as `entry` or `/entry`, ignoring
 * surrounding whitespace and a trailing `\r`.
 * @param line - One line of the file.
 * @param entry - Path relative to the repository root, forward slashes.
 */
const listsEntry = (line: string, entry: string): boolean => {
  const trimmed = line.trim();
  return trimmed === entry || trimmed === `/${entry}`;
};

/**
 * Add entries to the hub's section of an `info/exclude` text.
 *
 * An entry already listed anywhere in the file is not added again. An empty
 * text becomes the header followed by the entries in the given order.
 * Otherwise each new entry goes directly below the header (so the last one
 * given ends up first), and a text without the header gets it appended as
 * a new last line first. An empty `entries` list still adds the header.
 * @param text - Current file contents; `''` when the file does not exist.
 * @param entries - Paths relative to the repository root, forward slashes.
 * @returns The new text, or `undefined` when nothing changes.
 */
export const addExcludeEntries = (text: string, entries: readonly string[]): string | undefined => {
  if (text === '') {
    return [GIT_EXCLUDE_SECTION_HEADER, ...new Set(entries)].join('\n');
  }
  const lines = text.split('\n');
  const missing = [...new Set(entries)].filter((entry) => !lines.some((line) => listsEntry(line, entry)));
  let headerIndex = lines.findIndex((line) => isHeaderLine(line));
  if (missing.length === 0 && (entries.length > 0 || headerIndex !== -1)) {
    return undefined;
  }
  if (headerIndex === -1) {
    headerIndex = lines.length;
    lines.push(GIT_EXCLUDE_SECTION_HEADER);
  }
  lines.splice(headerIndex + 1, 0, ...missing.toReversed());
  return lines.join('\n');
};

/**
 * Remove entries from the hub's section of an `info/exclude` text: only lines
 * below the header that list one of them (as `entry` or `/entry`) go. The
 * header, even when its section is now empty, and every line above it stay.
 * @param text - Current file contents.
 * @param entries - Paths relative to the repository root, forward slashes.
 * @returns The new text, or `undefined` when nothing changes (no header, or no entry listed below it).
 */
export const removeExcludeEntries = (text: string, entries: readonly string[]): string | undefined => {
  const lines = text.split('\n');
  const headerIndex = lines.findIndex((line) => isHeaderLine(line));
  if (headerIndex === -1) {
    return undefined;
  }
  const kept = lines.filter((line, index) => index <= headerIndex || !entries.some((entry) => listsEntry(line, entry)));
  return kept.length === lines.length ? undefined : kept.join('\n');
};
