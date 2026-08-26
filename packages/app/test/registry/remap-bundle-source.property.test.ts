/**
 * Property-based test for registry/remap-bundle-source.ts — the shared
 * bundle-source remap use case.
 *
 * Generalizes the four example-driven cycles in
 * `remap-bundle-source.test.ts` (resolve-first-or-throw, the three-store
 * happy path, the absent lockfile port, and retry idempotence) across
 * generated record sets spanning user, workspace and repository scope,
 * every mix of referencing and non-referencing `sourceId` values, a present
 * or absent replacement source, a wired or unwired lockfile port, and an
 * arbitrary subset of records already carrying the new id. It does not
 * replace those cycles' own tests: they pin the exact messages, call counts
 * and descriptor shape that this property only constrains structurally.
 *
 * Runs against in-memory ports only — no filesystem, no network, no host.
 */
import type {
  BundleSourceRemap,
  InstallationScope,
  InstalledBundle,
  LockfileSourceDescriptor,
  RegistrySource,
  SourceType,
} from '@ai-primitives-hub/core';
import * as fc from 'fast-check';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  remapBundleSource,
} from '../../src/registry/remap-bundle-source';

/** The orphaned source id installed bundles reference before the remap. */
const OLD_ID = 'source-old';
/** The replacement source id installed bundles must reference afterwards. */
const NEW_ID = 'source-new';

/**
 * Scopes the use case rewrites itself. Repository scope is deliberately
 * absent: those records live in the lockfile, which the
 * `remapLockfileSourceId` port owns, so a repository-scope record carrying
 * the old id must come out of a remap untouched.
 */
const REWRITTEN_SCOPES: InstallationScope[] = ['user', 'workspace'];

/** Every scope a generated record can land in, including repository. */
const ALL_SCOPES: InstallationScope[] = ['user', 'workspace', 'repository'];

/** Replacement source types, kept to a representative spread. */
const SOURCE_TYPES: SourceType[] = ['github', 'local', 'awesome-copilot', 'apm', 'skills'];

/**
 * Upper bound on a generated record set, and the fixed length of the
 * already-remapped flag array so a flag exists for every possible index.
 */
const MAX_RECORDS = 12;

/** One generated installation record, before a bundle id is assigned. */
interface RecordSpec {
  scope: InstallationScope;
  sourceId: string | undefined;
  version: string;
}

/** The generated replacement source, minus its fixed id. */
interface ReplacementSpec {
  name: string;
  type: SourceType;
  url: string;
  config: RegistrySource['config'];
}

/** One generated remap scenario. */
interface Scenario {
  specs: RecordSpec[];
  preRemapped: boolean[];
  replacement: ReplacementSpec;
  newSourcePresent: boolean;
  withLockfile: boolean;
  extraSourceCount: number;
}

/**
 * A `sourceId` value worth generating: the old id (the records that must
 * migrate), the new id (records a previous run already finished), no value
 * at all, and unrelated ids that must never be touched.
 */
const sourceIdArb = fc.oneof(
  fc.constant(OLD_ID),
  fc.constant(NEW_ID),
  fc.constant(undefined),
  fc.integer({ min: 0, max: 4 }).map((n) => `source-unrelated-${n}`)
);

const recordSpecArb = fc.record<RecordSpec>({
  scope: fc.constantFrom(...ALL_SCOPES),
  sourceId: sourceIdArb,
  version: fc.constantFrom('1.0.0', '2.1.3', '0.0.1-alpha.1')
});

/**
 * The replacement's `config`, covering all four descriptor shapes: absent
 * entirely, and present with either `branch` or `collectionsPath` missing.
 */
const configArb = fc.option(
  fc.record({
    branch: fc.option(fc.constantFrom('main', 'release', 'next'), { nil: undefined }),
    collectionsPath: fc.option(fc.constantFrom('collections', 'curated'), { nil: undefined })
  }),
  { nil: undefined }
);

const scenarioArb = fc.record<Scenario>({
  specs: fc.array(recordSpecArb, { maxLength: MAX_RECORDS }),
  preRemapped: fc.array(fc.boolean(), { minLength: MAX_RECORDS, maxLength: MAX_RECORDS }),
  replacement: fc.record<ReplacementSpec>({
    name: fc.constantFrom('Renamed Source', 'Moved Collection'),
    type: fc.constantFrom(...SOURCE_TYPES),
    url: fc.constantFrom('https://github.com/org/renamed', 'https://github.com/org/moved'),
    config: configArb
  }),
  newSourcePresent: fc.boolean(),
  withLockfile: fc.boolean(),
  extraSourceCount: fc.integer({ min: 0, max: 3 })
});

