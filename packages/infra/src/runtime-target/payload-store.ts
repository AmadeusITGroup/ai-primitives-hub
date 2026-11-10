/**
 * PayloadStore — content-addressed payload snapshots kept outside lockfiles.
 * Layout: `<dir>/<payloadId>/payload.json` (identity, manifest, file modes)
 * plus `<dir>/<payloadId>/files/<relative path>` raw bytes. A snapshot is
 * written once (temp directory + rename); an existing payload is never
 * rewritten. A missing payload is reported as `undefined`; a present but
 * malformed one is rejected.
 * @module runtime-target/payload-store
 */
import {
  randomUUID,
} from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import * as path from 'node:path';
import {
  isRuntimeMode,
  isSafeId,
  isSafeRelativePath,
  type RuntimePayloadSnapshot,
  withFileMode,
} from '@ai-primitives-hub/core';

const META_FILE = 'payload.json';
const FILES_DIR = 'files';

interface PayloadMeta {
  payloadId: string;
  sourceId: string;
  manifestId: string;
  version: string;
  manifest: RuntimePayloadSnapshot['manifest'];
  createdAt: string;
  files: Record<string, { mode?: number }>;
}

const isNotFound = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

export class PayloadStore {
  public constructor(private readonly dir: string, private readonly fs: typeof nodeFs = nodeFs) {}

  /**
   * Read a snapshot.
   * @param payloadId Content address.
   * @returns The snapshot, or undefined when it is not stored.
   */
  public async read(payloadId: string): Promise<RuntimePayloadSnapshot | undefined> {
    if (!isSafeId(payloadId)) {
      throw new Error(`unsafe payload id ${String(payloadId)}`);
    }
    const base = path.join(this.dir, payloadId);
    let meta: PayloadMeta;
    try {
      meta = JSON.parse(await this.fs.readFile(path.join(base, META_FILE), 'utf8')) as PayloadMeta;
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw new Error(`payload ${payloadId} is unreadable: ${(error as Error).message}`);
    }
    if (meta.payloadId !== payloadId || meta.files === null || typeof meta.files !== 'object') {
      throw new Error(`payload ${payloadId} metadata does not match its address`);
    }
    const files = new Map<string, Uint8Array>();
    for (const [relative, info] of Object.entries(meta.files)) {
      if (!isSafeRelativePath(relative)) {
        throw new Error(`payload ${payloadId} has unsafe file ${relative}`);
      }
      const bytes = new Uint8Array(await this.fs.readFile(path.join(base, FILES_DIR, ...relative.split('/'))));
      if (info.mode === undefined) {
        files.set(relative, bytes);
      } else {
        if (!isRuntimeMode(info.mode)) {
          throw new Error(`payload ${payloadId} file ${relative} has a bad mode`);
        }
        files.set(relative, withFileMode(bytes, info.mode));
      }
    }
    return {
      payloadId,
      sourceId: meta.sourceId,
      manifestId: meta.manifestId,
      version: meta.version,
      manifest: meta.manifest,
      files,
      createdAt: meta.createdAt
    };
  }

  /**
   * Store a snapshot once; an already stored payload is left untouched.
   * @param snapshot Validated snapshot.
   */
  public async write(snapshot: RuntimePayloadSnapshot): Promise<void> {
    if (!isSafeId(snapshot.payloadId)) {
      throw new Error(`unsafe payload id ${snapshot.payloadId}`);
    }
    const target = path.join(this.dir, snapshot.payloadId);
    try {
      await this.fs.stat(path.join(target, META_FILE));
      return;
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
    await this.fs.mkdir(this.dir, { recursive: true });
    const tmp = path.join(this.dir, `.tmp-${process.pid}-${randomUUID()}`);
    try {
      const meta: PayloadMeta = {
        payloadId: snapshot.payloadId,
        sourceId: snapshot.sourceId,
        manifestId: snapshot.manifestId,
        version: snapshot.version,
        manifest: snapshot.manifest,
        createdAt: snapshot.createdAt,
        files: {}
      };
      for (const [relative, bytes] of snapshot.files) {
        if (!isSafeRelativePath(relative)) {
          throw new Error(`payload ${snapshot.payloadId} has unsafe file ${relative}`);
        }
        const mode = (bytes as { mode?: number }).mode;
        meta.files[relative] = mode === undefined ? {} : { mode };
        const file = path.join(tmp, FILES_DIR, ...relative.split('/'));
        await this.fs.mkdir(path.dirname(file), { recursive: true });
        await this.fs.writeFile(file, bytes, { mode: 0o600 });
      }
      await this.fs.mkdir(tmp, { recursive: true });
      await this.fs.writeFile(path.join(tmp, META_FILE), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
      await this.fs.rename(tmp, target);
    } catch (error) {
      await this.fs.rm(tmp, { recursive: true, force: true });
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOTEMPTY') {
        return;
      }
      throw error;
    }
  }

  /**
   * Stored payload ids (temporary write directories excluded).
   */
  public async list(): Promise<string[]> {
    try {
      const entries = await this.fs.readdir(this.dir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.tmp-')).map((e) => e.name);
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }
      throw error;
    }
  }

  /**
   * Delete a stored payload.
   * @param payloadId Content address.
   */
  public async remove(payloadId: string): Promise<void> {
    if (!isSafeId(payloadId)) {
      throw new Error(`unsafe payload id ${payloadId}`);
    }
    await this.fs.rm(path.join(this.dir, payloadId), { recursive: true, force: true });
  }
}
