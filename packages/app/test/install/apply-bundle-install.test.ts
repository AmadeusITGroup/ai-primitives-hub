/**
 * Tests for app/install/apply-bundle-install.ts.
 */
import {
  createHash,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  FileSystem,
  RepositoryExclusion,
  Target,
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
  applyBundleInstall,
  type ApplyBundleInstallInput,
} from '../../src/install/apply-bundle-install';
import {
  TargetWriteRejectedError,
} from '../../src/install/target-write';
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
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const SOURCE = { type: 'local', url: '/bundles' };
const NOW = new Date('2026-01-02T03:04:05.000Z');
const HEADER = '# Prompt Registry (local)';

interface Item { id: string; file: string; type: string }

const bundleOf = (id: string, version: string, files: Record<string, string>, items: Item[]): Map<string, Uint8Array> => new Map([
  ['deployment-manifest.yml', text([
    `id: ${id}`,
    `version: ${version}`,
    `name: ${id}`,
    'prompts:',
    ...items.flatMap((item) => [`  - id: ${item.id}`, `    file: ${item.file}`, `    type: ${item.type}`]),
    ''
  ].join('\n'))],
  ...Object.entries(files).map(([p, content]): [string, Uint8Array] => [p, text(content)])
]);

const prompts = (id: string, version: string, names: string[]): Map<string, Uint8Array> => bundleOf(
  id,
  version,
  Object.fromEntries(names.map((name) => [`prompts/${name}.prompt.md`, `# ${name}\n`])),
  names.map((name) => ({ id: name, file: `prompts/${name}.prompt.md`, type: 'prompt' }))
);

const agents = (id: string, version: string, names: string[]): Map<string, Uint8Array> => bundleOf(
  id,
  version,
  Object.fromEntries(names.map((name) => [`agents/${name}.md`, `---\ndescription: ${name}\n---\n# ${name}\n`])),
  names.map((name) => ({ id: name, file: `agents/${name}.md`, type: 'agent' }))
);

const factoryFor = (fs: FileSystem, home = '/home/u') => createTargetWriterFactory({
  fs, env: { HOME: home }, projectDir: null, userConfigDir: null, writerOwnsExclusion: false
});

const NO_GIT: RepositoryExclusion = { add: () => Promise.resolve(), remove: () => Promise.resolve(), isAvailable: () => Promise.resolve(false) };

/**
 * A store whose put fails, delegating everything else.
 * @param store
 */
const failingPut = (store: InstallRecordStore): InstallRecordStore & { puts: number } => {
  const wrapper = {
    puts: 0,
    get: (key: string) => store.get(key),
    others: (key: string) => store.others(key),
    remove: (key: string) => store.remove(key),
    put: (): Promise<void> => {
      wrapper.puts += 1;
      return Promise.reject(new Error('lockfile is read-only'));
    }
  };
  return wrapper;
};

