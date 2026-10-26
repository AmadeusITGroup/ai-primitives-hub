/**
 * Characterisation of install / lockfile / uninstall output per primitive
 * kind, target type and scope (issue #552, ADR-0009 step M1).
 *
 * For each of the 17 primitive kinds a one-item collection is planned with
 * core's governed and legacy release planners, written out the way
 * `bundle build` lays out an archive, and installed through the real CLI
 * commands onto every target type in user and repository scope (plus the
 * VS Code repository `local-only` commit mode). The files written, the
 * lockfile entry, `.git/info/exclude` and what uninstall leaves behind are
 * stored as one snapshot file per kind. The snapshots were generated from
 * the code before the install-category refactor and must not change.
 *
 * The fixture data is owned by this file on purpose: it does not reuse the
 * `doctor diagnostics --primitives` fixture, which evolves independently.
 */
import {
  createHash,
} from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveUserConfigPaths,
} from '@ai-primitives-hub/app';
import {
  createLegacyReleaseManifestPlan,
  createReleaseManifestPlan,
  PRIMITIVE_KINDS,
  type ReleaseManifestPlan,
  type ReleaseSourceReader,
  type ReleaseSourceTree,
  serializeReleaseManifest,
  TARGET_TYPES,
} from '@ai-primitives-hub/core';
import {
  NodeFileSystem,
} from '@ai-primitives-hub/infra';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import {
  InstallCommand,
} from '../../src/commands/install';
import {
  TargetAddCommand,
} from '../../src/commands/target-add';
import {
  UninstallCommand,
} from '../../src/commands/uninstall';
import {
  createTestContext,
  runCli,
} from '../../src/framework';

const REVISION = 'abcdef0123456789abcdef0123456789abcdef01';
const COLLECTION_FILE = 'collections/example.collection.yml';
const encoder = new TextEncoder();

interface KindFixture {
  /** Item path declared in the collection. */
  path: string;
  /** Other repository files the item ships with (directory kinds). */
  extra?: Record<string, string>;
}

/** One item per primitive kind, at the path an author would use. */
const KIND_FIXTURES: Record<string, KindFixture> = {
  prompt: { path: 'prompts/x.prompt.md' },
  instruction: { path: 'instructions/x.instructions.md' },
  'chat-mode': { path: 'chatmodes/x.chatmode.md' },
  agent: { path: 'agents/x.agent.md' },
  skill: {
    path: 'skills/foo/SKILL.md',
    extra: { 'skills/foo/references/ref.md': '# Reference\n', 'skills/foo/scripts/run.sh': '#!/bin/sh\necho run\n' }
  },
  plugin: {
    path: 'plugins/foo/plugin.json',
    extra: { 'plugins/foo/skills/s/SKILL.md': '# Plugin skill\n', 'plugins/foo/.mcp.json': '{}\n' }
  },
  hook: { path: 'hooks/x.json' },
  'mcp-server': { path: 'mcp-servers/x.mcp.json' },
  steering: { path: '.kiro/steering/x.md' },
  spec: { path: '.kiro/specs/feature/requirements.md' },
  command: { path: 'commands/x.md' },
  rule: { path: 'rules/x.md' },
  'output-style': { path: 'output-styles/x.md' },
  tool: { path: 'tools/x.md' },
  power: { path: 'powers/stripe/POWER.md', extra: { 'powers/stripe/steering/payments.md': '# Payments\n' } },
  knowledge: { path: 'knowledge/x.md' },
  playbook: { path: 'playbooks/x.md' }
};

/**
 * In-memory source reader used for both the revision and the working tree.
 * @param files - Repository files.
 */
const sourcesFrom = (files: Map<string, string>): ReleaseSourceReader => {
  const tree = (): ReleaseSourceTree => ({
    readFile: (repositoryPath) => {
      const content = files.get(repositoryPath);
      return content === undefined
        ? Promise.reject(new Error(`missing: ${repositoryPath}`))
        : Promise.resolve(encoder.encode(content));
    },
    listFiles: (directory) => Promise.resolve([...files.keys()].filter(
      (file) => directory === '.' || file.startsWith(`${directory}/`)
    ))
  });
  return {
    openRevision: () => Promise.resolve({ revision: REVISION, ...tree() }),
    openWorkingTree: () => tree(),
    readRemoteUrl: () => Promise.resolve('https://github.com/example/example.git')
  };
};

/**
 * Repository files of a collection whose items are `items` (path + kind).
 * @param id - Collection id (also the bundle id).
 * @param items - Declared items.
 * @param extra - Additional repository files.
 */
