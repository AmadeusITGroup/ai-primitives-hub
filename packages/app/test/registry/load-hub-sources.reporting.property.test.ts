/**
 * Property-based test for registry/load-hub-sources.ts — a successful remap is
 * fully reported.
 *
 * Generalizes Cycle K across generated multi-source hub configs: several
 * declarations carrying distinct stickers, exactly one of them renamed by
 * `url` only, with installed bundles pinned to the pre-rename stored id, so
 * the sync performs a real remap-and-remove. It does not replace that cycle's
 * own unit test: the example pins the specific `info` message for one config;
 * this property widens the reporting guarantee to any shape the generator can
 * produce — exactly one `info` event referencing the orphan, carrying the
 * remapped record count, the old id, the new id, and the matched sticker.
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
  // surrounded by siblings whose own writes also emit info events — the
  // "exactly one" clause has to hold amid that noise.
  config: hubConfigWithOneRename({ minLength: 1, maxLength: 5 }),
  consumerCount: fc.integer({ min: 1, max: 3 })
});

// Feature: hub-source-orphan-remap, Property 11: A successful remap is fully reported
describe('loadHubSources — Property 11', () => {
  /**
   * **Validates: Requirements 7.1**
   */
  it('emits exactly one info event naming the record count, old id, new id, and sticker', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ config, consumerCount }: Scenario) => {
        const renamedSpec = config.specs[config.renamedIndex];

        // The config declares the renamed entry at its new url and every
        // sibling at its unchanged old url.
        const declarations = config.specs.map((spec, index) =>
          toHubSource(spec, declaredVariant(config, index)));

        // Storage holds every declaration at its pre-rename url, so the renamed
        // entry's stored id orphans while its successor registers this cycle.
        const stored = config.specs.map((spec) => toStoredSource(spec, 'old', HUB_ID));

        const orphanOldId = storedIdFor(renamedSpec, 'old');
        const orphanNewId = storedIdFor(renamedSpec, 'new');

        // Installed bundles pin the pre-rename stored id, so the orphan is
        // remapped onto its successor rather than simply pruned.
        const consumers = installedRecordSet(
          Array.from({ length: consumerCount }, () => orphanOldId)
        );

        const ports = portSet(stored, consumers, { withRemap: true });

        // Capture every log event so the success report can be inspected.
        const events: { level: string; message: string }[] = [];

        const result = await loadHubSources(HUB_ID, declarations, ports, (event) => {
          events.push({ level: event.level, message: event.message });
        });

        // Premise guard: the scenario really did perform the remap-and-remove
        // whose reporting this property is about.
        expect(result.removed).toBe(1);
        expect(ports.calls.remapped).toEqual([
          { oldSourceId: orphanOldId, newSourceId: orphanNewId }
        ]);

        // Exactly one info event references the orphan by its pre-rename id.
        const successReports = events.filter(
          (event) => event.level === 'info' && event.message.includes(orphanOldId)
        );
        expect(successReports).toHaveLength(1);

        const [{ message }] = successReports;

        // That single event names every fragment Requirement 7.1 enumerates:
        // the number of remapped records, the old id, the new id, and the
        // hubSourceId that proved the match.
        expect(message).toContain(`${consumerCount} installed bundle record(s)`);
        expect(message).toContain(orphanOldId);
        expect(message).toContain(orphanNewId);
        expect(message).toContain(`"${renamedSpec.sticker}"`);
      })
    );
  });
});
