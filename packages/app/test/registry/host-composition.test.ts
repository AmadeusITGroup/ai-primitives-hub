/**
 * Host-composition test (Cycle E) — proves the bundle-source remap is
 * reachable and usable from a host that is not the VS Code extension.
 *
 * Two things are under test, and they are deliberately different in kind:
 *
 *  1. **Reachability.** `remapBundleSource` is imported from the package
 *     entry point (`src/index.ts`, the barrel a `@ai-primitives-hub/app`
 *     consumer resolves), never by deep path. A use case that only exists
 *     at `src/registry/remap-bundle-source.ts` is invisible to the CLI and
 *     to every other SDK consumer, so the import itself is the assertion
 *     (Requirement 6.8).
 *  2. **Constructibility.** Every port is composed from `packages/infra`
 *     primitives — `NodeFileSystem` for disk I/O, `XdgAppStorage` for root
 *     resolution — over a single temp directory. There is no `vscode`
 *     value, no `ExtensionContext`, and no VS Code API call anywhere in
 *     this file (Requirement 6.9), and every on-disk path the composition
 *     touches comes out of the injected `AppStorage` port rather than
 *     being resolved inline, per ADR-0005 (Requirement 6.10).
 *
 * This is the one test in the feature that touches the real filesystem,
 * and it uses exactly one temp directory. No network, no GitHub, no VS
 * Code host.
 */
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
} from 'node:fs/promises';
import {
  tmpdir,
} from 'node:os';
import * as path from 'node:path';
import type {
  AppStorage,
  AppStoragePaths,
  BundleSourceRemap,
  InstallationScope,
  InstalledBundle,
  RegistrySource,
} from '@ai-primitives-hub/core';
import {
  NodeFileSystem,
  XdgAppStorage,
} from '@ai-primitives-hub/infra';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  emptyLockfile,
  LOCKFILE_NAME,
  readLockfile,
  remapBundleSource,
  remapSourceId,
  writeLockfile,
} from '../../src/index';

const OLD_ID = 'source-old';
const NEW_ID = 'source-new';

/**
 * Records file for one non-repository scope, rooted at the paths the
 * injected `AppStorage` resolved — never at `os.homedir()` or an
 * `ExtensionContext` URI (ADR-0005).
 * @param paths Paths resolved by the injected `AppStorage` port.
 * @param scope Installation scope whose records file is wanted.
 */
function recordsFile(paths: AppStoragePaths, scope: InstallationScope): string {
  const dir = scope === 'user' ? paths.userInstalled : path.join(paths.installed, scope);
  return path.join(dir, 'records.json');
}

/**
 * Registry config file holding the stored sources, at the config path the
 * injected `AppStorage` resolved.
 * @param paths Paths resolved by the injected `AppStorage` port.
 */
function sourcesFile(paths: AppStoragePaths): string {
  return paths.config;
}

/**
 * Compose the four `BundleSourceRemap` ports the way a CLI-shaped host
 * would: `NodeFileSystem` for every read and write, `AppStorage` for every
 * root, and the app package's own pure lockfile transform for repository
 * scope. Nothing here knows what VS Code is.
 * @param storage Injected storage-root port.
 * @param fs Injected filesystem adapter.
 * @param repositoryRoot Repository root, when one is in scope. Omitting it leaves the lockfile port unwired.
 */