describe('applyBundleInstall (in-memory)', () => {
  const vscodeRepo: Target = { name: 'v', type: 'vscode', scope: 'repository', rootPath: '/ws', commitMode: 'commit' };
  const github = (...segments: string[]): string => path.join('/ws', '.github', ...segments);
  let fs: InMemoryFileSystem;
  let store: InstallRecordStore;

  beforeEach(() => {
    fs = new InMemoryFileSystem();
    store = createLockfileRecordStore({ scope: 'repository', fs, rootPath: '/ws', generatedBy: 'test', exclusion: NO_GIT });
  });

  const install = (files: Map<string, Uint8Array>, overrides: Partial<ApplyBundleInstallInput> = {}) => applyBundleInstall({
    writerFactory: factoryFor(fs),
    target: vscodeRepo,
    files,
    manifest: validateManifest(files, {}),
    key: (validateManifest(files, {})).id,
    origin: { sourceId: 'local-src', sourceType: 'local' },
    source: SOURCE,
    store,
    exclusion: NO_GIT,
    fs,
    preserveModified: false,
    now: () => NOW,
    ...overrides
  });

  it('records a vscode entry with targetType, no commitMode and no installedChecksum', async () => {
    const result = await install(prompts('a', '1.0.0', ['hello']), { origin: { sourceId: 'local-src', sourceType: 'local', checksum: 'f'.repeat(64) } });

    const expected: LockfileBundleEntry = {
      version: '1.0.0',
      sourceId: 'local-src',
      sourceType: 'local',
      checksum: 'f'.repeat(64),
      installedAt: NOW.toISOString(),
      targetType: 'vscode',
      files: [{ path: 'prompts/hello.prompt.md', checksum: sha256(text('# hello\n')) }]
    };
    expect(result.entry).toEqual(expected);
    expect(result.written).toEqual([github('prompts', 'hello.prompt.md')]);
    expect((await store.get('a'))?.entry).toEqual(expected);
  });

  it('records installedChecksum for a transformed kiro file', async () => {
    const kiroUser: Target = { name: 'k', type: 'kiro', scope: 'user' };
    const userStore = createLockfileRecordStore({ scope: 'user', fs, lockfilePath: '/home/u/lock.json', generatedBy: 'test' });

    const result = await install(agents('k', '1.0.0', ['helper']), { target: kiroUser, store: userStore, exclusion: null });

    const [file] = result.entry.files;
    expect(file.installedChecksum).toBe(sha256(await fs.readFileBytes(result.written[0])));
    expect(file.installedChecksum).not.toBe(file.checksum);
  });

  it('removes a file the new version dropped through the repository-scope writer', async () => {
    await install(prompts('a', '1.0.0', ['kept', 'dropped']));

    const result = await install(prompts('a', '2.0.0', ['kept']));

    expect(result.superseded).toEqual(['prompts/dropped.prompt.md']);
    expect(await fs.exists(github('prompts', 'dropped.prompt.md'))).toBe(false);
    expect(await fs.exists(github('prompts', 'kept.prompt.md'))).toBe(true);
  });

  it('keeps a dropped file another record holds', async () => {
    await install(prompts('a', '1.0.0', ['kept', 'shared']));
    await install(prompts('b', '1.0.0', ['shared']));

    const result = await install(prompts('a', '2.0.0', ['kept']));

    expect(result.superseded).toEqual([]);
    expect(result.supersededKept).toEqual([{ path: 'prompts/shared.prompt.md', reason: 'shared' }]);
    expect(await fs.exists(github('prompts', 'shared.prompt.md'))).toBe(true);
  });

  it('keeps a modified dropped file with preserveModified (vscode)', async () => {
    await install(prompts('a', '1.0.0', ['kept', 'edited']));
    fs.seed(github('prompts', 'edited.prompt.md'), '# changed\n');

    const result = await install(prompts('a', '2.0.0', ['kept']), { preserveModified: true });

    expect(result.supersededKept).toEqual([{ path: 'prompts/edited.prompt.md', reason: 'modified' }]);
    expect(await fs.exists(github('prompts', 'edited.prompt.md'))).toBe(true);
  });

  it('removes an unmodified transformed kiro file and keeps an edited one with preserveModified', async () => {
    const kiroUser: Target = { name: 'k', type: 'kiro', scope: 'user' };
    const userStore = createLockfileRecordStore({ scope: 'user', fs, lockfilePath: '/home/u/lock.json', generatedBy: 'test' });
    const kiro = { target: kiroUser, store: userStore, exclusion: null, preserveModified: true };
    const first = await install(agents('k', '1.0.0', ['kept', 'pristine', 'edited']), kiro);
    const edited = first.written.find((p) => p.includes('edited')) as string;
    const pristine = first.written.find((p) => p.includes('pristine')) as string;
    fs.seed(edited, '# changed\n');

    const result = await install(agents('k', '2.0.0', ['kept']), kiro);

    expect(result.superseded).toEqual(['agents/pristine.md']);
    expect(result.supersededKept).toEqual([{ path: 'agents/edited.md', reason: 'modified' }]);
    expect(await fs.exists(pristine)).toBe(false);
    expect(await fs.exists(edited)).toBe(true);
  });

  it('removes the files the previous entry placed through another target type', async () => {
    await install(prompts('a', '1.0.0', ['kept', 'dropped']), { target: { ...vscodeRepo, type: 'kiro' } });

    const result = await install(prompts('a', '2.0.0', ['kept']));

    expect(result.superseded).toEqual(['prompts/kept.prompt.md', 'prompts/dropped.prompt.md']);
    expect(result.supersededKept).toEqual([]);
    expect(await fs.exists(path.join('/ws', '.kiro', 'steering', 'kept.prompt.md'))).toBe(false);
    expect(await fs.exists(path.join('/ws', '.kiro', 'steering', 'dropped.prompt.md'))).toBe(false);
    expect(await fs.exists(github('prompts', 'kept.prompt.md'))).toBe(true);
    expect((await store.get('a'))?.entry.targetType).toBe('vscode');
  });

  it('keeps a previous file of another target type that another record holds or that was modified', async () => {
    const kiro = { target: { ...vscodeRepo, type: 'kiro' as const } };
    const steering = (name: string): string => path.join('/ws', '.kiro', 'steering', `${name}.prompt.md`);
    await install(prompts('a', '1.0.0', ['shared', 'edited', 'pristine']), kiro);
    await install(prompts('b', '1.0.0', ['shared']), kiro);
    fs.seed(steering('edited'), '# changed\n');

    const result = await install(prompts('a', '2.0.0', ['new']), { preserveModified: true });

    expect(result.superseded).toEqual(['prompts/pristine.prompt.md']);
    expect(result.supersededKept).toEqual([
      { path: 'prompts/shared.prompt.md', reason: 'shared' },
      { path: 'prompts/edited.prompt.md', reason: 'modified' }
    ]);
    expect(await fs.exists(steering('shared'))).toBe(true);
    expect(await fs.exists(steering('edited'))).toBe(true);
    expect(await fs.exists(steering('pristine'))).toBe(false);
  });

  it('keeps and reports every previous file when the other target type cannot be located', async () => {
    await install(prompts('a', '1.0.0', ['kept', 'dropped']), { target: { ...vscodeRepo, type: 'kiro' } });
    const base = factoryFor(fs);
    const writerFactory = (target: Target): ReturnType<typeof base> => {
      if (target.type === 'kiro') {
        throw new Error('no kiro layout on this host');
      }
      return base(target);
    };

    const result = await install(prompts('a', '2.0.0', ['kept']), { writerFactory });

    expect(result.superseded).toEqual([]);
    expect(result.supersededKept).toEqual([
      { path: 'prompts/kept.prompt.md', reason: 'unresolvable' },
      { path: 'prompts/dropped.prompt.md', reason: 'unresolvable' }
    ]);
    expect(result.supersededUnresolvable).toBe('no kiro layout on this host');
    expect(await fs.exists(path.join('/ws', '.kiro', 'steering', 'dropped.prompt.md'))).toBe(true);
    expect((await store.get('a'))?.entry.targetType).toBe('vscode');
  });

  it('reports no unresolvable previous record when it was placed by the same target type', async () => {
    await install(prompts('a', '1.0.0', ['kept']));

    const result = await install(prompts('a', '2.0.0', ['kept']));

    expect(result.supersededKept).toEqual([]);
    expect(result).not.toHaveProperty('supersededUnresolvable');
  });

  it('rolls back every written file when the first record cannot be stored', async () => {
    const failing = failingPut(store);

    await expect(install(prompts('a', '1.0.0', ['hello']), { store: failing })).rejects.toThrow('lockfile is read-only');

    expect(await fs.exists(github('prompts', 'hello.prompt.md'))).toBe(false);
    expect(await store.get('a')).toBeUndefined();
  });

  it('keeps the previous record locations when a reinstall cannot be stored', async () => {
    await install(prompts('a', '1.0.0', ['kept']));

    await expect(install(prompts('a', '2.0.0', ['kept', 'added']), { store: failingPut(store) })).rejects.toThrow('lockfile is read-only');

    expect(await fs.exists(github('prompts', 'kept.prompt.md'))).toBe(true);
    expect(await fs.exists(github('prompts', 'added.prompt.md'))).toBe(false);
    expect((await store.get('a'))?.entry.version).toBe('1.0.0');
  });

  it('keeps the previous record and its files when the other records cannot be read', async () => {
    await install(prompts('a', '1.0.0', ['kept', 'dropped']));
    const othersFailing: InstallRecordStore = { ...store, others: () => Promise.reject(new Error('lockfile unreadable')) };

    await expect(install(prompts('a', '2.0.0', ['kept', 'added']), { store: othersFailing })).rejects.toThrow('lockfile unreadable');

    expect((await store.get('a'))?.entry.version).toBe('1.0.0');
    expect(await fs.exists(github('prompts', 'dropped.prompt.md'))).toBe(true);
    expect(await fs.exists(github('prompts', 'added.prompt.md'))).toBe(false);
  });

  it('writes nothing and records nothing when the target rejects the bundle', async () => {
    const failing = failingPut(store);
    const kiroUser: Target = { name: 'k', type: 'kiro', scope: 'user' };
    const files = bundleOf('p', '1.0.0', {
      'prompts/hello.prompt.md': '# hello\n',
      'plugins/demo/plugin.json': '{}'
    }, [{ id: 'hello', file: 'prompts/hello.prompt.md', type: 'prompt' }]);

    await expect(install(files, { target: kiroUser, store: failing, exclusion: null })).rejects.toBeInstanceOf(TargetWriteRejectedError);

    expect(failing.puts).toBe(0);
    expect(await fs.exists(path.join('/home/u', '.kiro', 'steering', 'hello.prompt.md'))).toBe(false);
  });

  it('records only the installed files with skipUnsupported', async () => {
    const kiroUser: Target = { name: 'k', type: 'kiro', scope: 'user' };
    const userStore = createLockfileRecordStore({ scope: 'user', fs, lockfilePath: '/home/u/lock.json', generatedBy: 'test' });
    const files = bundleOf('p', '1.0.0', {
      'prompts/hello.prompt.md': '# hello\n',
      'plugins/demo/plugin.json': '{}'
    }, [{ id: 'hello', file: 'prompts/hello.prompt.md', type: 'prompt' }]);

    const result = await install(files, { target: kiroUser, store: userStore, exclusion: null, skipUnsupported: true });

    expect(result.entry.files.map((file) => file.path)).toEqual(['prompts/hello.prompt.md']);
    expect(result.skipped.map((skipped) => skipped.path)).toEqual(['plugins/demo/plugin.json']);
  });

  it('skips exclusion outside a git repository and creates no .git', async () => {
    const local: Target = { ...vscodeRepo, type: 'kiro', commitMode: 'local-only' };

    const result = await install(prompts('a', '1.0.0', ['hello']), { target: local, exclusion: new GitInfoExclude({ fs, workspaceRoot: '/ws' }) });

    expect(result.exclusionSkipped).toBe(true);
    expect(await fs.exists(path.join('/ws', '.git'))).toBe(false);
    expect(await fs.exists(path.join('/ws', '.kiro', 'steering', 'hello.prompt.md'))).toBe(true);
  });

  it('succeeds with one exclusion error when the exclusion add throws', async () => {
    const local: Target = { ...vscodeRepo, type: 'kiro', commitMode: 'local-only' };
    const failing: RepositoryExclusion = { add: () => Promise.reject(new Error('exclude unwritable')), remove: () => Promise.resolve() };

    const result = await install(prompts('a', '1.0.0', ['hello']), { target: local, exclusion: failing });

    expect(result.exclusionErrors).toEqual(['exclude unwritable']);
    expect((await store.get('a'))?.commitMode).toBe('local-only');
  });
});

