/**
 * Tests for app/install/apply-bundle-uninstall.ts.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  FileSystem,
  RepositoryExclusion,
  Target,
  TargetWriter,
} from '@ai-primitives-hub/core';
import {
  validateManifest,
} from '@ai-primitives-hub/core';
import {
  GitInfoExclude,
  NodeFileSystem,
} from '@ai-primitives-hub/infra';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  applyBundleUninstall,
} from '../../src/install/apply-bundle-uninstall';
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
  createLockfileRecordStore,
  type InstallRecordStore,
} from '../../src/stores/install-record-store';
import {
  LOCKFILE_NAME,
  type LockfileBundleEntry,
} from '../../src/stores/json-lockfile-store';
import {
  makeGitDir,
} from '../helpers/git-dir';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

const posixOnly = it.skipIf(process.platform === 'win32');
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const SOURCE = { id: 'local-src', descriptor: { type: 'local', url: '/bundles' } };

interface Item { id: string; file: string; type: string }

/**
 * A bundle with a deployment manifest listing its items.
 * @param id Bundle id.
 * @param files Bundle files and their content.
 * @param items Manifest items.
 * @returns Extracted files.
 */
const bundleOf = (id: string, files: Record<string, string>, items: Item[]): Map<string, Uint8Array> => new Map([
  ['deployment-manifest.yml', text([
    `id: ${id}`,
    'version: 1.0.0',
    `name: ${id}`,
    'prompts:',
    ...items.flatMap((item) => [`  - id: ${item.id}`, `    file: ${item.file}`, `    type: ${item.type}`]),
    ''
  ].join('\n'))],
  ...Object.entries(files).map(([p, content]): [string, Uint8Array] => [p, text(content)])
]);

const prompts = (id: string, names: string[]): Map<string, Uint8Array> => bundleOf(
  id,
  Object.fromEntries(names.map((name) => [`prompts/${name}.prompt.md`, `# ${name}\n`])),
  names.map((name) => ({ id: name, file: `prompts/${name}.prompt.md`, type: 'prompt' }))
);

const factoryFor = (fs: FileSystem, home = '/home/u') => createTargetWriterFactory({
  fs, env: { HOME: home }, projectDir: null, userConfigDir: null, writerOwnsExclusion: false
});

/**
 * Install a bundle and record it, as the install use case does.
 * @param input Install inputs.
 * @param input.fs Filesystem.
 * @param input.store Record store.
 * @param input.factory Writer factory.
 * @param input.target Target.
 * @param input.key Record key.
 * @param input.files Bundle.
 * @returns Absolute paths written.
 */
const record = async (input: {
  fs: FileSystem;
  store: InstallRecordStore;
  factory: (target: Target) => TargetWriter;
  target: Target;
  key: string;
  files: Map<string, Uint8Array>;
}): Promise<string[]> => {
  const writer = input.factory(input.target);
  const write = await writeBundleForInstall(writer, input.target, input.files, validateManifest(input.files, {}));
  const installedChecksums = await computeInstalledChecksums({ writer, target: input.target, write, fs: input.fs });
  const entry = buildLockfileBundleEntry({
    version: '1.0.0', sourceId: SOURCE.id, sourceType: 'local', targetType: input.target.type, write, installedChecksums, now: new Date()
  });
  await input.store.put(input.key, entry, SOURCE, input.target.commitMode);
  return write.result.written;
};

const handEdited = (files: { path: string; installedPath?: string }[], targetType?: string): LockfileBundleEntry => ({
  version: '1.0.0',
  sourceId: SOURCE.id,
  sourceType: 'local',
  installedAt: '2026-01-01T00:00:00.000Z',
  ...(targetType === undefined ? {} : { targetType }),
  files: files.map((file) => ({ ...file, checksum: '0'.repeat(64) }))
});

const NO_GIT: RepositoryExclusion = { add: () => Promise.resolve(), remove: () => Promise.resolve(), isAvailable: () => Promise.resolve(false) };

