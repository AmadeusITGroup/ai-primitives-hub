/**
 * The hub's section of a repository's `info/exclude` file. Every writer of the
 * section edits the text through these pure functions so they agree.
 * @module domain/install/git-exclude
 */

/** Header line written above the hub's `info/exclude` entries. */
export const GIT_EXCLUDE_SECTION_HEADER = '# Prompt Registry (local)';

const isHeaderLine = (line: string): boolean => line.trim() === GIT_EXCLUDE_SECTION_HEADER;

const listsEntry = (line: string, entry: string): boolean => {
  const trimmed = line.trim();
  return trimmed === entry || trimmed === `/${entry}`;
};

/**
 * Add entries below the hub's header in an `info/exclude` text, skipping ones already listed.
 * @param text - Current contents; `''` when the file does not exist.
 * @param entries - Root-relative paths.
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
 * Remove entries listed below the hub's header; the header and lines above it stay.
 * @param text - Current contents.
 * @param entries - Root-relative paths.
 * @returns The new text, or `undefined` when nothing changes.
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
