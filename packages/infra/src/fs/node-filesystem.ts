/**
 * Node `fs/promises`-backed implementation of the `FileSystem` port.
 *
 * Backs the four local-family adapters (`LocalAdapter`, `LocalApmAdapter`,
 * `LocalAwesomeCopilotAdapter`, `LocalSkillsAdapter`) and any other
 * `infra`/`app` code that needs real disk I/O behind the port, per the
 * migration plan's adapter-unification cutover (§7.5 Phase 4 item 3). Every
 * method is a thin pass-through to the matching `node:fs/promises` call -
 * this class exists only to keep `core`/`app` free of direct `node:fs`
 * imports, not to add behavior of its own. The one exception is
 * `setExecutable`, which derives the new mode from the current one.
 * @module fs/node-filesystem
 */
import {
  access,
  chmod,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import type {
  DirEntry,
  FileStat,
  FileSystem,
} from '@ai-primitives-hub/core';

/** `chmod` errors meaning the mode cannot be changed here, not an I/O failure. */
const MODE_UNSUPPORTED_CODES: ReadonlySet<string> = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EINVAL']);

export class NodeFileSystem implements FileSystem {
  public realpath(path: string): Promise<string> {
    return realpath(path);
  }

  public async readFile(path: string): Promise<string> {
    return readFile(path, 'utf8');
  }

  public async writeFile(path: string, contents: string): Promise<void> {
    await writeFile(path, contents, 'utf8');
  }

  public async readFileBytes(path: string): Promise<Uint8Array> {
    const buffer = await readFile(path);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  public async writeFileBytes(path: string, bytes: Uint8Array): Promise<void> {
    await writeFile(path, bytes);
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
      mtimeMs: stats.mtimeMs,
      // eslint-disable-next-line no-bitwise -- keep only the permission bits
      mode: stats.mode & 0o777
    };
  }

  /**
   * Add or clear the execute bits of an existing file (issue #577).
   *
   * `true` grants execute wherever read is already granted, so the result
   * follows the umask the file was created with (`0644` → `0755`,
   * `0600` → `0700`), as a Git checkout of a `100755` file does. `false`
   * clears every execute bit. Write and special bits are never added.
   * Windows has no POSIX execute bit: the call resolves without changes.
   *
   * Best effort: when the filesystem or the file's owner does not allow
   * the mode change (`EPERM`, `ENOTSUP`, `EOPNOTSUPP`, `EINVAL`, e.g. vfat/exFAT mounts
   * or a file owned by another user), the file keeps its current mode and
   * the call resolves. Other errors, such as `ENOENT`, still reject.
   * @param path Absolute file path.
   * @param executable Whether the file should be executable.
   */
  public async setExecutable(path: string, executable: boolean): Promise<void> {
    if (process.platform === 'win32') {
      return;
    }
    // eslint-disable-next-line no-bitwise -- keep only the permission bits
    const current = (await stat(path)).mode & 0o777;
    const next = executable
      // eslint-disable-next-line no-bitwise -- copy each read bit to the execute bit of the same class
      ? current | ((current & 0o444) >> 2)
      // eslint-disable-next-line no-bitwise -- clear every execute bit
      : current & ~0o111;
    if (next === current) {
      return;
    }
    try {
      await chmod(path, next);
    } catch (error) {
      if (!MODE_UNSUPPORTED_CODES.has((error as NodeJS.ErrnoException).code ?? '')) {
        throw error;
      }
    }
  }

  public async remove(path: string, opts?: { recursive?: boolean }): Promise<void> {
    await rm(path, { recursive: opts?.recursive ?? false, force: true });
  }
}
