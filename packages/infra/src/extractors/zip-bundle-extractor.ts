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