describe('applyBundleUninstall (in-memory)', () => {
  const vscodeRepo: Target = { name: 'v', type: 'vscode', scope: 'repository', rootPath: '/ws', commitMode: 'commit' };
  const github = (...segments: string[]): string => path.join('/ws', '.github', ...segments);
  let fs: InMemoryFileSystem;
  let store: InstallRecordStore;

  beforeEach(() => {
    fs = new InMemoryFileSystem();
    store = createLockfileRecordStore({ scope: 'repository', fs, rootPath: '/ws', generatedBy: 'test', exclusion: NO_GIT });
  });

  const uninstall = (key: string, overrides: Partial<Parameters<typeof applyBundleUninstall>[0]> = {}) => applyBundleUninstall({
    writerFactory: factoryFor(fs), target: vscodeRepo, key, store, exclusion: NO_GIT, fs, preserveModified: false, ...overrides
  });

  it('returns an empty result when nothing is recorded', async () => {
    expect(await uninstall('missing')).toEqual({
      removed: [], kept: [], refused: [], missing: [], errors: [], pruned: [], exclusionSkipped: false, exclusionErrors: []
    });
  });

  it('removes recorded files and keeps a location another record holds', async () => {
    await record({ fs, store, factory: factoryFor(fs), target: vscodeRepo, key: 'a', files: prompts('a', ['shared', 'only-a']) });
    await record({ fs, store, factory: factoryFor(fs), target: vscodeRepo, key: 'b', files: prompts('b', ['shared']) });

    const result = await uninstall('a');

    expect(result.removed).toEqual(['prompts/only-a.prompt.md']);
    expect(result.kept).toEqual([{ path: 'prompts/shared.prompt.md', reason: 'shared' }]);
    expect(await fs.exists(github('prompts', 'shared.prompt.md'))).toBe(true);
    expect(await fs.exists(github('prompts', 'only-a.prompt.md'))).toBe(false);
    expect(await store.get('a')).toBeUndefined();
    expect(await store.get('b')).toBeDefined();
  });

  it('refuses recorded paths with no location inside the target root', async () => {
    const outside = [path.join('/ws', 'outside.md'), path.join('/', 'outside.md'), path.join('/ws', 'README.md')];
    for (const file of outside) {
      fs.seed(file, '# Keep');
    }
    await store.put('edited', handEdited([
      { path: '../outside.md' },
      { path: path.join('/', 'outside.md') },
      { path: 'README.md' },
      { path: 'prompts/x.prompt.md', installedPath: '../../outside.md' }
    ], 'vscode'), SOURCE);

    const result = await uninstall('edited');

    expect(result.refused).toEqual(['../outside.md', path.join('/', 'outside.md'), 'README.md', 'prompts/x.prompt.md']);
    expect(result.removed).toEqual([]);
    for (const file of outside) {
      expect(await fs.exists(file), file).toBe(true);
    }
    expect(await store.get('edited')).toBeUndefined();
  });

  it('removes a legacy workspace-relative entry', async () => {
    fs.seed(github('prompts', 'old.prompt.md'), '# Old');
    await store.put('legacy', handEdited([{ path: '.github/prompts/old.prompt.md' }]), SOURCE);

    const result = await uninstall('legacy');

    expect(result.removed).toEqual(['.github/prompts/old.prompt.md']);
    expect(await fs.exists(github('prompts', 'old.prompt.md'))).toBe(false);
  });

  it('locates a kiro entry from a vscode target through its targetType', async () => {
    const kiroRepo: Target = { ...vscodeRepo, type: 'kiro' };
    const written = await record({ fs, store, factory: factoryFor(fs), target: kiroRepo, key: 'k', files: prompts('k', ['hello']) });
    expect(written).toEqual([path.join('/ws', '.kiro', 'steering', 'hello.prompt.md')]);

    const result = await uninstall('k');

    expect(result.removed).toEqual(['prompts/hello.prompt.md']);
    expect(await fs.exists(written[0])).toBe(false);
  });

  it('keeps an edited file with preserveModified and removes an unedited one (vscode)', async () => {
    await record({ fs, store, factory: factoryFor(fs), target: vscodeRepo, key: 'a', files: prompts('a', ['edited', 'pristine']) });
    fs.seed(github('prompts', 'edited.prompt.md'), '# changed by the user\n');

    const result = await uninstall('a', { preserveModified: true });

    expect(result.kept).toEqual([{ path: 'prompts/edited.prompt.md', reason: 'modified' }]);
    expect(result.removed).toEqual(['prompts/pristine.prompt.md']);
    expect(await fs.exists(github('prompts', 'edited.prompt.md'))).toBe(true);
  });

  it('compares a transformed kiro file against its installedChecksum', async () => {
    const kiroUser: Target = { name: 'k', type: 'kiro', scope: 'user' };
    const userStore = createLockfileRecordStore({ scope: 'user', fs, lockfilePath: '/home/u/lock.json', generatedBy: 'test' });
    const files = bundleOf('k', {
      'agents/edited.md': '---\ndescription: Edited\n---\n# Edited\n',
      'agents/pristine.md': '---\ndescription: Pristine\n---\n# Pristine\n'
    }, [
      { id: 'edited', file: 'agents/edited.md', type: 'agent' },
      { id: 'pristine', file: 'agents/pristine.md', type: 'agent' }
    ]);
    const written = await record({ fs, store: userStore, factory: factoryFor(fs), target: kiroUser, key: 'k', files });
    const entry = (await userStore.get('k'))?.entry;
    expect(entry?.files.every((file) => file.installedChecksum !== undefined)).toBe(true);
    const edited = written.find((p) => p.includes('edited')) as string;
    fs.seed(edited, '# changed by the user\n');

    const result = await applyBundleUninstall({
      writerFactory: factoryFor(fs), target: kiroUser, key: 'k', store: userStore, exclusion: null, fs, preserveModified: true
    });

    expect(result.kept).toEqual([{ path: 'agents/edited.md', reason: 'modified' }]);
    expect(result.removed).toEqual(['agents/pristine.md']);
  });

  it('refuses every file of a record with an unknown target type and still removes the record', async () => {
    fs.seed(github('prompts', 'a.prompt.md'), '# A');
    await store.put('emacs', handEdited([{ path: 'prompts/a.prompt.md' }], 'emacs'), SOURCE);

    const result = await uninstall('emacs');

    expect(result.refused).toEqual(['prompts/a.prompt.md']);
    expect(result.unresolvable).toBe('unknown target type "emacs"');
    expect(await fs.exists(github('prompts', 'a.prompt.md'))).toBe(true);
    expect(await store.get('emacs')).toBeUndefined();
  });

  it('refuses every file when the writer cannot locate them', async () => {
    fs.seed(github('prompts', 'a.prompt.md'), '# A');
    await store.put('a', handEdited([{ path: 'prompts/a.prompt.md' }], 'vscode'), SOURCE);
    const throwing: TargetWriter = {
      write: () => Promise.resolve({ written: [], skipped: [] }),
      remove: (_target, p) => fs.remove(github(p)),
      locate: () => Promise.reject(new Error('layout failed'))
    };

    const result = await uninstall('a', { writerFactory: () => throwing });

    expect(result.refused).toEqual(['prompts/a.prompt.md']);
    expect(result.unresolvable).toBe('layout failed');
    expect(await fs.exists(github('prompts', 'a.prompt.md'))).toBe(true);
    expect(await store.get('a')).toBeUndefined();
  });

  it('removes every file through a writer without locate, unguarded', async () => {
    await record({ fs, store, factory: factoryFor(fs), target: vscodeRepo, key: 'a', files: prompts('a', ['shared', 'only-a']) });
    await record({ fs, store, factory: factoryFor(fs), target: vscodeRepo, key: 'b', files: prompts('b', ['shared']) });
    const removed: string[] = [];
    const custom: TargetWriter = {
      write: () => Promise.resolve({ written: [], skipped: [] }),
      remove: (_target, p) => {
        removed.push(p);
        return Promise.resolve();
      }
    };

    const result = await uninstall('a', { writerFactory: () => custom });

    expect(removed).toEqual(['prompts/only-a.prompt.md', 'prompts/shared.prompt.md']);
    expect(result.removed).toEqual(removed);
    expect(result.kept).toEqual([]);
    expect(result.pruned).toEqual([]);
  });

  it('reports a failing removal and goes on with the other files', async () => {
    await record({ fs, store, factory: factoryFor(fs), target: vscodeRepo, key: 'a', files: prompts('a', ['bad', 'good']) });
    const real = factoryFor(fs);
    const failing = (target: Target): TargetWriter => {
      const writer = real(target);
      return {
        write: (t, files) => writer.write(t, files),
        locate: (t, files) => (writer.locate as NonNullable<TargetWriter['locate']>)(t, files),
        remove: (t, p, installedPath) => (p.includes('bad') ? Promise.reject(new Error('EACCES')) : writer.remove(t, p, installedPath))
      };
    };

    const result = await uninstall('a', { writerFactory: failing });

    expect(result.errors).toEqual([{ path: 'prompts/bad.prompt.md', message: 'EACCES' }]);
    expect(result.removed).toEqual(['prompts/good.prompt.md']);
    expect(await store.get('a')).toBeUndefined();
  });

  it('skips exclusion outside a git repository for a local-only record', async () => {
    const local: Target = { ...vscodeRepo, commitMode: 'local-only' };
    await record({ fs, store, factory: factoryFor(fs), target: local, key: 'a', files: prompts('a', ['x']) });

    const result = await uninstall('a', { target: local, exclusion: new GitInfoExclude({ fs, workspaceRoot: '/ws' }) });

    expect(result.removed).toEqual(['prompts/x.prompt.md']);
    expect(result.exclusionSkipped).toBe(true);
    expect(await fs.exists(path.join('/ws', '.git'))).toBe(false);
  });

  it('reports a failing exclusion update and still uninstalls', async () => {
    const local: Target = { ...vscodeRepo, commitMode: 'local-only' };
    await record({ fs, store, factory: factoryFor(fs), target: local, key: 'a', files: prompts('a', ['x']) });
    const failing: RepositoryExclusion = { add: () => Promise.resolve(), remove: () => Promise.reject(new Error('exclude unwritable')) };

    const result = await uninstall('a', { target: local, exclusion: failing });

    expect(result.removed).toEqual(['prompts/x.prompt.md']);
    expect(result.exclusionErrors).toEqual(['exclude unwritable']);
    expect(await store.get('a')).toBeUndefined();
  });
});

