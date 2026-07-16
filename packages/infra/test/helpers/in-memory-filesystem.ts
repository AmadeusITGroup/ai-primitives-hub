/**
 * Shared test helper — an in-memory `FileSystem` double.
 *
 * Reused across every `infra` adapter/test that needs a `FileSystem`
 * without touching real disk (per `test/AGENTS.md`'s "mandatory helper
 * reuse" principle, applied here to this package's own Vitest suites).
 * @module test/helpers/in-memory-filesystem
 */
import type {
  DirEntry,
  FileStat,
  FileSystem,
} from '@ai-primitives-hub/core';

interface InMemoryEntry {
  contents: string;
  mtimeMs: number;
}

/**
 * A flat, path-keyed in-memory filesystem. Directories are implicit:
 * any prefix of a file path that ends in `/` is considered to exist.
 */
export class InMemoryFileSystem implements FileSystem {
  private readonly files = new Map<string, InMemoryEntry>();

  /**
   * Seed a file directly, bypassing `writeFile`, for test setup.
   * @param path - File path to seed.
   * @param contents - Text contents for the seeded file.
   * @param mtimeMs - Modification time to report from `stat()`, in
   * milliseconds since the Unix epoch. Defaults to `0`.
   */
  public seed(path: string, contents: string, mtimeMs = 0): void {
    this.files.set(path, { contents, mtimeMs });
  }

  public async readFile(path: string): Promise<string> {
    const entry = this.files.get(path);
    if (!entry) {
      throw new Error(`ENOENT: no such file: ${path}`);
    }
    return entry.contents;
  }

  public async writeFile(path: string, contents: string): Promise<void> {
    this.files.set(path, { contents, mtimeMs: Date.now() });
  }

  public async readJson<T = unknown>(path: string): Promise<T> {
    return JSON.parse(await this.readFile(path)) as T;
  }

  public async writeJson(path: string, value: unknown): Promise<void> {
    await this.writeFile(path, JSON.stringify(value, null, 2));
  }

  public async exists(path: string): Promise<boolean> {
    if (this.files.has(path)) {
      return true;
    }
    const dirPrefix = path.endsWith('/') ? path : `${path}/`;
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
    if (this.files.has(path)) {
      throw new Error(`ENOTDIR: not a directory: ${path}`);
    }
    const prefix = path.endsWith('/') ? path : `${path}/`;
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
    const entry = this.files.get(path);
    if (entry) {
      return {
        isDirectory: false,
        isFile: true,
        size: Buffer.byteLength(entry.contents, 'utf8'),
        mtimeMs: entry.mtimeMs
      };
    }
    if (await this.exists(path)) {
      return { isDirectory: true, isFile: false, size: 0, mtimeMs: 0 };
    }
    throw new Error(`ENOENT: no such file or directory: ${path}`);
  }

  public async remove(path: string, opts?: { recursive?: boolean }): Promise<void> {
    if (opts?.recursive === true) {
      const prefix = path.endsWith('/') ? path : `${path}/`;
      for (const key of this.files.keys()) {
        if (key === path || key.startsWith(prefix)) {
          this.files.delete(key);
        }
      }
      return;
    }
    this.files.delete(path);
  }
}
