/**
 * Domain layer — install-time file modes (issue #577).
 *
 * A bundle archive records each file's Unix permission bits; a committed
 * `100755` script is stored as a `0755` entry. Extractors attach that mode
 * to the extracted bytes with {@link withFileMode}; the install writers call
 * {@link applyFileMode} after every verified write, which is the single place
 * the executable bit of an installed file is decided.
 *
 * Pure domain logic over an injected port subset: no `node:fs`, no IO of
 * its own.
 * @module domain/install/file-mode
 */
import type {
  ExtractedFile,
} from '../../ports/bundle-extractor';

/** `rwxrwxrwx` — the only permission bits an archive mode may carry over. */
const PERMISSION_BITS = 0o777;

/** `--x--x--x`. */
const EXECUTE_BITS = 0o111;

/**
 * Attach the permission bits recorded for a file to its bytes.
 *
 * Sets a non-enumerable, read-only `mode` on the given object and returns it,
 * so map copies (`new Map(files)`, filtered maps) keep the mode while the
 * bytes themselves (and equality checks on them) are unchanged. Setuid,
 * setgid and sticky bits are dropped: they are untrusted archive metadata.
 * @param bytes File contents; tagged in place.
 * @param mode Unix mode recorded by the source.
 * @returns The same bytes, now carrying `mode`.
 */
export function withFileMode(bytes: Uint8Array, mode: number): ExtractedFile {
  Object.defineProperty(bytes, 'mode', {
    // eslint-disable-next-line no-bitwise -- keep only the permission bits
    value: mode & PERMISSION_BITS,
    enumerable: false,
    writable: false,
    configurable: true
  });
  return bytes;
}

/**
 * Whether a recorded mode grants execute permission to anyone.
 * @param mode Unix permission bits.
 * @returns True when any execute bit is set.
 */
export function isExecutableMode(mode: number): boolean {
  // eslint-disable-next-line no-bitwise -- test the execute bits
  return (mode & EXECUTE_BITS) !== 0;
}

/**
 * The filesystem subset {@link applyFileMode} needs. Optional, so adapters
 * that cannot set modes (in-memory doubles, editor filesystems) still fit.
 */
export interface ExecutableBitSetter {
  setExecutable?(path: string, executable: boolean): Promise<void>;
}

/**
 * Give an installed file the executable bit its source recorded.
 *
 * No-op when the source carries no mode or the filesystem cannot set one.
 * @param fs Filesystem the file was written through.
 * @param filePath Absolute path of the installed file.
 * @param source Source bytes the file was written from.
 */
export async function applyFileMode(
  fs: ExecutableBitSetter,
  filePath: string,
  source: ExtractedFile
): Promise<void> {
  if (source.mode === undefined || fs.setExecutable === undefined) {
    return;
  }
  await fs.setExecutable(filePath, isExecutableMode(source.mode));
}
