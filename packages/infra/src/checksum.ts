/**
 * File checksum helper.
 *
 * Computes SHA-256 hex digests over file bodies (string or
 * Uint8Array) so the install command can populate the lockfile's
 * `fileChecksums` map. Mirrors the extension's
 * `LockfileManager.calculateFileChecksum` semantics.
 *
 * Pure; no IO; safe to import anywhere.
 */
import {
  createHash,
} from 'node:crypto';

/**
 * SHA-256 hex digest of a file body.
 * @param contents File contents (string or bytes).
 * @returns 64-char lowercase hex string.
 */
export const checksumFile = (contents: string | Uint8Array): string => {
  const hash = createHash('sha256');
  if (typeof contents === 'string') {
    hash.update(contents, 'utf8');
  } else {
    hash.update(contents);
  }
  return hash.digest('hex');
};

/**
 * Compute checksums for every file in a bundle's `ExtractedFiles`-
 * shaped map. Skips `deployment-manifest.yml` (the manifest is
 * validated separately and not written to disk). Returns a
 * `Record<bundleRelPath, sha256>` suitable for storing in
 * `LockfileEntry.fileChecksums`.
 * @param files Map of bundle-relative paths to bytes/strings.
 * @param skipPaths Optional list of paths to skip.
 * @returns Map of paths to sha256 hex digests.
 */
export const checksumFiles = (
  files:
    | ReadonlyMap<string, string | Uint8Array>
    | Record<string, string | Uint8Array>,
  skipPaths: string[] = ['deployment-manifest.yml']
): Record<string, string> => {
  const skip = new Set(skipPaths);
  const out: Record<string, string> = {};
  const entries: Iterable<[string, string | Uint8Array]> =
    files instanceof Map ? files.entries() : Object.entries(files);
  for (const [p, contents] of entries) {
    if (skip.has(p)) {
      continue;
    }
    out[p] = checksumFile(contents);
  }
  return out;
};
