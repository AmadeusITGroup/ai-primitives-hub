/**
 * Property-based test for registry/load-hub-sources.ts — behavior is
 * invariant across hosts.
 *
 * Generalizes the host-composition example (Cycle E, `host-composition.test.ts`)
 * from "the remap is reachable and usable from a non-VS-Code host" to "driving
 * a full hub sync through ports composed from `packages/infra` primitives
 * produces the same observable result as driving it through in-memory ports".
 *
 * For each generated one-rename hub config plus stored-source set, the same
 * sync is run twice over identical inputs:
 *
 *  1. Through the in-memory `portSet` fake (`generators.ts`).
 *  2. Through a `HubSourceSync` composed the way a CLI-shaped host composes it:
 *     `NodeFileSystem` for every read and write, `XdgAppStorage` for every
 *     on-disk root, over a single temp directory, with the `remapBundleSource`
 *     port delegating to the app's own `remapBundleSource` use case wired from
 *     the same infra primitives — and with no `vscode` value and no
 *     `ExtensionContext` anywhere in the composition.
 *
 * The two runs must agree on the added, updated, skipped, and removed counts
 * and on the exact remap argument pairs. The final installed-record state is
 * compared too, so parity is demonstrated at the level of what the sync
 * actually did to storage, not merely at the level of its return value.
 *
 * A fresh temp directory is created and removed per iteration. No network, no
 * GitHub, no VS Code host.
 */
import {
  mkdtemp,
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
  HubSourceSync,
  InstallationScope,
  InstalledBundle,
  RegistrySource,
} from '@ai-primitives-hub/core';
import {
  NodeFileSystem,
  XdgAppStorage,
} from '@ai-primitives-hub/infra';
import * as fc from 'fast-check';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  remapBundleSource as appRemapBundleSource,
  LOCKFILE_NAME,
  readLockfile,
  remapSourceId,
  writeLockfile,
} from '../../src/index';
import {
  loadHubSources,
} from '../../src/registry/load-hub-sources';
import type {
  OneRenameSpec,
} from './generators';
import {
  declaredVariant,
  hubConfigWithOneRename,
  installedRecordSet,
  portSet,
  recordSourceIds,
  storedIdFor,
  toHubSource,
  toStoredSource,
} from './generators';

/** The hub under sync. */
const HUB_ID = 'hub-a';

/** The two non-repository scopes a sync's installed records live under. */
const SCOPES: InstallationScope[] = ['user', 'workspace'];

/** A one-rename hub config plus how many installed bundles pin the orphan. */
interface Scenario {
  config: OneRenameSpec;
  consumerCount: number;
}

const scenarioArb = fc.record({
  config: hubConfigWithOneRename({ minLength: 1, maxLength: 4 }),
  // Zero exercises consumer-free pruning (remove without remap); one or more
  // exercises the remap-then-remove path. Both must agree across hosts.
  consumerCount: fc.integer({ min: 0, max: 3 })
});

/**
 * Records file for one non-repository scope, rooted at the paths the injected
 * `AppStorage` resolved — never at `os.homedir()` or an `ExtensionContext` URI.
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
 * The `BundleSourceRemap` ports a CLI-shaped host composes for the app's
 * `remapBundleSource` use case: `NodeFileSystem` for every read and write,
 * `AppStorage` for every root, and the app package's own pure lockfile
 * transform for repository scope. Nothing here knows what VS Code is.
 * @param storage Injected storage-root port.
 * @param fs Injected filesystem adapter.
 * @param repositoryRoot Repository root, when one is in scope.
 */
