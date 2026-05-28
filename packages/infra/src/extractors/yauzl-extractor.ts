/**
 * YauzlBundleExtractor.
 *
 * `BundleExtractor` impl that walks a zip with `yauzl` (already a
 * lib dependency for `archiver`) and produces an `ExtractedFiles`
 * map. We deliberately do NOT use `adm-zip` here even though the
 * extension does (originally adm-zip; revised to yauzl
 * because it is already a dep). The two extractors are
 * functionally equivalent for the central-directory inputs we
 * accept, and yauzl avoids adding a new transitive dep to the
 * published package.
 *
 * Streaming: yauzl reads entries lazily; we collect all bytes into
 * memory because the lib pipeline expects an in-memory map. For
 * gigabyte-scale bundles a streaming variant is left as future
 * work.
 *
 * Security: zip-slip is prevented by rejecting any entry whose
 * normalized path escapes the bundle root (starts with `..` or is
 * absolute).
 */
import {
  type BundleExtractor,
  type ExtractedFiles,
} from '@prompt-registry/core';
import {
  type ZipFile,
} from 'yauzl';
import * as yauzl from 'yauzl';

/**
 * YauzlBundleExtractor - extracts bundle zips using yauzl.
 * Streaming extractor that reads entries lazily and collects bytes into memory.
 * Prevents zip-slip attacks by rejecting paths that escape the bundle root.
 */
/* eslint-disable @typescript-eslint/member-ordering -- public surface first, private helpers below */
export class YauzlBundleExtractor implements BundleExtractor {
  /**
   * Decode a zip buffer into an `ExtractedFiles` map.
   * @param bytes Raw zip bytes.
   * @returns Promise of bundle-relative path → file bytes.
   */
  public extract(bytes: Uint8Array): Promise<ExtractedFiles> {
    return new Promise<ExtractedFiles>((resolve, reject) => {
      const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
        if (err !== null && err !== undefined) {
          reject(err);
          return;
        }
        if (zip === undefined) {
          reject(new Error('yauzl: no zipfile produced'));
          return;
        }
        const out = new Map<string, Uint8Array>();
        zip.readEntry();
        zip.on('error', reject);
        zip.on('end', () => {
          resolve(out);
        });
        zip.on('entry', (entry: yauzl.Entry) => {
          this.handleEntry(zip, entry, out, reject);
        });
      });
    });
  }

  /**
   * Process a single zip entry and queue the next read.
   * @param zip ZipFile.
   * @param entry Current entry.
   * @param out Accumulator map.
   * @param reject Rejector to surface errors.
   */
  private handleEntry(
    zip: ZipFile,
    entry: yauzl.Entry,
    out: Map<string, Uint8Array>,
    reject: (err: unknown) => void
  ): void {
    const name = entry.fileName;
    // Skip directory entries (trailing '/').
    if (name.endsWith('/')) {
      zip.readEntry();
      return;
    }
    if (isUnsafeZipPath(name)) {
      reject(new Error(`zip-slip rejected: ${name}`));
      return;
    }
    zip.openReadStream(entry, (err, stream) => {
      if (err !== null && err !== undefined) {
        reject(err);
        return;
      }
      if (stream === undefined) {
        reject(new Error(`yauzl: no stream for ${name}`));
        return;
      }
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer): void => {
        chunks.push(chunk);
      });
      stream.on('end', () => {
        const concat = Buffer.concat(chunks);
        out.set(
          name,
          new Uint8Array(concat.buffer, concat.byteOffset, concat.byteLength)
        );
        zip.readEntry();
      });
      stream.on('error', reject);
    });
  }
}

/**
 * Reject obviously unsafe paths: absolute, leading `..`, or
 * any segment that resolves above the root. Exposed for unit
 * testing because archiver-built zips strip these paths before
 * we get a chance to feed them to the extractor.
 * @param name Entry filename from the zip.
 * @returns true when the path should be rejected.
 */
export const isUnsafeZipPath = (name: string): boolean => {
  const normalized = name.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    return true;
  }
  const parts = normalized.split('/');
  let depth = 0;
  for (const p of parts) {
    if (p === '..') {
      depth -= 1;
      if (depth < 0) {
        return true;
      }
    } else if (p !== '' && p !== '.') {
      depth += 1;
    }
  }
  return false;
};