describe('applyBundleUninstall (on disk)', () => {
  let tmp: string;
  let ws: string;
  let home: string;
  const nodeFs = new NodeFileSystem();

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'apply-uninstall-'));
    ws = path.join(tmp, 'ws');
    home = path.join(tmp, 'home');
    mkdirSync(ws, { recursive: true });
    mkdirSync(home, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const repoStore = (exclusion: RepositoryExclusion = NO_GIT): InstallRecordStore =>
    createLockfileRecordStore({ scope: 'repository', fs: nodeFs, rootPath: ws, generatedBy: 'test', exclusion });

  const plugin = (): Map<string, Uint8Array> => bundleOf('demo', {
    'plugins/demo-plugin/plugin.json': '{"name":"demo-plugin"}',
    'plugins/demo-plugin/scripts/run.sh': '#!/bin/sh\n',
    'plugins/demo-plugin/skills/helper/SKILL.md': '# Helper\n'
  }, [{ id: 'demo-plugin', file: 'plugins/demo-plugin/plugin.json', type: 'plugin' }]);

  it('prunes the directories a plugin uninstall leaves empty, never the root', async () => {
    const target: Target = { name: 'v', type: 'vscode', scope: 'repository', rootPath: ws, commitMode: 'commit' };
    const store = repoStore();
    await record({ fs: nodeFs, store, factory: factoryFor(nodeFs, home), target, key: 'demo', files: plugin() });

    const result = await applyBundleUninstall({
      writerFactory: factoryFor(nodeFs, home), target, key: 'demo', store, exclusion: NO_GIT, fs: nodeFs, preserveModified: false
    });

    const github = path.join(ws, '.github');
    expect(result.removed).toHaveLength(3);
    expect(result.pruned).toEqual(expect.arrayContaining([
      path.join(github, 'plugins', 'demo-plugin', 'scripts'),
      path.join(github, 'plugins', 'demo-plugin', 'skills', 'helper'),
      path.join(github, 'plugins', 'demo-plugin', 'skills'),
      path.join(github, 'plugins', 'demo-plugin'),
      path.join(github, 'plugins')
    ]));
    expect(result.pruned).not.toContain(github);
    expect(existsSync(path.join(github, 'plugins'))).toBe(false);
    expect(existsSync(github)).toBe(true);
    expect(existsSync(path.join(ws, LOCKFILE_NAME))).toBe(false);
  });

  it('stops pruning at a directory that still holds files', async () => {
    const target: Target = { name: 'v', type: 'vscode', scope: 'repository', rootPath: ws, commitMode: 'commit' };
    const store = repoStore();
    await record({ fs: nodeFs, store, factory: factoryFor(nodeFs, home), target, key: 'demo', files: plugin() });
    writeFileSync(path.join(ws, '.github', 'plugins', 'demo-plugin', 'skills', 'user-notes.md'), '# mine');

    const result = await applyBundleUninstall({
      writerFactory: factoryFor(nodeFs, home), target, key: 'demo', store, exclusion: NO_GIT, fs: nodeFs, preserveModified: false
    });

    expect(result.pruned).toContain(path.join(ws, '.github', 'plugins', 'demo-plugin', 'skills', 'helper'));
    expect(existsSync(path.join(ws, '.github', 'plugins', 'demo-plugin', 'skills', 'user-notes.md'))).toBe(true);
  });

  posixOnly('refuses a file below a symlinked directory pointing outside the repository root', async () => {
    const outside = path.join(tmp, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'sentinel.txt'), 'keep');
    mkdirSync(path.join(ws, '.github', 'plugins'), { recursive: true });
    symlinkSync(outside, path.join(ws, '.github', 'plugins', 'x'));
    const target: Target = { name: 'v', type: 'vscode', scope: 'repository', rootPath: ws, commitMode: 'commit' };
    const store = repoStore();
    await store.put('x', handEdited([{ path: 'plugins/x/sentinel.txt' }], 'vscode'), SOURCE);

    const result = await applyBundleUninstall({
      writerFactory: factoryFor(nodeFs, home), target, key: 'x', store, exclusion: NO_GIT, fs: nodeFs, preserveModified: false
    });

    expect(result.refused).toEqual(['plugins/x/sentinel.txt']);
    expect(readFileSync(path.join(outside, 'sentinel.txt'), 'utf8')).toBe('keep');
  });

  posixOnly('refuses a file below a symlinked directory pointing outside the user root', async () => {
    const outside = path.join(tmp, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'sentinel.txt'), 'keep');
    mkdirSync(path.join(home, '.copilot', 'plugins'), { recursive: true });
    symlinkSync(outside, path.join(home, '.copilot', 'plugins', 'x'));
    const target: Target = { name: 'c', type: 'copilot-cli', scope: 'user' };
    const store = createLockfileRecordStore({ scope: 'user', fs: nodeFs, lockfilePath: path.join(home, 'lock.json'), generatedBy: 'test' });
    await store.put('x', handEdited([{ path: 'plugins/x/sentinel.txt' }], 'copilot-cli'), SOURCE);

    const result = await applyBundleUninstall({
      writerFactory: factoryFor(nodeFs, home), target, key: 'x', store, exclusion: null, fs: nodeFs, preserveModified: false
    });

    expect(result.refused).toEqual(['plugins/x/sentinel.txt']);
    expect(readFileSync(path.join(outside, 'sentinel.txt'), 'utf8')).toBe('keep');
  });

  posixOnly('removes the files of a root that is itself a symlink', async () => {
    const dotfiles = path.join(tmp, 'dotfiles', 'copilot');
    mkdirSync(dotfiles, { recursive: true });
    symlinkSync(dotfiles, path.join(home, '.copilot'));
    const target: Target = { name: 'c', type: 'copilot-cli', scope: 'user' };
    const store = createLockfileRecordStore({ scope: 'user', fs: nodeFs, lockfilePath: path.join(home, 'lock.json'), generatedBy: 'test' });
    await record({ fs: nodeFs, store, factory: factoryFor(nodeFs, home), target, key: 'a', files: prompts('a', ['hello']) });
    expect(existsSync(path.join(dotfiles, 'prompts', 'hello.prompt.md'))).toBe(true);

    const result = await applyBundleUninstall({
      writerFactory: factoryFor(nodeFs, home), target, key: 'a', store, exclusion: null, fs: nodeFs, preserveModified: false
    });

    expect(result.removed).toEqual(['prompts/hello.prompt.md']);
    expect(existsSync(path.join(dotfiles, 'prompts', 'hello.prompt.md'))).toBe(false);
    expect(existsSync(dotfiles)).toBe(true);
  });

  it('un-excludes removed files, pruned directories and a legacy skill directory line for local-only', async () => {
    makeGitDir(ws);
    const exclusion = new GitInfoExclude({ fs: nodeFs, workspaceRoot: ws });
    const target: Target = { name: 'v', type: 'vscode', scope: 'repository', rootPath: ws, commitMode: 'local-only' };
    const store = repoStore(exclusion);
    const files = bundleOf('s', {
      'skills/helper/SKILL.md': '# Helper\n',
      'prompts/x.prompt.md': '# X\n'
    }, [
      { id: 'helper', file: 'skills/helper/SKILL.md', type: 'skill' },
      { id: 'x', file: 'prompts/x.prompt.md', type: 'prompt' }
    ]);
    const written = await record({ fs: nodeFs, store, factory: factoryFor(nodeFs, home), target, key: 's', files });
    await exclusion.add([...written, path.join(ws, '.github', 'skills', 'helper')]);
    const excludeFile = path.join(ws, '.git', 'info', 'exclude');
    expect(readFileSync(excludeFile, 'utf8')).toContain('.github/skills/helper\n');

    const result = await applyBundleUninstall({
      writerFactory: factoryFor(nodeFs, home), target, key: 's', store, exclusion, fs: nodeFs, preserveModified: false
    });

    expect(result.exclusionErrors).toEqual([]);
    expect(readFileSync(excludeFile, 'utf8')).toBe('# Prompt Registry (local)');
  });

  it('leaves no managed exclude line after a kiro local-only install and uninstall', async () => {
    makeGitDir(ws);
    const exclusion = new GitInfoExclude({ fs: nodeFs, workspaceRoot: ws });
    const target: Target = { name: 'k', type: 'kiro', scope: 'repository', rootPath: ws, commitMode: 'local-only' };
    const store = repoStore(exclusion);
    const written = await record({ fs: nodeFs, store, factory: factoryFor(nodeFs, home), target, key: 'k', files: prompts('k', ['a', 'b']) });
    await exclusion.add(written);

    await applyBundleUninstall({
      writerFactory: factoryFor(nodeFs, home), target, key: 'k', store, exclusion, fs: nodeFs, preserveModified: false
    });

    expect(readFileSync(path.join(ws, '.git', 'info', 'exclude'), 'utf8')).toBe('# Prompt Registry (local)');
  });
});
