/**
 * Test helpers for install-related tests.
 * These were moved from src/install/ when that directory was deleted in Phase 2A.
 */

import * as crypto from 'node:crypto';
import type {
  BundleDownloader,
  BundleExtractor,
  BundleResolver,
  BundleSpec,
  DownloadResult,
  ExtractedFiles,
  FileSystem,
  Installable,
} from '@prompt-registry/core';

/**
 * Simple in-memory bundle downloader for tests.
 */
export class MemoryBundleDownloader implements BundleDownloader {
  public constructor(private readonly bytesByUrl: Record<string, Uint8Array>) {}

  public async download(installable: Installable): Promise<DownloadResult> {
    const bytes = this.bytesByUrl[installable.downloadUrl];
    if (!bytes) {
      throw new Error(`no bytes registered`);
    }
    const sha256 = await sha256Hex(bytes);

    // Check integrity if provided
    if (installable.integrity) {
      const expectedHash = installable.integrity.replace('sha256-', '');
      if (sha256 !== expectedHash) {
        throw new Error('integrity mismatch');
      }
    }

    return { bytes, sha256 };
  }
}

/**
 * SHA-256 hex helper for tests.
 * @param data
 */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const hash = crypto.createHash('sha256');
  hash.update(data);
  return hash.digest('hex');
}

/**
 * Simple in-memory bundle extractor for tests.
 */
export class DictBundleExtractor implements BundleExtractor {
  private readonly files: Map<string, Uint8Array>;

  public constructor(files: Record<string, string>) {
    this.files = new Map(
      Object.entries(files).map(([k, v]) => [k, new TextEncoder().encode(v)])
    );
  }

  public async extract(_bytes: Uint8Array): Promise<ExtractedFiles> {
    return this.files;
  }
}

/**
 * Simple map-based bundle resolver for tests.
 */
export class MapBundleResolver implements BundleResolver {
  public constructor(private readonly entries: Record<string, Installable[]>) {}

  public async resolve(spec: BundleSpec): Promise<Installable | null> {
    // Handle bare bundleId (no sourceId)
    if (!spec.sourceId) {
      const firstItems = this.entries[spec.bundleId];
      if (!firstItems || firstItems.length === 0) {
        return null;
      }
      // Return the latest by version
      return firstItems.at(-1) ?? null;
    }

    const key = `${spec.sourceId}:${spec.bundleId}`;
    const secondItems = this.entries[key];
    if (!secondItems || secondItems.length === 0) {
      return null;
    }

    // If exact version requested, find it
    if (spec.bundleVersion) {
      const exact = secondItems.find((i) => i.ref.bundleVersion === spec.bundleVersion);
      return exact ?? null;
    }

    // Return the latest by default
    return secondItems.at(-1) ?? null;
  }
}

/**
 * Convert a record of filenames to content into ExtractedFiles format.
 * @param record
 */
export function filesFromRecord(record: Record<string, string>): ExtractedFiles {
  const map = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(record)) {
    map.set(path, new TextEncoder().encode(content));
  }
  return map;
}

/**
 * Simple mock filesystem for tests.
 * Provides basic implementations of common filesystem operations.
 */
export function createSimpleMockFs(): FileSystem {
  return {
    readFile: async () => new Uint8Array(),
    writeFile: async () => {},
    exists: async () => false,
    mkdir: async () => {},
    readdir: async () => [],
    rm: async () => {},
    stat: async () => ({ type: 'file' }),
    readJson: async () => ({}),
    writeJson: async () => {},
    readDir: async () => [],
    remove: async () => {}
  };
}

/**
 * Create a temporary directory for tests with automatic cleanup.
 * @param prefix - Directory name prefix (e.g., 'pi-test-')
 * @returns Tuple of [directory path, cleanup function]
 */
export function createTempDir(prefix: string): [string, () => void] {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  return [tmp, cleanup];
}