const repositoryFiles = (
  id: string,
  items: { path: string; kind: string }[],
  extra: Record<string, string>
): Map<string, string> => {
  const files = new Map<string, string>([
    ['LICENSE', 'Example license\n'],
    ['README.md', `# ${id}\n`],
    ...Object.entries(extra)
  ]);
  for (const item of items) {
    files.set(item.path, item.path.endsWith('.json') ? '{"name":"N","description":"D"}\n' : '# Title\n');
  }
  files.set(COLLECTION_FILE, [
    `id: ${id}`,
    `name: ${id}`,
    'readme:',
    '  path: README.md',
    'items:',
    ...items.flatMap((item) => [`  - path: ${item.path}`, `    kind: ${item.kind}`]),
    ''
  ].join('\n'));
  return files;
};

/**
 * Write a planned release to `dir` as `bundle build` lays out its archive:
 * every planned entry plus the serialized `deployment-manifest.yml`.
 * @param plan - Planned release.
 * @param dir - Destination directory.
 */
const materialize = async (plan: ReleaseManifestPlan, dir: string): Promise<void> => {
  const entries: [string, Uint8Array][] = [
    ...plan.entries.map((entry): [string, Uint8Array] => [entry.path, entry.bytes]),
    ['deployment-manifest.yml', encoder.encode(serializeReleaseManifest(plan.manifest))]
  ];
  for (const [entryPath, bytes] of entries) {
    await mkdir(path.dirname(path.join(dir, entryPath)), { recursive: true });
    await writeFile(path.join(dir, entryPath), bytes);
  }
};

/**
 * Plan both release variants of a collection and write them below `root`.
 * @param root - Directory receiving `governed/` and `legacy/`.
 * @param files - Repository files.
 * @returns The bundle directory of each variant.
 */
const buildBundles = async (root: string, files: Map<string, string>): Promise<{ governed: string; legacy: string }> => {
  const options = {
    repoRoot: '/repo',
    collectionFile: COLLECTION_FILE,
    version: '1.0.0',
    source: 'https://github.com/example/example.git',
    revision: REVISION,
    packageMetadata: { license: 'MIT' }
  };
  const governed = path.join(root, 'governed');
  const legacy = path.join(root, 'legacy');
  await materialize(await createReleaseManifestPlan(options, sourcesFrom(files)), governed);
  await materialize(await createLegacyReleaseManifestPlan(options, sourcesFrom(files)), legacy);
  return { governed, legacy };
};

interface Sandbox {
  root: string;
  home: string;
  workspace: string;
  env: Record<string, string>;
}

const createSandbox = async (parent: string, name: string): Promise<Sandbox> => {
  const root = path.join(parent, name);
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  return {
    root,
    home,
    workspace,
    // Config, cache and data roots live outside HOME so the HOME listing
    // holds installed files only.
    env: {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
      XDG_CACHE_HOME: path.join(root, 'xdg-cache'),
      XDG_DATA_HOME: path.join(root, 'xdg-data'),
      XDG_STATE_HOME: path.join(root, 'xdg-state')
    }
  };
};

interface Envelope {
  status?: string;
  data?: Record<string, unknown>;
  errors?: { code?: string }[];
}

const run = async (sandbox: Sandbox, argv: string[]): Promise<{ exitCode: number; envelope: Envelope }> => {
  const ctx = createTestContext({ cwd: sandbox.workspace, fs: new NodeFileSystem(), env: sandbox.env });
  const exitCode = await runCli(argv, {
    ctx,
    http: { fetch: (request) => Promise.reject(new Error(`Unexpected request: ${request.url}`)) },
    tokens: { getToken: () => Promise.resolve(undefined) },
    commandClasses: [TargetAddCommand, InstallCommand, UninstallCommand],
    commands: [],
    name: 'test',
    version: 'test'
  });
  const stdout = ctx.stdout.captured().trim();
  let envelope: Envelope = {};
  try {
    envelope = JSON.parse(stdout) as Envelope;
  } catch {
    envelope = { status: `unparseable: ${stdout.slice(0, 200)}` };
  }
  return { exitCode, envelope };
};

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const comparePaths = (left: string, right: string): number => (left < right ? -1 : (left > right ? 1 : 0));

/** Workspace file holding per-target install timestamps. */
const TARGET_STATE_LABEL = '<workspace>/.ai-primitives-hub/target-state.json';

/**
 * Paths that belong to the sandbox bookkeeping, not to the install.
 * @param relative
 */
const isBookkeeping = (relative: string): boolean =>
  relative === '.git' || relative.startsWith('.git/') || /^prompt-registry(\.local)?\.lock\.json$/.test(relative);

/**
 * Every file (or directory) below the sandbox HOME and workspace, labelled
 * `$HOME/…` / `<workspace>/…` with `/` separators.
 * @param sandbox - Sandbox to list.
 * @param kind - Whether to list files or directories.
 */
