/**
 * LocalExtractedPayloadLoader — reads an extracted bundle directory into a
 * canonical ExtractedFiles map + validated manifest. Refuses symlinks,
 * escaping paths, missing manifests, and enforces 4096-file / 32 MiB bounds.
 * @module runtime-target/local-payload-loader
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  ExtractedFile,
  ExtractedFiles,
  ValidatedManifest,
} from '@ai-primitives-hub/core';
import {
  MANIFEST_FILENAME,
  validateManifest,
} from '@ai-primitives-hub/core';

const MAX_FILES = 4096;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

export interface LocalPayload {
  files: ExtractedFiles;
  manifest: ValidatedManifest;
}

/**
 * Load an extracted bundle directory into payload files + manifest.
 * @param rootDir
 */
export async function loadExtractedDirectory(rootDir: string): Promise<LocalPayload> {
  const root = await fs.realpath(rootDir).catch(() => {
    throw new Error(`payload directory does not exist: ${rootDir}`);
  });
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) {
    throw new Error(`payload path is not a directory: ${rootDir}`);
  }
  const manifestStat = await fs.lstat(path.join(root, MANIFEST_FILENAME)).catch(() => null);
  if (manifestStat === null || !manifestStat.isFile()) {
    throw new Error(
      `payload directory lacks a root ${MANIFEST_FILENAME}; reacquire the source or point at a standard extracted bundle directory`
    );
  }

  const files = new Map<string, ExtractedFile>();
  let total = 0;
  let count = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const lst = await fs.lstat(abs);
      if (lst.isSymbolicLink()) {
        throw new Error(`payload contains a symlink, refusing: ${abs}`);
      }
      if (!lst.isFile() && !lst.isDirectory()) {
        throw new Error(`payload contains a non-regular file, refusing: ${abs}`);
      }
      if (lst.isDirectory()) {
        await walk(abs);
        continue;
      }
      count += 1;
      total += lst.size;
      if (count > MAX_FILES) {
        throw new Error(`payload exceeds ${MAX_FILES} files`);
      }
      if (total > MAX_TOTAL_BYTES) {
        throw new Error(`payload exceeds 32 MiB total`);
      }
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (rel.length === 0 || rel === '..' || rel.startsWith('../')) {
        throw new Error(`payload path escapes its root: ${abs}`);
      }
      const bytes = new Uint8Array(await fs.readFile(abs)) as ExtractedFile;
      // eslint-disable-next-line no-bitwise -- permission bits only
      const mode = lst.mode & 0o777;
      if (mode !== 0o644 && mode !== 0o444) {
        (bytes as { mode?: number }).mode = mode;
      }
      files.set(rel, bytes);
    }
  };
  await walk(root);
  const manifest = validateManifest(files, {});
  return { files, manifest };
}