function composeRemapPorts(
  storage: AppStorage,
  fs: NodeFileSystem,
  repositoryRoot: string
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
    remapLockfileSourceId: async (oldSourceId, newSourceId, descriptor) => {
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

/** A `HubSourceSync` composed from infra primitives, with its remap log. */
interface InfraHost {
  ports: HubSourceSync;
  /** Every remap invocation the sync made, in order. */
  remapCalls: { oldSourceId: string; newSourceId: string }[];
}

/**
 * Compose the full `HubSourceSync` a non-VS-Code host wires: source CRUD and
 * installed-bundle reads backed by `NodeFileSystem` over the `AppStorage`
 * roots, and a `remapBundleSource` port delegating to the app's own
 * `remapBundleSource` use case (itself composed from infra primitives). The
 * remap arguments are recorded so a parity check can compare them against the
 * in-memory run without reaching into the use case.
 * @param storage Injected storage-root port.
 * @param fs Injected filesystem adapter.
 * @param repositoryRoot Repository root, when one is in scope.
 */
function composeInfraHost(
  storage: AppStorage,
  fs: NodeFileSystem,
  repositoryRoot: string
): InfraHost {
  const paths = storage.getPaths();
  const file = sourcesFile(paths);
  const remapCalls: { oldSourceId: string; newSourceId: string }[] = [];
  const remapPorts = composeRemapPorts(storage, fs, repositoryRoot);

  const readSources = async (): Promise<RegistrySource[]> => {
    if (!(await fs.exists(file))) {
      return [];
    }
    return (await fs.readJson<{ sources: RegistrySource[] }>(file)).sources;
  };

  const writeSources = async (sources: RegistrySource[]): Promise<void> => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeJson(file, { sources });
  };

  const ports: HubSourceSync = {
    listSources: readSources,
    addSource: async (source) => {
      const sources = await readSources();
      sources.push(source);
      await writeSources(sources);
    },
    updateSource: async (sourceId, updates) => {
      const sources = await readSources();
      const index = sources.findIndex((s) => s.id === sourceId);
      if (index !== -1) {
        sources[index] = { ...sources[index], ...updates };
        await writeSources(sources);
      }
    },
    removeSource: async (sourceId) => {
      const sources = await readSources();
      await writeSources(sources.filter((s) => s.id !== sourceId));
    },
    listInstalledBundles: async () => {
      const all: InstalledBundle[] = [];
      for (const scope of SCOPES) {
        all.push(...(await remapPorts.getInstalledBundles(scope)));
      }
      return all;
    },
    remapBundleSource: async (oldSourceId, newSourceId) => {
      remapCalls.push({ oldSourceId, newSourceId });
      await appRemapBundleSource(oldSourceId, newSourceId, remapPorts);
    }
  };

  return { ports, remapCalls };
}

/**
 * The final source id each installed record references, read back from disk
 * across both scopes, so host parity can be checked at the level of what the
 * sync did to storage.
 * @param storage Injected storage-root port.
 * @param fs Injected filesystem adapter.
 * @returns Bundle id to the source id it currently references.
 */
async function diskRecordSourceIds(
  storage: AppStorage,
  fs: NodeFileSystem
): Promise<Map<string, string>> {
  const paths = storage.getPaths();
  const map = new Map<string, string>();
  for (const scope of SCOPES) {
    const recordsPath = recordsFile(paths, scope);
    if (await fs.exists(recordsPath)) {
      for (const record of await fs.readJson<InstalledBundle[]>(recordsPath)) {
        map.set(record.bundleId, record.sourceId);
      }
    }
  }
  return map;
}

// Feature: hub-source-orphan-remap, Property 9: Behavior is invariant across hosts
describe('loadHubSources — Property 9', () => {
  /**
   * **Validates: Requirements 6.11, 6.12**
   */
  it(
    'yields the same counts and remap arguments through infra-composed ports as through in-memory ports',
    async () => {
      let runsWithRemap = 0;

      await fc.assert(
        fc.asyncProperty(scenarioArb, async ({ config, consumerCount }: Scenario) => {
          const renamedSpec = config.specs[config.renamedIndex];

          // The config declares the renamed entry at its new url and every
          // sibling at its unchanged old url.
          const declarations = config.specs.map((spec, index) =>
            toHubSource(spec, declaredVariant(config, index)));

          // Storage holds every declaration at its pre-rename url, so siblings
          // update in place and the renamed entry orphans.
          const stored = config.specs.map((spec) => toStoredSource(spec, 'old', HUB_ID));

          const orphanOldId = storedIdFor(renamedSpec, 'old');

          // Installed bundles pin the pre-rename stored id. Zero consumers
          // means the orphan is pruned directly; one or more triggers the
          // remap-then-remove path.
          const consumers = installedRecordSet(
            Array.from({ length: consumerCount }, () => orphanOldId)
          );

          // --- Run 1: in-memory ports -------------------------------------
          const memoryPorts = portSet(stored, consumers, { withRemap: true });
          const memoryResult = await loadHubSources(HUB_ID, declarations, memoryPorts);
          const memoryRecords = recordSourceIds(memoryPorts);

          // --- Run 2: infra-composed ports over one temp directory --------
          const tempDir = await mkdtemp(path.join(tmpdir(), 'aph-host-parity-'));
          try {
            const fs = new NodeFileSystem();
            const storage = new XdgAppStorage({
              XDG_DATA_HOME: path.join(tempDir, 'data'),
              XDG_CONFIG_HOME: path.join(tempDir, 'config'),
              XDG_CACHE_HOME: path.join(tempDir, 'cache')
            });
            const paths = storage.getPaths();

            // Seed the same starting state onto disk: stored sources, and the
            // installed records under user scope (the scope installedRecordSet
            // produces).
            await fs.mkdir(path.dirname(sourcesFile(paths)), { recursive: true });
            await fs.writeJson(sourcesFile(paths), { sources: stored });

            await fs.mkdir(path.dirname(recordsFile(paths, 'user')), { recursive: true });
            await fs.writeJson(recordsFile(paths, 'user'), consumers);

            const host = composeInfraHost(storage, fs, path.join(tempDir, 'repo'));
            const infraResult = await loadHubSources(HUB_ID, declarations, host.ports);
            const infraRecords = await diskRecordSourceIds(storage, fs);

            // Counts agree (Requirement 6.12).
            expect(infraResult).toEqual(memoryResult);

            // The exact remap argument pairs agree (Requirement 6.11).
            expect(host.remapCalls).toEqual(memoryPorts.calls.remapped);

            // And the observable effect on installed records agrees, so parity
            // holds at the level of what the sync did, not just what it returned.
            expect(infraRecords).toEqual(memoryRecords);

            if (host.remapCalls.length > 0) {
              runsWithRemap++;
            }
          } finally {
            await rm(tempDir, { recursive: true, force: true });
          }
        })
      );

      // Premise guard: the remap-argument parity clause is only meaningful when
      // the generator actually produced runs that remapped.
      expect(runsWithRemap).toBeGreaterThan(0);
    },
    60_000
  );
});
