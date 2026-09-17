import {
  randomBytes,
} from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import * as path from 'node:path';
import type {
  SecurityReportStore,
} from '@ai-primitives-hub/core';

const mode = 0o600;

const ensureRealDirectory = async (directory: string, createMissing: boolean): Promise<void> => {
  const resolved = path.resolve(directory);
  let stat = await lstat(resolved).catch(() => undefined);
  if (stat === undefined && createMissing) {
    await ensureRealDirectory(path.dirname(resolved), true);
    await mkdir(resolved, { mode: 0o700 });
    stat = await lstat(resolved);
  }
  if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Report parent is not a real directory: ${directory}`);
  }

  // Resolve platform-owned ancestor links such as macOS /var -> /private/var,
  // while still rejecting a symlink at the actual report parent.
  const canonical = await realpath(resolved);
  const canonicalStat = await lstat(canonical);
  if (!canonicalStat.isDirectory()) {
    throw new Error(`Report parent is not a real directory: ${directory}`);
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
