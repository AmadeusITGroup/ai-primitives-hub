/**
 * Append-only JSONL progress log for the hub harvester.
 *
 * Why JSONL: each event is a single `\n`-terminated JSON object, written
 * with `{ flag: 'a' }`. This gives us crash-safety without an external
 * database; a SIGKILL mid-write at worst truncates the final line, which
 * `load()` simply skips.
 *
 * Semantics:
 *   - `recordStart`, `recordDone`, `recordError` append one line each.
 *   - `projectState()` folds the stream into the latest state per
 *     (sourceId, bundleId) — last-write-wins.
 *   - `shouldResume(sourceId, bundleId, commitSha)` returns false iff the
 *     log already contains a `done` event for that exact tuple. This is
 *     the hook the harvester uses to skip unchanged bundles.
 *   - `summary()` aggregates counts for a human-readable report.
 */

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

export type ProgressKind = 'start' | 'done' | 'error' | 'skip';

interface BaseEvent {
  kind: ProgressKind;
  sourceId: string;
  bundleId: string;
  commitSha: string;
  ts: number;
}
export interface StartEvent extends BaseEvent { kind: 'start' }
export interface DoneEvent extends BaseEvent {
  kind: 'done';
  primitives: number;
  ms: number;
}
export interface ErrorEvent extends BaseEvent {
  kind: 'error';
  error: string;
}
export interface SkipEvent extends BaseEvent {
  kind: 'skip';
  reason: string;
}
export type ProgressEvent = StartEvent | DoneEvent | ErrorEvent | SkipEvent;

export interface BundleState {
  sourceId: string;
  bundleId: string;
  commitSha: string;
  status: ProgressKind;
  primitives?: number;
  ms?: number;
  error?: string;
  reason?: string;
  ts: number;
}

export interface ProgressSummary {
  start: number;
  done: number;
  error: number;
  skip: number;
  /** Total primitives across all successful bundles (sum of done.primitives). */
  primitives: number;
  /** Total ms across all successful bundles (sum of done.ms). */
  wallMs: number;
}

/* eslint-disable @typescript-eslint/member-ordering -- public API kept above private helpers for readability. */
export class HarvestProgressLog {
  private readonly state = new Map<string, BundleState>();
  private fd: fs.promises.FileHandle | undefined;

  private constructor(private readonly file: string) {}

  /**
   * Open (or create) a log file. Loads existing events into memory and
   * keeps the file handle open for subsequent appends.
   * @param file - Absolute path to the JSONL file.
   */
  public static async open(file: string): Promise<HarvestProgressLog> {
    await fsPromises.mkdir(path.dirname(file), { recursive: true });
    const log = new HarvestProgressLog(file);
    await log.load();
    log.fd = await fsPromises.open(file, 'a');
    return log;
  }

  public async recordStart(ev: Omit<StartEvent, 'kind' | 'ts'>): Promise<void> {
    await this.append({ ...ev, kind: 'start', ts: Date.now() });
  }

  public async recordDone(ev: Omit<DoneEvent, 'kind' | 'ts'>): Promise<void> {
    await this.append({ ...ev, kind: 'done', ts: Date.now() });
  }

  public async recordError(ev: Omit<ErrorEvent, 'kind' | 'ts'>): Promise<void> {
    await this.append({ ...ev, kind: 'error', ts: Date.now() });
  }

  public async recordSkip(ev: Omit<SkipEvent, 'kind' | 'ts'>): Promise<void> {
    await this.append({ ...ev, kind: 'skip', ts: Date.now() });
  }

  public shouldResume(sourceId: string, bundleId: string, commitSha: string): boolean {
    const cur = this.state.get(keyOf(sourceId, bundleId));
    if (!cur) {
      return true;
    }
    return !(cur.status === 'done' && cur.commitSha === commitSha);
  }

  public projectState(): Map<string, BundleState> {
    return new Map(this.state);
  }

  public summary(): ProgressSummary {
    let start = 0;
    let done = 0;
    let error = 0;
    let skip = 0;
    let primitives = 0;
    let wallMs = 0;
    for (const s of this.state.values()) {
      switch (s.status) {
        case 'start': {
          start += 1;

          break;
        }
        case 'done': {
          done += 1;
          primitives += s.primitives ?? 0;
          wallMs += s.ms ?? 0;

          break;
        }
        case 'error': {
          error += 1;

          break;
        }
        case 'skip': {
          skip += 1;

          break;
        }
      // No default
      }
    }
    return { start, done, error, skip, primitives, wallMs };
  }

  public async close(): Promise<void> {
    if (this.fd) {
      await this.fd.close();
      this.fd = undefined;
    }
  }

  private async append(ev: ProgressEvent): Promise<void> {
    if (!this.fd) {
      throw new Error('progress-log is not open');
    }
    const line = JSON.stringify(ev) + '\n';
    await this.fd.write(line);
    this.apply(ev);
  }

  private apply(ev: ProgressEvent): void {
    const k = keyOf(ev.sourceId, ev.bundleId);
    const prev = this.state.get(k);
    // Event precedence: done/error/skip overwrite any prior state.
    // `start` only sets state if there wasn't one already (so a replay of
    // an old start cannot undo a done).
    if (ev.kind === 'start' && prev?.status === 'done' && prev?.commitSha === ev.commitSha) {
      return;
    }
    const next: BundleState = {
      sourceId: ev.sourceId,
      bundleId: ev.bundleId,
      commitSha: ev.commitSha,
      status: ev.kind,
      ts: ev.ts,
      primitives: ev.kind === 'done' ? ev.primitives : prev?.primitives,
      ms: ev.kind === 'done' ? ev.ms : prev?.ms,
      error: ev.kind === 'error' ? ev.error : undefined,
      reason: ev.kind === 'skip' ? ev.reason : undefined
    };
    this.state.set(k, next);
  }

  private async load(): Promise<void> {
    if (!fs.existsSync(this.file)) {
      return;
    }
    const raw = await fsPromises.readFile(this.file, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      try {
        const ev = JSON.parse(line) as ProgressEvent;
        if (this.isValidEvent(ev)) {
          this.apply(ev);
        }
      } catch {
        // Corrupt or truncated line — skip and continue.
      }
    }
  }

  private isValidEvent(ev: unknown): ev is ProgressEvent {
    if (!ev || typeof ev !== 'object') {
      return false;
    }
    const e = ev as Partial<BaseEvent>;
    return (
      typeof e.kind === 'string'
      && typeof e.sourceId === 'string'
      && typeof e.bundleId === 'string'
      && typeof e.commitSha === 'string'
    );
  }
}

function keyOf(sourceId: string, bundleId: string): string {
  return `${sourceId}/${bundleId}`;
}
