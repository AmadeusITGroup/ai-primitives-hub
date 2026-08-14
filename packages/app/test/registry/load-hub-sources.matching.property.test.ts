/**
 * Property-based test for registry/load-hub-sources.ts — the renamed source is
 * the exact replacement.
 *
 * Generalizes Cycle I (the FN-1 defect) across generated multi-source hub
 * configs: several declarations carrying distinct stickers, exactly one of
 * them renamed by `url` only, with installed bundles pinned to the pre-rename
 * stored id. It does not replace that cycle's own test: the example pins the
 * exact `remapBundleSource` argument pair and the sibling ids that must never
 * appear; this property widens that guarantee to any shape the generator can
 * produce.
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
  OneRenameSpec,
} from './generators';
import {
  declaredVariant,
  hubConfigWithOneRename,
  installedRecordSet,
  portSet,
  storedIdFor,
  toHubSource,
  toStoredSource,
} from './generators';

/** The hub under sync. */
const HUB_ID = 'hub-a';

/** A one-rename hub config plus how many installed bundles pin the orphan. */
interface Scenario {
  config: OneRenameSpec;
  consumerCount: number;
}

const scenarioArb = fc.record({
  // At least one declaration; up to five, so the renamed entry is frequently
  // surrounded by siblings competing to be picked as the replacement.
  config: hubConfigWithOneRename({ minLength: 1, maxLength: 5 }),
  consumerCount: fc.integer({ min: 1, max: 3 })
});

// Feature: hub-source-orphan-remap, Property 1: The renamed source is the exact replacement
describe('loadHubSources — Property 1', () => {
  /**
   * **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.6, 9.10**
   */
  it('remaps the pre-rename id onto the renamed declaration id, never onto a sibling', async () => {
    let runsWithSiblings = 0;

    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ config, consumerCount }: Scenario) => {
        const renamedSpec = config.specs[config.renamedIndex];

        // The config declares the renamed entry at its new url and every
        // sibling at its unchanged old url.
        const declarations = config.specs.map((spec, index) =>
          toHubSource(spec, declaredVariant(config, index)));

        // Storage holds every declaration at its pre-rename url. Siblings
        // therefore match their declared id and update in place; the renamed
        // entry's stored id no longer matches any declaration, so it orphans.
        const stored = config.specs.map((spec) => toStoredSource(spec, 'old', HUB_ID));

        const orphanOldId = storedIdFor(renamedSpec, 'old');
        const orphanNewId = storedIdFor(renamedSpec, 'new');

        // Installed bundles pin the pre-rename stored id, so the orphan cannot
        // simply be pruned — it must be remapped onto its successor.
        const consumers = installedRecordSet(
          Array.from({ length: consumerCount }, () => orphanOldId)
        );

        const ports = portSet(stored, consumers, { withRemap: true });

        const result = await loadHubSources(HUB_ID, declarations, ports);

        // Exactly one remap, and its argument pair is the renamed source's own
        // pre-rename id mapped onto its own post-rename id.
        expect(ports.calls.remapped).toHaveLength(1);
        expect(ports.calls.remapped[0]).toEqual({
          oldSourceId: orphanOldId,
          newSourceId: orphanNewId
        });

        // No sibling id — in either url generation — may ever be handed to the
        // remap as the replacement. This is the FN-1 defect the property closes.
        const siblingIds = config.specs
          .filter((_, index) => index !== config.renamedIndex)
          .flatMap((spec) => [storedIdFor(spec, 'old'), storedIdFor(spec, 'new')]);

        for (const { newSourceId } of ports.calls.remapped) {
          expect(siblingIds).not.toContain(newSourceId);
        }

        // The orphan is gone from storage and counted as removed, exactly once.
        expect(ports.sources.map((source) => source.id)).not.toContain(orphanOldId);
        expect(ports.calls.removed).toContain(orphanOldId);
        expect(result.removed).toBe(1);

        if (config.specs.length > 1) {
          runsWithSiblings++;
        }
      })
    );

    // Premise guard: the "never a sibling" clause is only meaningful when the
    // generator actually produced siblings to reject.
    expect(runsWithSiblings).toBeGreaterThan(0);
  });
});
