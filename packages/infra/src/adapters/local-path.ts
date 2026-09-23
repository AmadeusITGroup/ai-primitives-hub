/**
 * Shared path/URL resolution utilities for all local-based source adapters,
 * including `LocalAdapter` and the `local-*` adapter variants.
 *
 * Handles `file://` URL-to-path conversion, `~/` home-directory expansion,
 * and path normalization.
 * @module adapters/local-path
 */
import * as os from 'node:os';
import * as path from 'node:path';
import {
  fileURLToPath,
} from 'node:url';

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
  let localPath = url;
  if (url.startsWith('file://')) {
    try {
      localPath = fileURLToPath(url);
    } catch {
      // POSIX-style file URLs without a drive letter are valid source
      // identifiers in portable configurations, including test fixtures.
      localPath = url.slice('file://'.length);
    }
  }
  if (localPath.startsWith('~/')) {
    localPath = path.join(os.homedir(), localPath.slice(2));
  }
  return path.normalize(localPath);
}

/**
 * Serializes a local filesystem path as a cross-platform `file://` URL.
 * @param localPath - Local filesystem path, using either native separator style.
 */
export function toFileUrl(localPath: string): string {
  const urlPath = localPath.replaceAll('\\', '/');
  return `file://${urlPath.startsWith('/') ? '' : '/'}${urlPath}`;
}
