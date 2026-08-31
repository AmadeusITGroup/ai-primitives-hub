import {
  randomBytes,
} from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from 'node:fs/promises';
import * as path from 'node:path';
import type {
  SecurityReportStore,
} from '@ai-primitives-hub/core';

const mode = 0o600;

const ensureRealDirectory = async (directory: string, createMissing: boolean): Promise<void> => {
  const components = path.resolve(directory).split(path.sep);
  let current = components[0] === '' ? path.sep : components[0];
  for (const component of components.slice(current === path.sep ? 1 : 0)) {
    current = path.join(current, component);
    let stat = await lstat(current).catch(() => undefined);
    if (stat === undefined && createMissing) {
      await mkdir(current, { mode: 0o700 });
      stat = await lstat(current);
    }
    if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Report parent is not a real directory: ${directory}`);
    }
  }
};

export class SecureAtomicSecurityReportStore implements SecurityReportStore {
  public constructor(private readonly createParents = false) {}

  public async write(request: Parameters<SecurityReportStore['write']>[0]): Promise<void> {
    const destination = path.resolve(request.destination);
    const parent = path.dirname(destination);
    await ensureRealDirectory(parent, this.createParents);

    const existing = await lstat(destination).catch(() => undefined);
    if (existing?.isSymbolicLink() === true || (existing !== undefined && !existing.isFile())) {
      throw new Error(`Report destination is not a regular file: ${request.destination}`);
    }
    if (existing !== undefined && request.overwrite === 'never') {
      throw new Error(`Report already exists: ${request.destination}`);
    }

    const temporary = path.join(parent, `.${path.basename(destination)}.${randomBytes(16).toString('hex')}.tmp`);
    let handle;
    try {
      handle = await open(temporary, 'wx', mode);
      await handle.writeFile(request.contents, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(temporary, mode);
      const finalState = await lstat(destination).catch(() => undefined);
      if (finalState?.isSymbolicLink() === true || (finalState !== undefined && !finalState.isFile())) {
        throw new Error(`Report destination changed to a non-regular file: ${request.destination}`);
      }
      if (finalState !== undefined && request.overwrite === 'never') {
        throw new Error(`Report already exists: ${request.destination}`);
      }
      await rename(temporary, destination);
    } finally {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      await unlink(temporary).catch(() => undefined);
    }
  }
}