const listLabelled = async (sandbox: Sandbox, kind: 'file' | 'dir'): Promise<string[]> => {
  const out: string[] = [];
  for (const [label, root] of [['$HOME', sandbox.home], ['<workspace>', sandbox.workspace]] as const) {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (kind === 'file' ? !entry.isFile() : !entry.isDirectory()) {
        continue;
      }
      const relative = path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/');
      if (!isBookkeeping(relative)) {
        out.push(`${label}/${relative}`);
      }
    }
  }
  return out.toSorted(comparePaths);
};

const unlabel = (sandbox: Sandbox, label: string): string =>
  label.startsWith('$HOME/')
    ? path.join(sandbox.home, label.slice('$HOME/'.length))
    : path.join(sandbox.workspace, label.slice('<workspace>/'.length));

const readOptional = async (file: string): Promise<string | null> => {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
};

/**
 * `.git/info/exclude` text with the header line kept first and the entry
 * lines below it in byte order. The install writes entries in the order
 * the bundle directory is enumerated, which is byte order on Linux and
 * case-insensitive on Windows.
 * @param text - Exclude file contents, or `null` when absent.
 */
const normalizeExclude = (text: string | null): string | null => {
  if (text === null) {
    return null;
  }
  const [header, ...entries] = text.split('\n');
  return [header, ...entries.toSorted(comparePaths)].join('\n');
};

interface LockFileEntry {
  path: string;
  installedPath?: string;
  checksum: string;
}

interface LockEntry {
  version: string;
  sourceType: string;
  files: LockFileEntry[];
}

/**
 * The bundle's lockfile entry from whichever lockfile the install wrote,
 * without timestamps and with files sorted by path.
 * @param sandbox - Sandbox.
 * @param bundleId - Bundle id.
 */
const readLockEntry = async (sandbox: Sandbox, bundleId: string): Promise<LockEntry | null> => {
  const candidates = [
    resolveUserConfigPaths(sandbox.env).userLockfile,
    path.join(sandbox.workspace, 'prompt-registry.lock.json'),
    path.join(sandbox.workspace, 'prompt-registry.local.lock.json')
  ];
  for (const candidate of candidates) {
    const text = await readOptional(candidate);
    if (text === null) {
      continue;
    }
    const entry = (JSON.parse(text) as { bundles?: Record<string, LockEntry> }).bundles?.[bundleId];
    if (entry !== undefined) {
      return {
        version: entry.version,
        sourceType: entry.sourceType,
        files: entry.files
          .map((file) => ({
            path: file.path,
            ...(file.installedPath === undefined ? {} : { installedPath: file.installedPath }),
            checksum: file.checksum
          }))
          .toSorted((left, right) => comparePaths(left.path, right.path))
      };
    }
  }
  return null;
};

interface CaseSpec {
  targetType: string;
  scope: 'user' | 'repository';
  localOnly: boolean;
}

const CASES: CaseSpec[] = [
  ...TARGET_TYPES.flatMap((targetType) => (['user', 'repository'] as const)
    .map((scope) => ({ targetType, scope, localOnly: false }))),
  { targetType: 'vscode', scope: 'repository', localOnly: true }
];

const caseKey = (spec: CaseSpec): string =>
  `${spec.targetType}/${spec.scope}${spec.localOnly ? '/local-only' : ''}`;

/**
 * Install `bundleDir` into a fresh sandbox, then uninstall it, recording
 * every observable output.
 * @param parent - Directory holding the sandbox.
 * @param name - Sandbox directory name.
 * @param spec - Target type, scope and commit mode.
 * @param bundleDir - Materialized bundle.
 * @param bundleId - Bundle id.
 */
