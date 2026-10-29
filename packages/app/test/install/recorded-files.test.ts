/**
 * Tests for app/install/recorded-files.ts (`locateRecord`).
 */
import * as path from 'node:path';
import type {
  Target,
  TargetWriter,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  locateRecord,
} from '../../src/install/recorded-files';
import {
  createTargetWriterFactory,
} from '../../src/install/target-writer-factory';
import type {
  InstallRecord,
} from '../../src/stores/install-record-store';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

const vscodeRepo: Target = { name: 'v', type: 'vscode', scope: 'repository', rootPath: '/ws', commitMode: 'commit' };
const factory = createTargetWriterFactory({
  fs: new InMemoryFileSystem(), env: { HOME: '/home/u' }, projectDir: null, userConfigDir: null, writerOwnsExclusion: false
});
const record = (targetType: string | undefined, files: string[] = ['prompts/a.prompt.md']): InstallRecord => ({
  entry: {
    version: '1.0.0',
    sourceId: 's',
    sourceType: 'local',
    installedAt: '2026-01-01T00:00:00.000Z',
    ...(targetType === undefined ? {} : { targetType }),
    files: files.map((p) => ({ path: p, checksum: '0'.repeat(64) }))
  },
  commitMode: 'local-only'
});

describe('locateRecord', () => {
  it('locates with the writer of the recorded target type and the record commit mode', async () => {
    const located = await locateRecord(factory, vscodeRepo, record('kiro', ['prompts/a.prompt.md', 'README.md']));

    expect(located.kind).toBe('located');
    if (located.kind !== 'located') {
      return;
    }
    expect(located.target).toMatchObject({ type: 'kiro', scope: 'repository', rootPath: '/ws', commitMode: 'local-only' });
    expect(located.located).toEqual({
      root: path.join('/ws', '.kiro'),
      paths: [path.join('/ws', '.kiro', 'steering', 'a.prompt.md'), null]
    });
  });

  it('locates a record of another target type at that type\'s base directory, not at the caller\'s path', async () => {
    const vscodeUser: Target = { name: 'v', type: 'vscode', scope: 'user', path: '/custom/vscode', allowedKinds: ['agent'] };

    const located = await locateRecord(factory, vscodeUser, { entry: record('kiro').entry });

    expect(located.kind).toBe('located');
    if (located.kind !== 'located') {
      return;
    }
    expect(located.target).toEqual({ name: 'v', type: 'kiro', scope: 'user' });
    expect(located.located).toEqual({
      root: path.join('/home/u', '.kiro'),
      paths: [path.join('/home/u', '.kiro', 'steering', 'a.prompt.md')]
    });
  });

  it('honours the caller\'s path and allowed kinds for a record of the caller\'s target type', async () => {
    const kiroUser: Target = { name: 'k', type: 'kiro', scope: 'user', path: '/custom/kiro', allowedKinds: ['prompt'] };

    const located = await locateRecord(factory, kiroUser, { entry: record('kiro').entry });

    expect(located.kind).toBe('located');
    if (located.kind !== 'located') {
      return;
    }
    expect(located.target).toEqual(kiroUser);
    expect(located.located).toEqual({
      root: path.join('/custom/kiro'),
      paths: [path.join('/custom/kiro', 'steering', 'a.prompt.md')]
    });
  });

  it('uses the caller target type when the record has none', async () => {
    const located = await locateRecord(factory, vscodeRepo, record(undefined));

    expect(located.kind === 'located' && located.located.paths).toEqual([path.join('/ws', '.github', 'prompts', 'a.prompt.md')]);
  });

  it('is unresolvable for an unknown target type', async () => {
    expect(await locateRecord(factory, vscodeRepo, record('emacs'))).toEqual({
      kind: 'unresolvable',
      reason: 'unknown target type "emacs"'
    });
  });

  it('is unresolvable when locate throws', async () => {
    const writer: TargetWriter = {
      write: () => Promise.resolve({ written: [], skipped: [] }),
      remove: () => Promise.resolve(),
      locate: () => Promise.reject(new Error('No layout defined for target type "vscode"'))
    };

    expect(await locateRecord(() => writer, vscodeRepo, record('vscode'))).toEqual({
      kind: 'unresolvable',
      reason: 'No layout defined for target type "vscode"'
    });
  });

  it('is unresolvable when the writer factory throws', async () => {
    const located = await locateRecord(factory, { name: 'v', type: 'vscode', scope: 'repository' }, record('vscode'));

    expect(located).toEqual({ kind: 'unresolvable', reason: 'repository target needs rootPath' });
  });

  it('reports a writer without locate', async () => {
    const writer: TargetWriter = { write: () => Promise.resolve({ written: [], skipped: [] }), remove: () => Promise.resolve() };

    const located = await locateRecord(() => writer, vscodeRepo, record('vscode'));

    expect(located.kind).toBe('no-locate');
  });
});
