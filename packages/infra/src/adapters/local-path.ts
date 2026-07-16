/**
 * Shared local-path resolution for `local-*` source adapters.
 *
 * `LocalAdapter` (ported earlier) has its own inline equivalent and is
 * deliberately left untouched here — this module exists for the three
 * `local-*` adapters landing together in one later commit, which need
 * the `~/` expansion that `LocalAdapter`'s own `getLocalPath` doesn't
 * currently perform (a pre-existing gap in already-shipped code, out of
 * scope for this change).
 * @module adapters/local-path
 */
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * True for a `file://` URL, an absolute path, or a `~/`/`./`-relative path.
 * @param url - Candidate source URL.
 */
export function isValidLocalUrl(url: string): boolean {
  return url.startsWith('file://') || path.isAbsolute(url) || url.startsWith('~/') || url.startsWith('./');
}

/**
 * Resolves a source URL accepted by `isValidLocalUrl` to a normalized
 * filesystem path: strips a `file://` prefix, expands a leading `~/` to
 * the current user's home directory, then normalizes.
 * @param url - Source URL to resolve.
 */
export function resolveLocalPath(url: string): string {
  let localPath = url.startsWith('file://') ? url.slice('file://'.length) : url;
  if (localPath.startsWith('~/')) {
    localPath = path.join(os.homedir(), localPath.slice(2));
  }
  return path.normalize(localPath);
}
