/**
 * Node `fs/promises`-backed implementation of the `RecordFs` port.
 *
 * The only disk access install-record code uses (NFR1.3, NFR4.1, NFR7.1):
 * `lstat` that never follows a final symlink, capped chunked reads that ignore
 * the reported size, streamed SHA-256, exclusive create for temp files, and an
 * `unlink` that refuses folders. It never spawns a process (NFR4.7) and never
 * removes anything recursively.
 * @module records/node-record-fs
 */
import {
  createHash,
} from 'node:crypto';
import {
  createReadStream,
} from 'node:fs';
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import type {
  RecordFileKind,
  RecordFileStat,
  RecordFs,
} from '@ai-primitives-hub/core';

/** Size of each chunk `readCapped` reads. */
const READ_CHUNK_BYTES = 64 * 1024;

const isMissingError = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

const kindOf = (stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): RecordFileKind => {
  if (stats.isSymbolicLink()) {
    return 'symlink';
  }
  if (stats.isFile()) {
    return 'file';
  }
  if (stats.isDirectory()) {
    return 'directory';
  }
  return 'other';
};

/** `RecordFs` on the local disk. All paths are absolute. */
export class NodeRecordFs implements RecordFs {
  /** @inheritdoc */
  public async lstat(path: string): Promise<RecordFileStat | undefined> {
    try {
      const stats = await lstat(path);
      return { kind: kindOf(stats), size: stats.size };
    } catch (error) {
      if (isMissingError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  /** @inheritdoc */
  public async realpath(path: string): Promise<string> {
    return realpath(path);
  }

  /** @inheritdoc */
  public async readCapped(path: string, maxBytes: number): Promise<Uint8Array> {
    const handle = await open(path, 'r');
    try {
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (total < maxBytes) {
        const buffer = new Uint8Array(Math.min(READ_CHUNK_BYTES, maxBytes - total));
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
        if (bytesRead === 0) {
          break;
        }
        chunks.push(buffer.subarray(0, bytesRead));
        total += bytesRead;
      }
      const result = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return result;
    } finally {
      await handle.close();
    }
  }

  /** @inheritdoc */
  public async hashFile(path: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk as Buffer);
    }
    return `sha256:${hash.digest('hex')}`;
  }

  /** @inheritdoc */
  public async writeFile(path: string, contents: string): Promise<void> {
    // `wx`: fail when the path exists, so a temp file is never reused. No mode: the umask applies (NFR7.2).
    await writeFile(path, contents, { encoding: 'utf8', flag: 'wx' });
  }

  /** @inheritdoc */
  public async rename(from: string, to: string): Promise<void> {
    await rename(from, to);
  }

  /** @inheritdoc */
  public async unlink(path: string): Promise<void> {
    const stats = await lstat(path);
    if (stats.isDirectory()) {
      const error = new Error(`Refusing to remove a directory: ${path}`) as NodeJS.ErrnoException;
      error.code = 'EISDIR';
      throw error;
    }
    await unlink(path);
  }

  /** @inheritdoc */
  public async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    await mkdir(path, { recursive: opts?.recursive ?? false });
  }

  /** @inheritdoc */
  public async readdir(path: string): Promise<string[]> {
    return readdir(path);
  }

  /** @inheritdoc */
  public async exists(path: string): Promise<boolean> {
    return (await this.lstat(path)) !== undefined;
  }

  /** @inheritdoc */
  public async appendFile(path: string, contents: string): Promise<void> {
    await appendFile(path, contents, 'utf8');
  }
}
