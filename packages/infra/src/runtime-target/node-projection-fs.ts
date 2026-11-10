/**
 * NodeRuntimeProjectionFileSystem — RuntimeProjectionFileSystem backed by
 * node:fs/promises. Adds lstat/realpath/exact chmod to NodeFileSystem; kept
 * as a separate adapter so the generic FileSystem port stays untouched.
 * @module runtime-target/node-projection-fs
 */
import {
  chmod,
  lstat,
  realpath,
} from 'node:fs/promises';
import type {
  RuntimeLstat,
  RuntimeModeSemantics,
  RuntimeProjectionFileSystem,
} from '@ai-primitives-hub/core';
import {
  NodeFileSystem,
} from '../fs/node-filesystem';

export class NodeRuntimeProjectionFileSystem extends NodeFileSystem implements RuntimeProjectionFileSystem {
  public readonly modeSemantics: RuntimeModeSemantics = process.platform === 'win32' ? 'readonly' : 'posix';
  public async lstat(path: string): Promise<RuntimeLstat> {
    const stats = await lstat(path);
    return {
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      isSymbolicLink: stats.isSymbolicLink(),
      // eslint-disable-next-line no-bitwise -- permission bits only
      mode: stats.mode & 0o777
    };
  }

  public async realpath(path: string): Promise<string> {
    return realpath(path);
  }

  public async chmod(path: string, mode: number): Promise<void> {
    await chmod(path, mode);
  }
}
