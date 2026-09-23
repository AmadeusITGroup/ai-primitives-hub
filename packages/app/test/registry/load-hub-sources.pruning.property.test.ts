/**
 * Property-based tests for registry/load-hub-sources.ts — orphan pruning and
 * the add-failure suspension.
 *
 * Generalizes the two halves of Property 6 across generated orphan sets:
 *
 * - **Pruning.** With every declared source registering cleanly, an orphan
 *   that no installed bundle references is removed outright, and the remap is
 *   never invoked for it — the zero-consumer branch does not need a
 *   replacement.
 * - **Suspension.** When any `addSource` rejects during the sync, orphan
 *   evaluation is skipped for the whole cycle: no orphan is removed, whether
 *   or not it has consumers, and the remap is never invoked at all.
 *
 * It does not replace the existing example coverage of these branches; it
 * widens the outcome guarantee to any orphan set the generator emits, and its
 * premise guards prove both branches were actually exercised.
 *
 * Runs against in-memory ports only — no filesystem, no network, no host.
 */
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
  HubSourceDeclarationSpec,
} from './generators';
import {
  hubSourceDeclaration,
  installedRecordSet,
  portSet,
  storedIdFor,
  toHubSource,
  toStoredSource,
} from './generators';

/** The hub under sync. */
const HUB_ID = 'hub-a';

/** One pre-rename stored source that becomes an orphan on this sync. */
interface OrphanEntry {
  spec: HubSourceDeclarationSpec;
  /** Whether installed bundles pin the orphan's stored id. */
  hasConsumers: boolean;
}

/** A generated pruning or suspension scenario. */
interface Scenario {
  mode: 'prune' | 'suspend';
  /** Sources stored at their pre-rename url and absent from the config. */
  orphans: OrphanEntry[];
  /** Enabled declarations the sync registers fresh this cycle. */
  freshSpecs: HubSourceDeclarationSpec[];
  /** In suspend mode, the first fresh declaration's `addSource` rejects. */
  failFirstAdd: boolean;
}

/**
 * Consumer-free orphans plus cleanly-registering declarations. Every orphan is
 * removable, so the pruning half of the property is never vacuous.
 */
const pruneScenarioArb: fc.Arbitrary<Scenario> = fc
  .uniqueArray(hubSourceDeclaration(), {
    minLength: 1,
    maxLength: 5,
    selector: (spec) => spec.sticker
  })
  .chain((specs) => fc
    .integer({ min: 1, max: specs.length })
    .map((orphanCount) => ({
      mode: 'prune' as const,
      orphans: specs
        .slice(0, orphanCount)
        .map((spec) => ({ spec, hasConsumers: false })),
      // Enabled so the sync actually adds them; distinct stickers from the
      // orphans, so no fresh source is ever a replacement candidate.
      freshSpecs: specs.slice(orphanCount).map((spec) => ({ ...spec, enabled: true })),
      failFirstAdd: false
    })));

/**
 * At least one orphan and at least one fresh declaration whose `addSource`
 * rejects, so a real add failure suspends pruning while genuine orphans exist.
 */
const suspendScenarioArb: fc.Arbitrary<Scenario> = fc
  .uniqueArray(hubSourceDeclaration(), {
    minLength: 2,
    maxLength: 6,
    selector: (spec) => spec.sticker
  })
  .chain((specs) => fc
    .record({
      orphanCount: fc.integer({ min: 1, max: specs.length - 1 }),
      consumerFlags: fc.array(fc.boolean(), {
        minLength: specs.length,
        maxLength: specs.length
      })
    })
    .map(({ orphanCount, consumerFlags }) => ({
      mode: 'suspend' as const,
      orphans: specs
        .slice(0, orphanCount)
        .map((spec, index) => ({ spec, hasConsumers: consumerFlags[index] })),
      freshSpecs: specs.slice(orphanCount).map((spec) => ({ ...spec, enabled: true })),
      failFirstAdd: true
    })));

const scenarioArb: fc.Arbitrary<Scenario> = fc.oneof(pruneScenarioArb, suspendScenarioArb);

// Feature: hub-source-orphan-remap, Property 6: Consumer-free orphans are pruned, and a failed add suspends all pruning
describe('loadHubSources — Property 6', () => {
  /**
   * **Validates: Requirements 3.7, 3.8, 9.7**
   */
  it('prunes consumer-free orphans without remapping, and a failed add suspends all pruning', async () => {
    let pruneRuns = 0;
    let suspendRuns = 0;

    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        // The config declares only the fresh sources; each orphan is a stored
        // source at its pre-rename url that no declaration re-declares.
        const declarations = scenario.freshSpecs.map((spec) => toHubSource(spec, 'new'));
        const stored = scenario.orphans.map((orphan) =>
          toStoredSource(orphan.spec, 'old', HUB_ID));
        const orphanIds = scenario.orphans.map((orphan) => storedIdFor(orphan.spec, 'old'));

        // Consumer records pin only the orphans flagged as having consumers.
        const consumerIds = scenario.orphans
          .filter((orphan) => orphan.hasConsumers)
          .map((orphan) => storedIdFor(orphan.spec, 'old'));

        const failAddForIds = scenario.failFirstAdd && scenario.freshSpecs.length > 0
          ? [storedIdFor(scenario.freshSpecs[0], 'new')]
          : [];

        const ports = portSet(stored, installedRecordSet(consumerIds), {
          failAddForIds,
          withRemap: true
        });

        const result = await loadHubSources(HUB_ID, declarations, ports);

        const storedIdsAfter = ports.sources.map((source) => source.id);

        if (scenario.mode === 'prune') {
          // Every consumer-free orphan is removed, counted, and gone from the
          // store, and the remap was never needed for the zero-consumer path.
          for (const orphanId of orphanIds) {
            expect(ports.calls.removed).toContain(orphanId);
            expect(storedIdsAfter).not.toContain(orphanId);
          }
          expect(result.removed).toBe(orphanIds.length);
          expect(ports.calls.remapped).toHaveLength(0);
          pruneRuns++;
        } else {
          // A failed add suspends pruning: no orphan is removed, every orphan
          // survives in the store, and the remap is never invoked at all.
          for (const orphanId of orphanIds) {
            expect(ports.calls.removed).not.toContain(orphanId);
            expect(storedIdsAfter).toContain(orphanId);
          }
          expect(result.removed).toBe(0);
          expect(ports.calls.remapped).toHaveLength(0);
          suspendRuns++;
        }
      }),
      { numRuns: 200 }
    );

    // Premise guards: both halves of the property must have actually run,
    // otherwise a passing suite could be hiding an unexercised branch.
    expect(pruneRuns).toBeGreaterThan(0);
    expect(suspendRuns).toBeGreaterThan(0);
  });
});
