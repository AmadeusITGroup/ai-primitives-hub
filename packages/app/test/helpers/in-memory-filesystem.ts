/**
 * Shared test helper — an in-memory `FileSystem` double.
 *
 * Mirrors `@ai-primitives-hub/infra`'s own `test/helpers/in-memory-
 * filesystem.ts` (test-only code isn't exported across package
 * boundaries, so each package keeps its own copy — matches the
 * reference branch's own per-package test-helper convention).
 * Also satisfies the narrower `WriterFs`/`LockfileFs` shapes this
 * package's writers/stores accept.
 * @module test/helpers/in-memory-filesystem
 */
import type {
  DirEntry,
  FileStat,
  FileSystem,
} from '@ai-primitives-hub/core';

interface InMemoryEntry {
  contents: string | Uint8Array;
  mtimeMs: number;
}

const asString = (contents: string | Uint8Array): string =>
  typeof contents === 'string' ? contents : new TextDecoder().decode(contents);

const asBytes = (contents: string | Uint8Array): Uint8Array =>
  typeof contents === 'string' ? new TextEncoder().encode(contents) : contents;

/**
 * A flat, path-keyed in-memory filesystem. Directories are implicit:
 * any prefix of a file path that ends in `/` is considered to exist.
 */
export class InMemoryFileSystem implements FileSystem {
  private readonly files = new Map<string, InMemoryEntry>();

  private normalizePath(path: string): string {
    return path.replaceAll('\\', '/');
  }

  /**
   * Seed a file directly, bypassing `writeFile`, for test setup.
   * @param path - File path to seed.
   * @param contents - Text contents for the seeded file.
   * @param mtimeMs - Modification time to report from `stat()`, in
   * milliseconds since the Unix epoch. Defaults to `0`.
   */
  public seed(path: string, contents: string | Uint8Array, mtimeMs = 0): void {
    this.files.set(this.normalizePath(path), { contents, mtimeMs });
  }

  public async readFile(path: string): Promise<string> {
    const normalizedPath = this.normalizePath(path);
    const entry = this.files.get(normalizedPath);
    if (!entry) {
      throw new Error(`ENOENT: no such file: ${normalizedPath}`);
    }
    return asString(entry.contents);
  }

  public async writeFile(path: string, contents: string): Promise<void> {
    this.files.set(this.normalizePath(path), { contents, mtimeMs: Date.now() });
  }

  public async readFileBytes(path: string): Promise<Uint8Array> {
    const normalizedPath = this.normalizePath(path);
    const entry = this.files.get(normalizedPath);
    if (!entry) {
      throw new Error(`ENOENT: no such file: ${normalizedPath}`);
    }
    return asBytes(entry.contents);
  }

  public async writeFileBytes(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(this.normalizePath(path), { contents: bytes, mtimeMs: Date.now() });
  }

  public async readJson<T = unknown>(path: string): Promise<T> {
    return JSON.parse(await this.readFile(path)) as T;
  }

  public async writeJson(path: string, value: unknown): Promise<void> {
    await this.writeFile(path, JSON.stringify(value, null, 2));
  }

  public async exists(path: string): Promise<boolean> {
    const normalizedPath = this.normalizePath(path);
    if (this.files.has(normalizedPath)) {
      return true;
    }
    const dirPrefix = normalizedPath.endsWith('/') ? normalizedPath : `${normalizedPath}/`;
    return [...this.files.keys()].some((existing) => existing.startsWith(dirPrefix));
  }

  public mkdir(): Promise<void> {
    // No-op: directories are implicit in this flat, in-memory model.
    return Promise.resolve();
  }

  public async readDir(path: string): Promise<string[]> {
    return (await this.readDirEntries(path)).map((entry) => entry.name);
  }

  public async readDirEntries(path: string): Promise<DirEntry[]> {
    const normalizedPath = this.normalizePath(path);
    if (this.files.has(normalizedPath)) {
      throw new Error(`ENOTDIR: not a directory: ${normalizedPath}`);
    }
    const prefix = normalizedPath.endsWith('/') ? normalizedPath : `${normalizedPath}/`;
    const names = new Map<string, boolean>();

    for (const filePath of this.files.keys()) {
      if (!filePath.startsWith(prefix)) {
        continue;
      }
      const rest = filePath.slice(prefix.length);
      const slashIndex = rest.indexOf('/');
      if (slashIndex === -1) {
        names.set(rest, false);
      } else {
        names.set(rest.slice(0, slashIndex), true);
      }
    }

    return [...names.entries()].map(([name, isDirectory]) => ({ name, isDirectory }));
  }

  public async stat(path: string): Promise<FileStat> {
    const normalizedPath = this.normalizePath(path);
    const entry = this.files.get(normalizedPath);
    if (entry) {
      return {
        isDirectory: false,
        isFile: true,
        size: asBytes(entry.contents).byteLength,
        mtimeMs: entry.mtimeMs
      };
    }
    if (await this.exists(normalizedPath)) {
      return { isDirectory: true, isFile: false, size: 0, mtimeMs: 0 };
    }
    throw new Error(`ENOENT: no such file or directory: ${normalizedPath}`);
  }

  public async remove(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const normalizedPath = this.normalizePath(path);
    if (opts?.recursive === true) {
      const prefix = normalizedPath.endsWith('/') ? normalizedPath : `${normalizedPath}/`;
      for (const key of this.files.keys()) {
        if (key === normalizedPath || key.startsWith(prefix)) {
          this.files.delete(key);
        }
      }
      return;
    }
    this.files.delete(normalizedPath);
  }
}