function composeHostPorts(
  storage: AppStorage,
  fs: NodeFileSystem,
  repositoryRoot?: string
): BundleSourceRemap {
  const paths = storage.getPaths();

  const readRecords = async (scope: InstallationScope): Promise<InstalledBundle[]> => {
    const file = recordsFile(paths, scope);
    return (await fs.exists(file)) ? fs.readJson<InstalledBundle[]>(file) : [];
  };

  const writeRecords = async (scope: InstallationScope, records: InstalledBundle[]): Promise<void> => {
    const file = recordsFile(paths, scope);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeJson(file, records);
  };

  return {
    listSources: async () => {
      const file = sourcesFile(paths);
      if (!(await fs.exists(file))) {
        return [];
      }
      return (await fs.readJson<{ sources: RegistrySource[] }>(file)).sources;
    },
    remapLockfileSourceId: repositoryRoot === undefined
      ? undefined
      : async (oldSourceId, newSourceId, descriptor) => {
        const file = path.join(repositoryRoot, LOCKFILE_NAME);
        const lock = await readLockfile(file, fs);
        if (!lock) {
          return;
        }
        await writeLockfile(file, remapSourceId(lock, oldSourceId, newSourceId, descriptor), fs);
      },
    getInstalledBundles: async (scope) => readRecords(scope),
    recordInstallation: async (bundle) => {
      const records = await readRecords(bundle.scope);
      const index = records.findIndex((r) => r.bundleId === bundle.bundleId);
      if (index === -1) {
        records.push(bundle);
      } else {
        records[index] = bundle;
      }
      await writeRecords(bundle.scope, records);
    }
  };
}

/**
 * A stored source with a distinct descriptor, so the descriptor written to
 * the lockfile cannot accidentally match by reusing the orphan's fields.
 * @param overrides Fields to override on the base source.
 */
function makeSource(overrides: Partial<RegistrySource> = {}): RegistrySource {
  return {
    id: OLD_ID,
    name: 'Old Source',
    type: 'awesome-copilot',
    url: 'https://github.com/github/awesome-copilot',
    enabled: true,
    priority: 1,
    config: { branch: 'main', collectionsPath: 'collections' },
    ...overrides
  };
}

/**
 * One installation record.
 * @param overrides Fields to override on the base record.
 */
function makeInstalled(overrides: Partial<InstalledBundle> = {}): InstalledBundle {
  return {
    bundleId: 'bundle-1',
    version: '1.0.0',
    installedAt: '2024-01-01T00:00:00.000Z',
    scope: 'user',
    installPath: '/mock/path',
    sourceId: OLD_ID,
    manifest: {
      common: { directories: [], files: [], include_patterns: [], exclude_patterns: [] },
      bundle_settings: {
        include_common_in_environment_bundles: false,
        create_common_bundle: false,
        compression: 'none',
        naming: { environment_bundle: 'bundle-1' }
      },
      metadata: { manifest_version: '1.0.0', description: 'Test' }
    },
    ...overrides
  };
}

/**
 * Every file under one directory tree, mapped path to contents, so a
 * "nothing was written" claim can be checked against real bytes rather
 * than against a spy.
 * @param root Directory to walk.
 */
async function snapshotTree(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        snapshot.set(path.relative(root, full), await readFile(full, 'utf8'));
      }
    }
  };
  await walk(root);
  return snapshot;
}

