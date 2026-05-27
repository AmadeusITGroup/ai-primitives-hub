/**
 * Local-directory bundle source.
 *
 * Read a fully-extracted bundle (a directory containing
 * `deployment-manifest.yml` + primitive subdirs) directly from disk
 * and produce an `ExtractedFiles` map. This bypasses the
 * download/extract stages of `InstallPipeline` and lets the install
 * command work end-to-end without a network or zip-reader dependency
 * for bundles that have already been built locally (e.g. with
 * `prompt-registry bundle build`).
 *
 * The full GitHub-API + HTTP + zip stack is spillover work; this
 * adapter unblocks dev-workflow installs today.
 */
import * as path from 'node:path';
import type {
  ExtractedFiles,
} from '@prompt-registry/core';

export interface LocalDirFs {
  readDir(p: string): Promise<string[]>;
  readFile(p: string): Promise<string>;
  exists(p: string): Promise<boolean>;
}

/**
 * Walk a local bundle directory and produce an ExtractedFiles map
 * with bundle-relative paths.
 * @param dir - Absolute directory path holding the bundle.
 * @param fs - LocalDirFs adapter.
 * @returns ExtractedFiles map keyed on bundle-relative paths.
 * @throws {Error} When `dir` does not exist.
 */
export const readLocalBundle = async (
  dir: string,
  fs: LocalDirFs
): Promise<ExtractedFiles> => {
  if (!(await fs.exists(dir))) {
    throw new Error(`local bundle directory not found: ${dir}`);
  }
  const out = new Map<string, Uint8Array>();
  await walk(dir, dir, fs, out);
  return out;
};

const walk = async (
  root: string,
  cur: string,
  fs: LocalDirFs,
  out: Map<string, Uint8Array>
): Promise<void> => {
  const entries = await fs.readDir(cur);
  for (const entry of entries) {
    const full = path.join(cur, entry);
    // FsAbstraction.readDir returns names only; we probe by trying
    // readFile first. If it succeeds the entry is a file; if it
    // throws we recurse as a directory.
    try {
      const text = await fs.readFile(full);
      const rel = path.relative(root, full);
      // Normalize to forward slashes so the map keys match the
      // bundle's logical layout independent of host OS.
      out.set(rel.split(path.sep).join('/'), new TextEncoder().encode(text));
    } catch {
      await walk(root, full, fs, out);
    }
  }
};