/**
 * Build one installation record from its generated spec, with a manifest
 * and install path that must survive the remap byte-identically.
 * @param bundleId Bundle id, unique per record so scope + id upserts cleanly.
 * @param spec The generated scope, source id and version.
 */
function makeInstalled(bundleId: string, spec: RecordSpec): InstalledBundle {
  return {
    bundleId,
    version: spec.version,
    installedAt: '2024-01-01T00:00:00.000Z',
    scope: spec.scope,
    installPath: `/mock/${spec.scope}/${bundleId}`,
    sourceId: spec.sourceId,
    manifest: {
      common: { directories: [], files: [], include_patterns: [], exclude_patterns: [] },
      bundle_settings: {
        include_common_in_environment_bundles: false,
        create_common_bundle: false,
        compression: 'none',
        naming: { environment_bundle: bundleId }
      },
      metadata: { manifest_version: '1.0.0', description: 'Generated' }
    }
  };
}

/**
 * Assign bundle ids by index, which keeps every (bundleId, scope) pair
 * unique so the upsert in `recordInstallation` cannot collide.
 * @param specs Generated record specs.
 */
function buildRecords(specs: RecordSpec[]): InstalledBundle[] {
  return specs.map((spec, index) => makeInstalled(`bundle-${index}`, spec));
}

/**
 * The stored-source set. The replacement is appended last, behind the
 * orphan and any unrelated sources, so resolution has to match on the id
 * rather than land on it by position.
 * @param scenario The generated scenario.
 */
function buildSources(scenario: Scenario): RegistrySource[] {
  const sources: RegistrySource[] = [
    {
      id: OLD_ID,
      name: 'Old Source',
      type: 'awesome-copilot',
      url: 'https://github.com/org/old',
      enabled: true,
      priority: 1,
      config: { branch: 'main', collectionsPath: 'collections' }
    }
  ];

  for (let index = 0; index < scenario.extraSourceCount; index++) {
    sources.push({
      id: `source-unrelated-${index}`,
      name: `Unrelated ${index}`,
      type: 'github',
      url: `https://github.com/org/unrelated-${index}`,
      enabled: true,
      priority: 2
    });
  }

  if (scenario.newSourcePresent) {
    sources.push({ id: NEW_ID, enabled: true, priority: 3, ...scenario.replacement });
  }

  return sources;
}

/** In-memory ports recording every write and every lockfile invocation. */
interface RecordingPorts extends BundleSourceRemap {
  records: InstalledBundle[];
  installCalls: InstalledBundle[];
  lockfileCalls: { oldSourceId: string; newSourceId: string; descriptor: LockfileSourceDescriptor }[];
}

/**
 * In-memory `BundleSourceRemap` over a mutable record set. Reads and writes
 * are cloned so a caller holding a returned record cannot mutate the store
 * by accident, which keeps the before/after comparisons honest.
 * @param sources Stored sources the remap resolves its replacement from.
 * @param installed Initial installation records.
 * @param withLockfile Whether to wire the optional repository-scope port.
 */
function makePorts(
  sources: RegistrySource[],
  installed: InstalledBundle[],
  withLockfile: boolean
): RecordingPorts {
  const records = structuredClone(installed);
  const installCalls: InstalledBundle[] = [];
  const lockfileCalls: RecordingPorts['lockfileCalls'] = [];

  const ports: RecordingPorts = {
    records,
    installCalls,
    lockfileCalls,
    listSources: () => Promise.resolve(structuredClone(sources)),
    getInstalledBundles: (scope: InstallationScope) =>
      Promise.resolve(structuredClone(records.filter((record) => record.scope === scope))),
    recordInstallation: (bundle: InstalledBundle) => {
      installCalls.push(structuredClone(bundle));
      const index = records.findIndex(
        (record) => record.bundleId === bundle.bundleId && record.scope === bundle.scope
      );
      if (index === -1) {
        records.push(structuredClone(bundle));
      } else {
        records[index] = structuredClone(bundle);
      }

      return Promise.resolve();
    }
  };

  if (withLockfile) {
    ports.remapLockfileSourceId = (
      oldSourceId: string,
      newSourceId: string,
      descriptor: LockfileSourceDescriptor
    ) => {
      lockfileCalls.push({ oldSourceId, newSourceId, descriptor });

      return Promise.resolve();
    };
  }

  return ports;
}

/**
 * Whether a record is one the use case is expected to rewrite: it carries
 * the old source id and lives in a scope the use case owns.
 * @param record The record to classify.
 */
