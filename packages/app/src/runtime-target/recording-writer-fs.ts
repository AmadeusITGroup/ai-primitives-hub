/**
 * RecordingWriterFs — in-memory WriterFs for planning. Captures exact bytes
 * and mode intent the real FileTreeTargetWriter would write, and rejects
 * conflicting second writes to one destination instead of a Map overwrite.
 * @module runtime-target/recording-writer-fs
 */
import type {
  ExtractedFile,
} from '@ai-primitives-hub/core';
import type {
  WriterFs,
} from '../writers/file-tree-writer';

export interface RecordedWrite {
  bytes: ExtractedFile;
  mode?: number;
}

export class PlannedWriteConflictError extends Error {
  public constructor(
    public readonly path: string,
    public readonly firstSha: string,
    public readonly secondSha: string
  ) {
    super(`conflicting planned writes to ${path} (${firstSha} vs ${secondSha})`);
    this.name = 'PlannedWriteConflictError';
  }
}

const EXEC_MASK = 0o111;

/* eslint-disable @typescript-eslint/member-ordering -- public API kept above private helpers. */
export class RecordingWriterFs implements WriterFs {
  private readonly writes = new Map<string, RecordedWrite>();
  private readonly dirs = new Set<string>();

  public getWrites(): ReadonlyMap<string, RecordedWrite> {
    return this.writes;
  }

  public async writeFile(p: string, contents: string): Promise<void> {
    await this.record(p, new TextEncoder().encode(contents));
  }

  public async writeFileBytes(p: string, bytes: Uint8Array): Promise<void> {
    await this.record(p, bytes);
  }

  public async readFileBytes(p: string): Promise<Uint8Array> {
    const w = this.writes.get(p);
    if (w === undefined) {
      throw new Error(`recording fs: no such file ${p}`);
    }
    return w.bytes;
  }

  public async mkdir(p: string, _opts?: { recursive?: boolean }): Promise<void> {
    this.dirs.add(p);
  }

  public async remove(p: string): Promise<void> {
    this.writes.delete(p);
  }

  public async exists(p: string): Promise<boolean> {
    return this.writes.has(p) || this.dirs.has(p);
  }

  public async setExecutable(p: string, executable: boolean): Promise<void> {
    const w = this.writes.get(p);
    if (w === undefined) {
      return;
    }
    const base = w.mode ?? 0o644;
    // eslint-disable-next-line no-bitwise -- permission bits only
    w.mode = executable ? base | ((base & 0o444) >> 2) : base & ~EXEC_MASK;
  }

  private async record(p: string, bytes: ExtractedFile): Promise<void> {
    const prior = this.writes.get(p);
    if (prior !== undefined && !Buffer.from(prior.bytes).equals(Buffer.from(bytes))) {
      const { createHash } = await import('node:crypto');
      const sha = (b: Uint8Array): string => `sha256:${createHash('sha256').update(b).digest('hex')}`;
      throw new PlannedWriteConflictError(p, sha(prior.bytes), sha(bytes));
    }
    this.writes.set(p, { bytes: new Uint8Array(bytes), ...(prior?.mode === undefined ? {} : { mode: prior.mode }) });
  }
}
