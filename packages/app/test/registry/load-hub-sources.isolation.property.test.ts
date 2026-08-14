/**
 * Property-based test for registry/load-hub-sources.ts — only the synced
 * hub's sources are affected.
 *
 * Generalizes Cycle L's isolation guard across generated stored-source sets:
 * alongside the target hub's own sources — some renamed, some with installed
 * consumers, so the sync genuinely adds, updates, remaps, and prunes — the
 * store also holds manually-added sources (no `hubId`) and sources owned by a
 * different hub. Pruning is filtered by `s.hubId === hubId` and no write path
 * touches a foreign id, so every non-target source must survive the sync
 * byte-identical.
 *
 * Runs against in-memory ports only — no filesystem, no network, no host.
 */
import type {
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
  loadHubSources,
} from '../../src/registry/load-hub-sources';
import type {
  OneRenameSpec,
} from './generators';
import {
  declaredVariant,
  hubConfigWithOneRename,
  installedRecordSet,
  makeRegistrySource,
  portSet,
  SOURCE_TYPES,
  storedIdFor,
  toHubSource,
  toStoredSource,
} from './generators';

/** The hub under sync. */
const HUB_ID = 'hub-a';

/** The hub that owns the foreign, must-not-touch sources. */
const OTHER_HUB_ID = 'hub-b';

/** A stored source that does not belong to the hub being synced. */
interface NonTargetSpec {
  /** Unique index, so the literal id never collides across the set. */
  index: number;
  type: SourceType;
  /** `manual` leaves `hubId` absent; `other` attributes it to another hub. */
  owner: 'manual' | 'other';
  branch?: string;
  collectionsPath?: string;
}

const nonTargetSpecArb = fc.record<NonTargetSpec>({
  index: fc.integer({ min: 0, max: 999 }),
  type: fc.constantFrom(...SOURCE_TYPES),
  owner: fc.constantFrom('manual', 'other'),
  branch: fc.option(fc.constantFrom('main', 'release'), { nil: undefined }),
  collectionsPath: fc.option(fc.constantFrom('collections', 'curated'), { nil: undefined })
});

/**
 * Build the stored source a non-target spec describes. Its id is a literal
 * unique to the set — never a `generateSourceId` hash — so it cannot collide
 * with any id the sync derives from the target hub's declarations.
 * @param spec The non-target spec.
 * @returns The stored source, with `hubId` absent for a manual source.
 */
function toNonTargetSource(spec: NonTargetSpec): RegistrySource {
  return makeRegistrySource({
    id: `${spec.owner}-${spec.index}`,
    name: `Foreign ${spec.owner} source ${spec.index}`,
    type: spec.type,
    url: `https://github.com/foreign/${spec.owner}-${spec.index}`,
    config: { branch: spec.branch, collectionsPath: spec.collectionsPath },
    ...spec.owner === 'other' ? { hubId: OTHER_HUB_ID } : {}
  });
}

/** A target-hub sync scenario plus the foreign sources sharing its store. */
interface Scenario {
  config: OneRenameSpec;
  consumerCount: number;
  nonTarget: NonTargetSpec[];
}

const scenarioArb = fc.record<Scenario>({
  config: hubConfigWithOneRename({ minLength: 1, maxLength: 4 }),
  consumerCount: fc.integer({ min: 0, max: 3 }),
  nonTarget: fc.uniqueArray(nonTargetSpecArb, {
    minLength: 0,
    maxLength: 4,
    selector: (spec) => `${spec.owner}-${spec.index}`
  })
});

// Feature: hub-source-orphan-remap, Property 7: Only the synced hub's sources are affected
describe('loadHubSources — Property 7', () => {
  let runsWithManual = 0;
  let runsWithOtherHub = 0;

  /**
   * **Validates: Requirements 9.5, 9.6**
   */
  it('leaves every manual and other-hub source byte-identical across a sync', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ config, consumerCount, nonTarget }: Scenario) => {
        const renamedSpec = config.specs[config.renamedIndex];

        // The target hub declares its renamed entry at the new url and every
        // sibling at its unchanged old url — a real sync with updates, an
        // orphan, and (given consumers) a remap.
        const declarations = config.specs.map((spec, index) =>
          toHubSource(spec, declaredVariant(config, index)));

        // Storage holds the target hub's sources at their pre-rename urls plus
        // the foreign sources that must never be touched.
        const targetStored = config.specs.map((spec) => toStoredSource(spec, 'old', HUB_ID));
        const nonTargetStored = nonTarget.map((spec) => toNonTargetSource(spec));
        const stored = [...targetStored, ...nonTargetStored];

        const consumers = installedRecordSet(
          Array.from({ length: consumerCount }, () => storedIdFor(renamedSpec, 'old'))
        );

        const ports = portSet(stored, consumers, { withRemap: true });

        // Snapshot the foreign sources before the sync, keyed by id.
        const before = new Map(
          nonTargetStored.map((source) => [source.id, structuredClone(source)])
        );

        await loadHubSources(HUB_ID, declarations, ports);

        // Every foreign source is still present and byte-identical afterwards.
        for (const [id, snapshot] of before) {
          const after = ports.sources.find((source) => source.id === id);
          expect(after).toEqual(snapshot);
        }

        if (nonTarget.some((spec) => spec.owner === 'manual')) {
          runsWithManual++;
        }
        if (nonTarget.some((spec) => spec.owner === 'other')) {
          runsWithOtherHub++;
        }
      })
    );

    // Premise guard: the isolation claim is vacuous unless the generator
    // actually produced both a manual source and an other-hub source.
    expect(runsWithManual).toBeGreaterThan(0);
    expect(runsWithOtherHub).toBeGreaterThan(0);
  });
});
