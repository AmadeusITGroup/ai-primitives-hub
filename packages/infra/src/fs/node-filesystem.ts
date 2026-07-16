/**
 * Node `fs/promises`-backed implementation of the `FileSystem` port.
 *
 * Backs the four local-family adapters (`LocalAdapter`, `LocalApmAdapter`,
 * `LocalAwesomeCopilotAdapter`, `LocalSkillsAdapter`) and any other
 * `infra`/`app` code that needs real disk I/O behind the port, per the
 * migration plan's adapter-unification cutover (§7.5 Phase 4 item 3). Every
 * method is a thin pass-through to the matching `node:fs/promises` call -
 * this class exists only to keep `core`/`app` free of direct `node:fs`
 * imports, not to add behavior of its own.
 * @module fs/node-filesystem
 */
import {
  access,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import type {
  DirEntry,
  FileStat,
  FileSystem,
} from '@ai-primitives-hub/core';

export class NodeFileSystem implements FileSystem {
  public async readFile(path: string): Promise<string> {
    return readFile(path, 'utf8');
  }

  public async writeFile(path: string, contents: string): Promise<void> {
    await writeFile(path, contents, 'utf8');
  }

  public async readJson<T = unknown>(path: string): Promise<T> {
    return JSON.parse(await this.readFile(path)) as T;
  }

  public async writeJson(path: string, value: unknown): Promise<void> {
    await this.writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  public async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  public async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    await mkdir(path, { recursive: opts?.recursive ?? false });
  }

  public async readDir(path: string): Promise<string[]> {
    return readdir(path);
  }

  public async readDirEntries(path: string): Promise<DirEntry[]> {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
  }

  public async stat(path: string): Promise<FileStat> {
    const stats = await stat(path);
    return {
      isDirectory: stats.isDirectory(),
      isFile: stats.isFile(),
      size: stats.size,
      mtimeMs: stats.mtimeMs
    };
  }

  public async remove(path: string, opts?: { recursive?: boolean }): Promise<void> {
    await rm(path, { recursive: opts?.recursive ?? false, force: true });
  }
}
