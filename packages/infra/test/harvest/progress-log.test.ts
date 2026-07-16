import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  HarvestProgressLog,
} from '../../src/harvest/progress-log';
import {
  createTempDir,
} from '../helpers/temp-dir';

let tmp: string;
let cleanup: () => void;

beforeEach(() => {
  [tmp, cleanup] = createTempDir('pi-progress-');
});

afterEach(() => {
  cleanup();
});

describe('progress-log', () => {
  it('appends JSONL events and reloads projected state', async () => {
    const file = path.join(tmp, 'run.jsonl');
    const log = await HarvestProgressLog.open(file);
    await log.recordStart({ sourceId: 'src-a', bundleId: 'b1', commitSha: 'aaa' });
    await log.recordDone({ sourceId: 'src-a', bundleId: 'b1', commitSha: 'aaa', primitives: 7, ms: 123 });
    await log.close();

    const reloaded = await HarvestProgressLog.open(file);
    const state = reloaded.projectState();
    expect(state.get('src-a/b1')?.status).toBe('done');
    expect(state.get('src-a/b1')?.commitSha).toBe('aaa');
    expect(state.get('src-a/b1')?.primitives).toBe(7);
    await reloaded.close();
  });

  it('shouldResume returns false when the bundle is complete at the same SHA', async () => {
    const file = path.join(tmp, 'run.jsonl');
    const log = await HarvestProgressLog.open(file);
    await log.recordDone({ sourceId: 's', bundleId: 'b', commitSha: 'sha1', primitives: 1, ms: 1 });
    expect(log.shouldResume('s', 'b', 'sha1')).toBe(false);
    expect(log.shouldResume('s', 'b', 'sha2')).toBe(true);
    expect(log.shouldResume('s', 'other', 'sha1')).toBe(true);
    await log.close();
  });

  it('tolerates (skips) a corrupt line without aborting load', async () => {
    const file = path.join(tmp, 'run.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ kind: 'start', sourceId: 's', bundleId: 'b1', commitSha: 'x', ts: 1 }),
        '{"this is corrupt',
        JSON.stringify({ kind: 'done', sourceId: 's', bundleId: 'b1', commitSha: 'x', primitives: 3, ms: 2, ts: 2 })
      ].join('\n') + '\n',
      'utf8'
    );
    const log = await HarvestProgressLog.open(file);
    const state = log.projectState();
    expect(state.get('s/b1')?.status).toBe('done');
    await log.close();
  });

  it('records error events and surfaces them in the projected state', async () => {
    const file = path.join(tmp, 'run.jsonl');
    const log = await HarvestProgressLog.open(file);
    await log.recordError({ sourceId: 's', bundleId: 'b1', commitSha: 'x', error: 'boom' });
    const st = log.projectState().get('s/b1');
    expect(st?.status).toBe('error');
    expect(st?.error).toBe('boom');
    await log.recordDone({ sourceId: 's', bundleId: 'b1', commitSha: 'x', primitives: 4, ms: 5 });
    expect(log.projectState().get('s/b1')?.status).toBe('done');
    await log.close();
  });

  it('summary() aggregates counts per status', async () => {
    const file = path.join(tmp, 'run.jsonl');
    const log = await HarvestProgressLog.open(file);
    await log.recordDone({ sourceId: 's', bundleId: 'a', commitSha: 'x', primitives: 2, ms: 1 });
    await log.recordDone({ sourceId: 's', bundleId: 'b', commitSha: 'x', primitives: 3, ms: 1 });
    await log.recordError({ sourceId: 's', bundleId: 'c', commitSha: 'x', error: 'net' });
    const s = log.summary();
    expect(s.done).toBe(2);
    expect(s.error).toBe(1);
    expect(s.primitives).toBe(5);
    await log.close();
  });
});
