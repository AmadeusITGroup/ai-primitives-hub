import {
  createHash,
} from 'node:crypto';
import type {
  ExtractedFile,
  ExtractedFiles,
} from '../../ports/bundle-extractor';
import {
  type ValidatedManifest,
  validateManifest,
} from '../collection/manifest-validator';
import {
  isSafeId,
  isSafeRelativePath,
} from './identity';

/**
 * Validate a payload file entry.
 * @param value
 */
export function isRuntimeMode(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0o777;
}

/**
 * Source bytes without explicit mode metadata retain the original digest.
 * @param sourceId
 * @param manifest
 * @param files
 */
export function runtimePayloadId(sourceId: string, manifest: Pick<ValidatedManifest, 'id' | 'version'>, files: ExtractedFiles): string {
  const entries = [...files.keys()].toSorted().map((key) => {
    const bytes = files.get(key)!;
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const mode = (bytes).mode;
    return mode === undefined ? [key, digest] : [key, digest, mode];
  });
  return createHash('sha256').update(JSON.stringify([sourceId, manifest.id, manifest.version, entries])).digest('hex');
}

/**
 * Validate and own a byte-exact copy; caller objects never become durable state.
 * @param files
 * @param sourceId
 * @param expected
 */
export function validateRuntimePayload(
  files: ExtractedFiles,
  sourceId: string,
  expected?: Pick<ValidatedManifest, 'id' | 'version'>
): { files: ExtractedFiles; manifest: ValidatedManifest } {
  if (!isSafeId(sourceId)) {
    throw new Error('payload sourceId is empty or unsafe');
  }
  if (!(files instanceof Map) || files.size > 4096) {
    throw new Error('payload must be an extracted file map with at most 4096 files');
  }
  let size = 0;
  const owned = new Map<string, ExtractedFile>();
  for (const [key, bytes] of files) {
    if (!isSafeRelativePath(key) || !(bytes instanceof Uint8Array)) {
      throw new Error(`payload has an unsafe file entry: ${String(key)}`);
    }
    size += bytes.byteLength;
    if (size > 32 * 1024 * 1024) {
      throw new Error('payload exceeds 32 MiB');
    }
    const copy = new Uint8Array(bytes) as ExtractedFile;
    const mode = (bytes as ExtractedFile).mode;
    if (mode !== undefined) {
      if (!isRuntimeMode(mode)) {
        throw new Error(`payload file ${key} has an invalid mode`);
      }
      Object.assign(copy, { mode });
    }
    owned.set(key, copy);
  }
  const manifest = validateManifest(owned, {});
  if (!isSafeId(manifest.id)) {
    throw new Error('payload manifest id is empty or unsafe');
  }
  if (expected !== undefined && (manifest.id !== expected.id || manifest.version !== expected.version)) {
    throw new Error('payload manifest identity/version differs from provided metadata');
  }
  return { files: owned, manifest };
}
