/**
 * ZipBundleExtractor — BundleExtractor implementation that decodes a
 * zip archive, held entirely in memory, into a path -> bytes map.
 *
 * Uses `adm-zip`, the same library `BundleInstaller.extractBundle()`
 * already uses in production in the VS Code extension (disk-to-disk
 * there; bytes-to-map here) — chosen over a hand-rolled reader for a
 * production-critical path that must robustly handle whatever a real
 * GitHub release/adapter-built zip contains, not just the narrow
 * subset `writers/zip-writer.ts` itself produces.
 * @module extractors/zip-bundle-extractor
 */
import type {
  BundleExtractor,
  ExtractedFiles,
} from '@ai-primitives-hub/core';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- matches the extension's own import style for this CJS-only package
import AdmZip = require('adm-zip');

/**
 * Decodes bundle zip bytes into a file map, entirely in memory.
 */
export class ZipBundleExtractor implements BundleExtractor {
  /**
   * Extract the bundle zip into a path -> bytes map.
   * @param bytes Raw bundle bytes (zip).
   * @returns Map of relative paths to file contents.
   */
  public async extract(bytes: Uint8Array): Promise<ExtractedFiles> {
    let zip: AdmZip;
    try {
      zip = new AdmZip(Buffer.from(bytes));
    } catch (error) {
      throw new Error(`Failed to extract bundle: ${(error as Error).message}`);
    }

    const files = new Map<string, Uint8Array>();
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) {
        continue;
      }
      const path = normalizeZipPath(entry.entryName);
      if (path === undefined) {
        throw new Error(`Unsafe ZIP path: ${entry.entryName}`);
      }
      files.set(path, entry.getData());
    }
    return files;
  }
}

/**
 * Read the Unix permission bits (`rwxrwxrwx` only) recorded for each file
 * entry of a zip, keyed by the
 * same normalised path `ZipBundleExtractor.extract` uses. Entries with no
 * recorded Unix mode (e.g. zips made on Windows) are omitted.
 * @param bytes Raw zip bytes.
 * @returns Map of relative paths to permission bits.
 */
export function readZipEntryModes(bytes: Uint8Array): ReadonlyMap<string, number> {
  let zip: AdmZip;
  try {
    zip = new AdmZip(Buffer.from(bytes));
  } catch (error) {
    throw new Error(`Failed to read bundle: ${(error as Error).message}`);
  }
  const modes = new Map<string, number>();
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) {
      continue;
    }
    const path = normalizeZipPath(entry.entryName);
    if (path === undefined) {
      throw new Error(`Unsafe ZIP path: ${entry.entryName}`);
    }
    // External attributes carry the Unix mode in the high 16 bits. Keep
    // only rwxrwxrwx: setuid/setgid/sticky are attacker-controlled archive
    // metadata (GHSA-679w-jf3m-wh39).
    // eslint-disable-next-line no-bitwise -- Required for ZIP external attributes
    const mode = (entry.attr >>> 16) & 0o777;
    if (mode !== 0) {
      modes.set(path, mode);
    }
  }
  return modes;
}

function normalizeZipPath(entryName: string): string | undefined {
  const path = entryName.replaceAll('\\', '/');
  if (path.startsWith('/') || /^[A-Za-z]:\//.test(path)) {
    return undefined;
  }

  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (segments.length === 0) {
        return undefined;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join('/') : undefined;
}