describe('applyBundleInstall (on disk, git exclusion)', () => {
  let tmp: string;
  let ws: string;
  const nodeFs = new NodeFileSystem();

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'apply-install-'));
    ws = path.join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const install = (target: Target, files: Map<string, Uint8Array>, overrides: Partial<ApplyBundleInstallInput> = {}) => {
    const exclusion = new GitInfoExclude({ fs: nodeFs, workspaceRoot: ws });
    return applyBundleInstall({
      writerFactory: factoryFor(nodeFs, path.join(tmp, 'home')),
      target,
      files,
      manifest: validateManifest(files, {}),
      key: validateManifest(files, {}).id,
      origin: { sourceId: 'local-src', sourceType: 'local' },
      source: SOURCE,
      store: createLockfileRecordStore({ scope: 'repository', fs: nodeFs, rootPath: ws, generatedBy: 'test', exclusion }),
      exclusion,
      fs: nodeFs,
      preserveModified: false,
      ...overrides
    });
  };
  const excludeLines = (file = path.join(ws, '.git', 'info', 'exclude')): string[] => readFileSync(file, 'utf8').split('\n');

  it('excludes kiro local-only files and the local lockfile, and a commit reinstall removes the file lines', async () => {
    mkdirSync(path.join(ws, '.git'), { recursive: true });
    const local: Target = { name: 'k', type: 'kiro', scope: 'repository', rootPath: ws, commitMode: 'local-only' };

    await install(local, prompts('a', '1.0.0', ['hello', 'other']));

    expect(excludeLines()).toEqual(expect.arrayContaining([
      HEADER,
      '.kiro/steering/hello.prompt.md',
      '.kiro/steering/other.prompt.md',
      'prompt-registry.local.lock.json'
    ]));

    const result = await install({ ...local, commitMode: 'commit' }, prompts('a', '1.0.0', ['hello', 'other']));

    expect(result.exclusionErrors).toEqual([]);
    expect(excludeLines()).toEqual([HEADER]);
    expect(existsSync(path.join(ws, LOCKFILE_NAME))).toBe(true);
  });

  it('removes the files and exclusion lines of a local-only install placed through another target type', async () => {
    mkdirSync(path.join(ws, '.git'), { recursive: true });
    const kiro: Target = { name: 'k', type: 'kiro', scope: 'repository', rootPath: ws, commitMode: 'local-only' };
    await install(kiro, prompts('a', '1.0.0', ['hello']));

    const result = await install({ ...kiro, name: 'v', type: 'vscode' }, prompts('a', '1.0.0', ['hello']));

    expect(result.superseded).toEqual(['prompts/hello.prompt.md']);
    expect(result.exclusionErrors).toEqual([]);
    expect(existsSync(path.join(ws, '.kiro', 'steering', 'hello.prompt.md'))).toBe(false);
    expect(existsSync(path.join(ws, '.github', 'prompts', 'hello.prompt.md'))).toBe(true);
    expect(excludeLines()).not.toContain('.kiro/steering/hello.prompt.md');
    expect(excludeLines()).toEqual(expect.arrayContaining([
      HEADER,
      '.github/prompts/hello.prompt.md',
      'prompt-registry.local.lock.json'
    ]));
  });

  it('removes the exclusion lines it added when the record cannot be stored', async () => {
    mkdirSync(path.join(ws, '.git'), { recursive: true });
    const local: Target = { name: 'k', type: 'kiro', scope: 'repository', rootPath: ws, commitMode: 'local-only' };
    const store = failingPut(createLockfileRecordStore({ scope: 'repository', fs: nodeFs, rootPath: ws, generatedBy: 'test', exclusion: NO_GIT }));

    await expect(install(local, prompts('a', '1.0.0', ['hello']), { store })).rejects.toThrow('lockfile is read-only');

    expect(excludeLines()).toEqual([HEADER]);
    expect(existsSync(path.join(ws, '.kiro', 'steering', 'hello.prompt.md'))).toBe(false);
  });

  it('removes the lines of a committed previous install\'s files when a local-only reinstall cannot be stored', async () => {
    mkdirSync(path.join(ws, '.git'), { recursive: true });
    const committed: Target = { name: 'k', type: 'kiro', scope: 'repository', rootPath: ws, commitMode: 'commit' };
    await install(committed, prompts('a', '1.0.0', ['hello']));
    const store = failingPut(createLockfileRecordStore({ scope: 'repository', fs: nodeFs, rootPath: ws, generatedBy: 'test', exclusion: NO_GIT }));
    await expect(install({ ...committed, commitMode: 'local-only' }, prompts('a', '1.0.0', ['hello']), { store }))
      .rejects.toThrow('lockfile is read-only');
    expect(excludeLines()).not.toContain('.kiro/steering/hello.prompt.md');
    expect(existsSync(path.join(ws, '.kiro', 'steering', 'hello.prompt.md'))).toBe(true);
  });

  it('keeps the lines of a local-only previous install\'s files when a reinstall cannot be stored', async () => {
    mkdirSync(path.join(ws, '.git'), { recursive: true });
    const local: Target = { name: 'k', type: 'kiro', scope: 'repository', rootPath: ws, commitMode: 'local-only' };
    await install(local, prompts('a', '1.0.0', ['hello']));
    const store = failingPut(createLockfileRecordStore({ scope: 'repository', fs: nodeFs, rootPath: ws, generatedBy: 'test', exclusion: NO_GIT }));
    await expect(install(local, prompts('a', '2.0.0', ['hello', 'added']), { store })).rejects.toThrow('lockfile is read-only');
    expect(excludeLines()).toContain('.kiro/steering/hello.prompt.md');
    expect(excludeLines()).not.toContain('.kiro/steering/added.prompt.md');
  });

  it('writes the lines into the common exclude file of a linked worktree', async () => {
    const main = path.join(tmp, 'main');
    const gitDir = path.join(main, '.git', 'worktrees', 'ws');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
    writeFileSync(path.join(ws, '.git'), `gitdir: ${gitDir}\n`);
    const local: Target = { name: 'v', type: 'vscode', scope: 'repository', rootPath: ws, commitMode: 'local-only' };

    const result = await install(local, prompts('a', '1.0.0', ['hello']));

    expect(result.exclusionSkipped).toBe(false);
    expect(excludeLines(path.join(main, '.git', 'info', 'exclude'))).toEqual(expect.arrayContaining([
      '.github/prompts/hello.prompt.md',
      'prompt-registry.local.lock.json'
    ]));
    expect(existsSync(path.join(gitDir, 'info'))).toBe(false);
  });
});
