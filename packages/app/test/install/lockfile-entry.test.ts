/**
 * Tests for app/install/lockfile-entry.ts.
 */
import {
  createHash,
} from 'node:crypto';
import * as path from 'node:path';
import type {
  Target,
  TargetWriter,
} from '@ai-primitives-hub/core';
import {
  validateManifest,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  buildLockfileBundleEntry,
  computeInstalledChecksums,
} from '../../src/install/lockfile-entry';
import {
  writeBundleForInstall,
} from '../../src/install/partial-target-write';
import {
  createTargetWriterFactory,
} from '../../src/install/target-writer-factory';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const NOW = new Date('2026-01-02T03:04:05.000Z');

const AGENT = '---\ndescription: Helps\n---\n# Helper\n';
const bundle = (): Map<string, Uint8Array> => new Map([
  ['deployment-manifest.yml', text([
    'id: sample',
    'version: 1.2.3',
    'name: Sample',
    'prompts:',
    '  - id: hello',
    '    file: prompts/hello.prompt.md',
    '    type: prompt',
    '  - id: nested',
    '    file: prompts/sub/nested.prompt.md',
    '    type: prompt',
    '  - id: code-helper',
    '    file: agents/code-helper.md',
    '    type: agent',
    ''
  ].join('\n'))],
  ['prompts/hello.prompt.md', text('# Hello\n')],
  ['prompts/sub/nested.prompt.md', text('# Nested\n')],
  ['agents/code-helper.md', text(AGENT)]
]);

const install = async (target: Target) => {
  const fs = new InMemoryFileSystem();
  const writer = createTargetWriterFactory({
    fs, env: { HOME: '/home/u' }, projectDir: null, userConfigDir: null, writerOwnsExclusion: false
  })(target);
  const files = bundle();
  const write = await writeBundleForInstall(writer, target, files, validateManifest(files, {}));
  const installedChecksums = await computeInstalledChecksums({ writer, target, write, fs });
  return { fs, writer, write, installedChecksums };
};

describe('buildLockfileBundleEntry', () => {
  it('records the target type and the written files, without commitMode or installedChecksum for vscode', async () => {
    const target: Target = { name: 'v', type: 'vscode', scope: 'repository', rootPath: '/ws', commitMode: 'local-only' };
    const { write, installedChecksums } = await install(target);

    const entry = buildLockfileBundleEntry({
      version: '1.2.3',
      sourceId: 'local-sample',
      sourceType: 'local',
      checksum: 'a'.repeat(64),
      targetType: target.type,
      write,
      installedChecksums,
      now: NOW
    });

    expect(entry).toEqual({
      version: '1.2.3',
      sourceId: 'local-sample',
      sourceType: 'local',
      checksum: 'a'.repeat(64),
      installedAt: NOW.toISOString(),
      targetType: 'vscode',
      files: [
        { path: 'prompts/hello.prompt.md', checksum: sha256(text('# Hello\n')) },
        { path: 'prompts/sub/nested.prompt.md', checksum: sha256(text('# Nested\n')), installedPath: 'prompts/nested.prompt.md' },
        { path: 'agents/code-helper.md', checksum: sha256(text(AGENT)) }
      ]
    });
    expect(entry).not.toHaveProperty('commitMode');
  });

  it('records installedChecksum for a file a kiro transformer rewrote', async () => {
    const target: Target = { name: 'k', type: 'kiro', scope: 'user' };
    const { fs, write, installedChecksums } = await install(target);

    const entry = buildLockfileBundleEntry({
      version: '1.2.3', sourceId: 'local-sample', sourceType: 'local', targetType: target.type, write, installedChecksums, now: NOW
    });

    const agent = entry.files.find((file) => file.path === 'agents/code-helper.md');
    const onDisk = await fs.readFileBytes(path.join('/home/u', '.kiro', 'agents', 'code-helper.agent.md'));
    expect(new TextDecoder().decode(onDisk)).toContain('name:');
    expect(agent?.installedChecksum).toBe(sha256(onDisk));
    expect(agent?.checksum).toBe(sha256(text(AGENT)));
    expect(entry.files.filter((file) => file.installedChecksum !== undefined)).toHaveLength(1);
    expect(entry.targetType).toBe('kiro');
  });

  it('omits checksum when none is given', async () => {
    const target: Target = { name: 'v', type: 'vscode', scope: 'user' };
    const { write, installedChecksums } = await install(target);

    const entry = buildLockfileBundleEntry({
      version: '1.2.3', sourceId: 'local-sample', sourceType: 'local', targetType: target.type, write, installedChecksums, now: NOW
    });

    expect(entry).not.toHaveProperty('checksum');
  });
});

describe('computeInstalledChecksums', () => {
  it('hashes each written file where the writer located it', async () => {
    const target: Target = { name: 'v', type: 'vscode', scope: 'repository', rootPath: '/ws' };
    const { installedChecksums } = await install(target);

    expect(installedChecksums).toEqual(new Map([
      ['prompts/hello.prompt.md', sha256(text('# Hello\n'))],
      ['prompts/sub/nested.prompt.md', sha256(text('# Nested\n'))],
      ['agents/code-helper.md', sha256(text(AGENT))]
    ]));
  });

  it('returns an empty map for a writer that cannot locate files', async () => {
    const target: Target = { name: 'v', type: 'vscode', scope: 'user' };
    const { fs, write } = await install(target);
    const writer: TargetWriter = { write: () => Promise.resolve({ written: [], skipped: [] }), remove: () => Promise.resolve() };

    expect(await computeInstalledChecksums({ writer, target, write, fs })).toEqual(new Map());
  });
});