const runCase = async (
  parent: string,
  name: string,
  spec: CaseSpec,
  bundleDir: string,
  bundleId: string
): Promise<Record<string, unknown>> => {
  const sandbox = await createSandbox(parent, name);
  const commitMode = spec.localOnly ? ['--commit-mode', 'local-only'] : [];
  const added = await run(sandbox, ['target', 'add', 't', '--type', spec.targetType, '--scope', spec.scope, '-o', 'json']);
  expect(added.exitCode).toBe(0);
  const install = await run(sandbox, ['install', '--from', bundleDir, '--target', 't', ...commitMode, '-o', 'json']);
  const fileLabels = await listLabelled(sandbox, 'file');
  const files: Record<string, string> = {};
  for (const label of fileLabels) {
    // Target state records install timestamps: pin its presence, not its bytes.
    files[label] = label === TARGET_STATE_LABEL ? 'present' : sha256(await readFile(unlabel(sandbox, label)));
  }
  const excludePath = path.join(sandbox.workspace, '.git', 'info', 'exclude');
  const gitExclude = normalizeExclude(await readOptional(excludePath));
  const lockEntry = await readLockEntry(sandbox, bundleId);
  await run(sandbox, ['uninstall', '--target', 't', '--all', ...commitMode, '-o', 'json']);
  return {
    targetAdd: { effectiveScope: (added.envelope.data?.target as { scope?: string } | undefined)?.scope ?? null },
    install: {
      exitCode: install.exitCode,
      status: install.envelope.status ?? null,
      errorCode: install.envelope.errors?.[0]?.code ?? null
    },
    files,
    gitExclude,
    lockEntry,
    filesAfterUninstall: await listLabelled(sandbox, 'file'),
    dirsLeftAfterUninstall: await listLabelled(sandbox, 'dir'),
    gitExcludeAfterUninstall: normalizeExclude(await readOptional(excludePath))
  };
};

/**
 * Deterministic JSON: object keys sorted recursively, arrays kept in order
 * (every array above is already sorted).
 * @param value - Value to serialize.
 */
const stableJson = (value: unknown): string => JSON.stringify(value, (_key, inner: unknown) => {
  if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
    return Object.fromEntries(Object.entries(inner).toSorted(([left], [right]) => comparePaths(left, right)));
  }
  return inner;
}, 2);

describe('characterisation: install, lockfile and uninstall per kind, target and scope', () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'cli-install-characterisation-'));
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('covers every primitive kind', () => {
    expect(Object.keys(KIND_FIXTURES).toSorted()).toEqual([...PRIMITIVE_KINDS].toSorted());
  });

  it.each(Object.entries(KIND_FIXTURES))('kind "%s"', async (kind, fixture) => {
    const bundleId = `c-${kind}`;
    const kindRoot = path.join(tmp, kind);
    const bundles = await buildBundles(
      path.join(kindRoot, 'bundles'),
      repositoryFiles(bundleId, [{ path: fixture.path, kind }], fixture.extra ?? {})
    );
    const result: Record<string, Record<string, unknown>> = { governed: {}, legacy: {} };
    for (const variant of ['governed', 'legacy'] as const) {
      for (const [index, spec] of CASES.entries()) {
        result[variant][caseKey(spec)] = await runCase(
          kindRoot,
          `${variant}-${index}`,
          spec,
          bundles[variant],
          bundleId
        );
      }
    }
    await expect(`${stableJson(result)}\n`)
      .toMatchFileSnapshot(`./__snapshots__/install-characterisation/${kind}.json`);
  }, 120_000);

  it.fails('a directory item does not install or record files of an item whose id it prefixes (#552)', async () => {
    const bundleId = 'c-prefixes';
    const caseRoot = path.join(tmp, 'prefixes');
    const bundles = await buildBundles(path.join(caseRoot, 'bundles'), repositoryFiles(bundleId, [
      { path: 'skills/foo/SKILL.md', kind: 'skill' },
      { path: 'skills/foo-bar/SKILL.md', kind: 'skill' },
      { path: 'plugins/bar/plugin.json', kind: 'plugin' },
      { path: 'plugins/bar-baz/plugin.json', kind: 'plugin' }
    ], {}));
    const sandbox = await createSandbox(caseRoot, 'sandbox');
    expect((await run(sandbox, ['target', 'add', 't', '--type', 'vscode', '--scope', 'repository', '-o', 'json'])).exitCode)
      .toBe(0);
    const install = await run(sandbox, ['install', '--from', bundles.governed, '--target', 't', '-o', 'json']);
    expect(install.exitCode).toBe(0);

    const lockPaths = ((await readLockEntry(sandbox, bundleId))?.files ?? []).map((file) => file.path);
    expect(lockPaths).toEqual([
      'plugins/bar-baz/plugin.json',
      'plugins/bar/plugin.json',
      'skills/foo-bar/SKILL.md',
      'skills/foo/SKILL.md'
    ]);
    const githubFiles = async (): Promise<string[]> =>
      (await listLabelled(sandbox, 'file')).filter((label) => label.startsWith('<workspace>/.github/'));
    expect(await githubFiles()).toEqual([
      '<workspace>/.github/plugins/bar-baz/plugin.json',
      '<workspace>/.github/plugins/bar/plugin.json',
      '<workspace>/.github/skills/foo-bar/SKILL.md',
      '<workspace>/.github/skills/foo/SKILL.md'
    ]);

    expect((await run(sandbox, ['uninstall', '--target', 't', '--all', '-o', 'json'])).exitCode).toBe(0);
    expect(await githubFiles()).toEqual([]);
  }, 60_000);
});