function isMigrating(record: InstalledBundle): boolean {
  return REWRITTEN_SCOPES.includes(record.scope) && record.sourceId === OLD_ID;
}

/**
 * The final record set a correct remap must produce: only migrating
 * records change, and only their `sourceId`.
 * @param original The record set before the remap.
 */
function expectedFinalRecords(original: InstalledBundle[]): InstalledBundle[] {
  return original.map((record) => (isMigrating(record) ? { ...record, sourceId: NEW_ID } : record));
}

/**
 * The record set a crashed first run leaves behind: the flagged migrating
 * records already carry the new id, the rest still carry the old one.
 * @param original The record set before the remap.
 * @param flags Per-index "already remapped" flags.
 */
function partiallyRemapped(original: InstalledBundle[], flags: boolean[]): InstalledBundle[] {
  return original.map((record, index) =>
    isMigrating(record) && flags[index] ? { ...record, sourceId: NEW_ID } : record);
}

/**
 * Stable ordering for whole-record-set comparison, since the use case may
 * reorder nothing but the store's upsert is positional.
 * @param records The records to order.
 */
function byKey(records: InstalledBundle[]): InstalledBundle[] {
  return records.toSorted((a, b) => `${a.bundleId}|${a.scope}`.localeCompare(`${b.bundleId}|${b.scope}`));
}

/**
 * The identity of every record a correct run writes, as sorted keys.
 * @param records The records to key.
 */
function migratingKeys(records: InstalledBundle[]): string[] {
  return records.filter((record) => isMigrating(record)).map((record) => `${record.bundleId}|${record.scope}`)
    .toSorted();
}

/**
 * The Replacement_Descriptor the lockfile port must receive, derived from
 * the replacement source exactly as the use case derives it.
 * @param replacement The generated replacement source.
 */
function expectedDescriptor(replacement: ReplacementSpec): LockfileSourceDescriptor {
  return {
    type: replacement.type,
    url: replacement.url,
    branch: replacement.config?.branch,
    collectionsPath: replacement.config?.collectionsPath
  };
}

// Feature: hub-source-orphan-remap, Property 8: A remap either fully applies or changes nothing, and repeats change nothing further
describe('remapBundleSource — Property 8', () => {
  /**
   * **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 9.16, 9.17**
   */
  it('either fully applies or changes nothing, and repeats change nothing further', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const original = buildRecords(scenario.specs);
        const sources = buildSources(scenario);

        // Replacement absent: reject naming the missing id, having written
        // neither an installation record nor the lockfile (5.1, 5.2).
        if (!scenario.newSourcePresent) {
          const ports = makePorts(sources, original, scenario.withLockfile);

          await expect(remapBundleSource(OLD_ID, NEW_ID, ports)).rejects.toThrow(NEW_ID);

          expect(ports.installCalls).toEqual([]);
          expect(ports.lockfileCalls).toEqual([]);
          expect(byKey(ports.records)).toEqual(byKey(original));

          return;
        }

        const expected = byKey(expectedFinalRecords(original));

        // A single clean run: exactly the migrating records are written,
        // every other record and every other field is untouched (5.5), and
        // the repository-scope step runs once with the descriptor derived
        // from the replacement, or is skipped without error when its port
        // is absent while the rest still completes (5.3, 5.4).
        const clean = makePorts(sources, original, scenario.withLockfile);

        await remapBundleSource(OLD_ID, NEW_ID, clean);

        expect(clean.installCalls.map((b) => `${b.bundleId}|${b.scope}`).toSorted())
          .toEqual(migratingKeys(original));
        expect(clean.installCalls.every((b) => b.sourceId === NEW_ID)).toBe(true);
        expect(byKey(clean.records)).toEqual(expected);
        expect(clean.lockfileCalls).toEqual(scenario.withLockfile
          ? [{
            oldSourceId: OLD_ID,
            newSourceId: NEW_ID,
            descriptor: expectedDescriptor(scenario.replacement)
          }]
          : []);

        // A second invocation over a partially completed run reaches the
        // same final state as that single clean run (5.6).
        const retry = makePorts(
          sources,
          partiallyRemapped(original, scenario.preRemapped),
          scenario.withLockfile
        );

        await remapBundleSource(OLD_ID, NEW_ID, retry);

        expect(byKey(retry.records)).toEqual(expected);

        // And a third invocation changes nothing further: no write at all.
        const writesBeforeThird = retry.installCalls.length;

        await remapBundleSource(OLD_ID, NEW_ID, retry);

        expect(retry.installCalls).toHaveLength(writesBeforeThird);
        expect(byKey(retry.records)).toEqual(expected);
      }),
      { numRuns: 200 }
    );
  });
});
