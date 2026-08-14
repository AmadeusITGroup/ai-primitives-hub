/**
 * Property-based test for registry/load-hub-sources.ts — replacement selection
 * is invariant under concurrency.
 *
 * Generalizes the determinism guard in `load-hub-sources.test.ts`
 * (`replacementIdAtConcurrency`, which pins the renamed three-source hub at
 * `concurrency: 1` versus `concurrency: 4`) across any one-rename hub config
 * the generator can produce. The exactly-one-candidate rule in `loadHubSources`
 * makes selection independent of the order workers populated the
 * `registeredThisCycle` map in, so a sync at `concurrency > 1` must hand the
 * remap the same argument pair as a sync at `concurrency: 1`.
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

/** A one-rename hub config, its consumer count, and a concurrency above one. */
interface Scenario {
  config: OneRenameSpec;
  consumerCount: number;
  concurrency: number;
}

const scenarioArb = fc.record({
  // Two or more declarations, so the renamed entry always has siblings whose
  // registration order across workers could otherwise shift the selection.
  config: hubConfigWithOneRename({ minLength: 2, maxLength: 5 }),
  consumerCount: fc.integer({ min: 1, max: 3 }),
  concurrency: fc.integer({ min: 2, max: 6 })
});

/**
 * Run one sync of a one-rename hub config at the given concurrency and return
 * the single remap invocation's argument pair.
 * @param config The one-rename hub config.
 * @param consumerCount How many installed bundles pin the orphan.
 * @param concurrency The `concurrency` option to pass to the sync.
 * @returns The `{ oldSourceId, newSourceId }` the remap was invoked with.
 */
async function remapArgsAtConcurrency(
  config: OneRenameSpec,
  consumerCount: number,
  concurrency: number
): Promise<{ oldSourceId: string; newSourceId: string }> {
  const renamedSpec = config.specs[config.renamedIndex];
  const declarations = config.specs.map((spec, index) =>
    toHubSource(spec, declaredVariant(config, index)));
  const stored = config.specs.map((spec) => toStoredSource(spec, 'old', HUB_ID));
  const orphanOldId = storedIdFor(renamedSpec, 'old');
  const consumers = installedRecordSet(
    Array.from({ length: consumerCount }, () => orphanOldId)
  );

  const ports = portSet(stored, consumers, { withRemap: true });

  await loadHubSources(HUB_ID, declarations, ports, undefined, { concurrency });

  expect(ports.calls.remapped).toHaveLength(1);

  return ports.calls.remapped[0];
}

// Feature: hub-source-orphan-remap, Property 2: Replacement selection is invariant under concurrency
describe('loadHubSources — Property 2', () => {
  /**
   * **Validates: Requirements 2.5, 9.15**
   */
  it('selects the same replacement id at concurrency greater than 1 as at concurrency 1', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ config, consumerCount, concurrency }: Scenario) => {
        const sequential = await remapArgsAtConcurrency(config, consumerCount, 1);
        const parallel = await remapArgsAtConcurrency(config, consumerCount, concurrency);

        // Selection is invariant: the same orphan id maps onto the same
        // replacement id regardless of how many workers ran the registration.
        expect(parallel).toEqual(sequential);
      })
    );
  });
});
