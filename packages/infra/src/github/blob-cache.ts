/**
 * Content-addressed, tamper-resistant cache for GitHub git blobs.
 *
 * Why "git blob SHA"? GitHub's git/blobs endpoint returns content keyed by
 * the SHA1 of `"blob <size>\0<bytes>"` — the same SHA that appears in the
 * git tree object. Caching by this SHA gives us:
 *   1. Free cross-source deduplication (identical bytes share a SHA even
 *      across different repos).
 *   2. A tamper check: we recompute the SHA locally on put() and refuse
 *      content whose SHA doesn't match. This costs ~µs per KiB and
 *      detects a wide class of on-the-wire and on-disk corruption.
 *
 * Writes are "atomic" in the POSIX sense: the bytes land in a temp file,
 * which is then renamed onto the final path so a concurrent reader either
 * sees the full content or nothing at all. It is not a lock — two writers
 * racing on the same sha is fine because their bytes are identical by
 * definition.
 */

import {
  createHash,
} from 'node:crypto';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

const SHARD_PREFIX_LEN = 2;

/**
 * Compute the git blob SHA1 for `bytes`, matching `git hash-object`.
 * @param bytes - Raw file bytes.
 */
export function computeGitBlobSha(bytes: Buffer): string {
  const header = Buffer.from(`blob ${bytes.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(bytes).digest('hex');
}

export interface BlobCacheStats {
  entries: number;
  bytes: number;
}

/* eslint-disable @typescript-eslint/member-ordering -- public API kept above helpers. */
export class BlobCache {
  public constructor(private readonly root: string) {}

  public async get(sha: string): Promise<Buffer | undefined> {
    const file = this.pathFor(sha);
    try {
      return await fsPromises.readFile(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw err;
    }
  }

  public async put(sha: string, bytes: Buffer): Promise<void> {
    const computed = computeGitBlobSha(bytes);
    if (computed !== sha) {
      throw new Error(`sha mismatch: expected ${sha}, got ${computed}`);
    }
    const file = this.pathFor(sha);
    await fsPromises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fsPromises.writeFile(tmp, bytes);
    await fsPromises.rename(tmp, file);
  }

  public async getOrFetch(sha: string, fetcher: () => Promise<Buffer>): Promise<Buffer> {
    const cached = await this.get(sha);
    if (cached) {
      return cached;
    }
    const bytes = await fetcher();
    await this.put(sha, bytes);
    return bytes;
  }

  public async stats(): Promise<BlobCacheStats> {
    let entries = 0;
    let bytes = 0;
    if (!fs.existsSync(this.root)) {
      return { entries, bytes };
    }
    const stack = [this.root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let items: fs.Dirent[];
      try {
        items = await fsPromises.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const it of items) {
        const full = path.join(dir, it.name);
        if (it.isDirectory()) {
          stack.push(full);
        } else if (it.isFile() && !it.name.endsWith('.tmp')) {
          entries += 1;
          const st = await fsPromises.stat(full);
          bytes += st.size;
        }
      }
    }
    return { entries, bytes };
  }

  private pathFor(sha: string): string {
    if (!/^[0-9a-f]{4,}$/i.test(sha)) {
      throw new Error(`invalid sha: ${sha}`);
    }
    const shard = sha.slice(0, SHARD_PREFIX_LEN);
    return path.join(this.root, shard, sha);
  }
}
