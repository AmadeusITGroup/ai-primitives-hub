/**
 * Real-filesystem temp directory helper for tests that exercise code
 * bypassing the `FileSystem` port on purpose (`harvest/integrity.ts`,
 * `harvest/progress-log.ts` — both need synchronous atomic-rename or an
 * open file handle, which the port doesn't model).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Create a fresh temp directory under the OS temp dir.
 * @param prefix - Directory name prefix, for easier identification when debugging leftovers.
 * @returns A tuple of the created directory's absolute path and a cleanup function.
 */
export function createTempDir(prefix: string): [string, () => void] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return [dir, () => fs.rmSync(dir, { recursive: true, force: true })];
}