describe('remapBundleSource composed from packages/infra primitives (non-VS-Code host)', () => {
  let tempDir: string;
  let storage: AppStorage;
  let fs: NodeFileSystem;
  let repositoryRoot: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'aph-host-composition-'));
    fs = new NodeFileSystem();

    storage = new XdgAppStorage({
      XDG_DATA_HOME: path.join(tempDir, 'data'),
      XDG_CONFIG_HOME: path.join(tempDir, 'config'),
      XDG_CACHE_HOME: path.join(tempDir, 'cache')
    });

    repositoryRoot = path.join(tempDir, 'repo');

    const paths = storage.getPaths();
    const sources = [makeSource(), makeSource({
      id: NEW_ID,
      name: 'Renamed Source',
      type: 'github',
      url: 'https://github.com/org/renamed',
      config: { branch: 'release', collectionsPath: 'curated' }
    })];

    await fs.mkdir(path.dirname(sourcesFile(paths)), { recursive: true });
    await fs.writeJson(sourcesFile(paths), { sources });

    await fs.mkdir(path.dirname(recordsFile(paths, 'user')), { recursive: true });
    await fs.writeJson(recordsFile(paths, 'user'), [
      makeInstalled({ bundleId: 'user-migrating', scope: 'user', sourceId: OLD_ID }),
      makeInstalled({ bundleId: 'user-unrelated', scope: 'user', sourceId: 'source-other' })
    ]);

    await fs.mkdir(path.dirname(recordsFile(paths, 'workspace')), { recursive: true });
    await fs.writeJson(recordsFile(paths, 'workspace'), [
      makeInstalled({ bundleId: 'workspace-migrating', scope: 'workspace', sourceId: OLD_ID })
    ]);

    const lock = emptyLockfile('ai-primitives-hub-test');
    lock.bundles['repo-migrating'] = {
      version: '1.0.0',
      sourceId: OLD_ID,
      sourceType: 'awesome-copilot',
      installedAt: '2024-01-01T00:00:00.000Z',
      files: []
    };
    lock.sources[OLD_ID] = {
      type: 'awesome-copilot',
      url: 'https://github.com/github/awesome-copilot',
      branch: 'main',
      collectionsPath: 'collections'
    };
    await writeLockfile(path.join(repositoryRoot, LOCKFILE_NAME), lock, fs);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('is reachable from the package entry point', () => {
    expect(typeof remapBundleSource).toBe('function');
  });

  it('resolves every on-disk root through the injected AppStorage port', () => {
    const paths = storage.getPaths();

    expect(paths.root.startsWith(tempDir)).toBe(true);
    expect(sourcesFile(paths).startsWith(tempDir)).toBe(true);
    expect(recordsFile(paths, 'user').startsWith(paths.root)).toBe(true);
    expect(recordsFile(paths, 'workspace').startsWith(paths.root)).toBe(true);
  });

  it('remaps user-scope records on disk', async () => {
    const ports = composeHostPorts(storage, fs, repositoryRoot);

    await remapBundleSource(OLD_ID, NEW_ID, ports);

    const records = await fs.readJson<InstalledBundle[]>(recordsFile(storage.getPaths(), 'user'));

    expect(records.find((r) => r.bundleId === 'user-migrating')?.sourceId).toBe(NEW_ID);
  });

  it('remaps workspace-scope records on disk', async () => {
    const ports = composeHostPorts(storage, fs, repositoryRoot);

    await remapBundleSource(OLD_ID, NEW_ID, ports);

    const records = await fs.readJson<InstalledBundle[]>(recordsFile(storage.getPaths(), 'workspace'));

    expect(records.find((r) => r.bundleId === 'workspace-migrating')?.sourceId).toBe(NEW_ID);
  });

  it('leaves records referencing another source untouched', async () => {
    const ports = composeHostPorts(storage, fs, repositoryRoot);

    await remapBundleSource(OLD_ID, NEW_ID, ports);

    const records = await fs.readJson<InstalledBundle[]>(recordsFile(storage.getPaths(), 'user'));

    expect(records.find((r) => r.bundleId === 'user-unrelated')?.sourceId).toBe('source-other');
  });

  it('remaps the repository-scope lockfile through the composed lockfile port', async () => {
    const ports = composeHostPorts(storage, fs, repositoryRoot);

    await remapBundleSource(OLD_ID, NEW_ID, ports);

    const lock = await readLockfile(path.join(repositoryRoot, LOCKFILE_NAME), fs);

    expect(lock?.bundles['repo-migrating']?.sourceId).toBe(NEW_ID);
    expect(lock?.sources[NEW_ID]).toEqual({
      type: 'github',
      url: 'https://github.com/org/renamed',
      branch: 'release',
      collectionsPath: 'curated'
    });
    expect(lock?.sources[OLD_ID]).toBeUndefined();
  });

  it('completes without a repository in scope, leaving the lockfile port unwired', async () => {
    const ports = composeHostPorts(storage, fs);

    await expect(remapBundleSource(OLD_ID, NEW_ID, ports)).resolves.toBeUndefined();

    const lock = await readLockfile(path.join(repositoryRoot, LOCKFILE_NAME), fs);

    expect(lock?.bundles['repo-migrating']?.sourceId).toBe(OLD_ID);
  });

  it('rejects and writes nothing when the replacement source is absent from stored sources', async () => {
    const ports = composeHostPorts(storage, fs, repositoryRoot);
    const before = await snapshotTree(tempDir);

    await expect(remapBundleSource(OLD_ID, 'source-never-stored', ports)).rejects.toThrow(/source-never-stored/);

    expect(await snapshotTree(tempDir)).toEqual(before);
  });
});
