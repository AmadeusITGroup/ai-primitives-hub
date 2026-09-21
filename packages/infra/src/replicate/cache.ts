/* eslint-disable @stylistic/max-len, @stylistic/max-statements-per-line -- atomic cache adapter */
import {
  createHash,
} from 'node:crypto';
import {
  promises as fs,
} from 'node:fs';
import * as path from 'node:path';
import type {
  ReplicationCache,
} from './github-release-source';

export class FileReplicationCache implements ReplicationCache {
  public constructor(private readonly root: string) {}
  private file(key: string): string {
    return path.join(this.root, createHash('sha256').update(key).digest('hex'));
  }

  public async get(key: string): Promise<Uint8Array | undefined> {
    try {
      return await fs.readFile(this.file(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      } throw error;
    }
  }

  public async set(key: string, value: Uint8Array): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 }); await fs.chmod(this.root, 0o700); const target = this.file(key); const temporary = `${target}.tmp-${process.pid}-${Date.now()}`; await fs.writeFile(temporary, value, { mode: 0o600 }); await fs.rename(temporary, target); await fs.chmod(target, 0o600);
  }
}
