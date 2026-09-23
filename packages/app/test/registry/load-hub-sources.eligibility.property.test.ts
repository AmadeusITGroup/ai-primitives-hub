/**
 * Property-based test for registry/load-hub-sources.ts — replacement
 * eligibility.
 *
 * Generalizes Cycle H (the phantom-target hazard) across generated hub
 * configs: declarations that are disabled, declarations whose `addSource`
 * rejects, declarations already stored under their declared url, and
 * declarations whose url was renamed while their `id` stayed put — with
 * installed bundles pinned to the pre-rename stored ids. It does not replace
 * that cycle's own tests: they pin the exact call counts and the suspension
 * of orphan evaluation that this property only constrains structurally.
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
  makeRegistrySource,
  portSet,
  storedIdFor,
  toHubSource,
  urlFor,
  writtenSourceIds,
} from './generators';

/** The hub under sync. */
const HUB_ID = 'hub-a';

/** One declaration and the storage situation it is synced against. */
interface DeclarationScenario {
  spec: HubSourceDeclarationSpec;
  /** A stored source holds the pre-rename url, so it orphans on this sync. */
  renamed: boolean;
  /** A stored source already holds the declared url, so the sync updates it. */
  storedCurrent: boolean;
  /** Installed records reference the pre-rename stored id. */
  hasConsumers: boolean;
  /** `addSource` rejects for this declaration's generated id. */
  addFails: boolean;
}

/** One generated sync scenario. */
interface Scenario {
  declarations: DeclarationScenario[];
  withRemap: boolean;
  failRemap: boolean;
}

const declarationScenarioArb = fc.record<DeclarationScenario>({
  spec: hubSourceDeclaration(),
  renamed: fc.boolean(),
  storedCurrent: fc.boolean(),
  hasConsumers: fc.boolean(),
  addFails: fc.boolean()
});

const scenarioArb = fc.record<Scenario>({
  declarations: fc.uniqueArray(declarationScenarioArb, {
    minLength: 1,
    maxLength: 5,
    selector: (declaration) => declaration.spec.sticker
  }),
  withRemap: fc.boolean(),
  failRemap: fc.boolean()
});

// Feature: hub-source-orphan-remap, Property 3: Every remap target was registered this cycle
describe('loadHubSources — Property 3', () => {
  /**
   * **Validates: Requirements 4.1, 4.3**
   */
  it('only ever remaps onto a source id a successful add or update wrote this cycle', async () => {
    let runsThatRemapped = 0;

    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        // The config always declares the post-rename url. A `renamed`
        // declaration additionally has a stored source at its pre-rename url,
        // which is what turns into an orphan on this sync.
        const declarations = scenario.declarations.map((declaration) =>
          toHubSource(declaration.spec, 'new'));

        const stored = scenario.declarations.flatMap((declaration) => [
          ...declaration.renamed
            ? [makeRegistrySource({
              id: storedIdFor(declaration.spec, 'old'),
              name: `Source ${declaration.spec.sticker} (pre-rename)`,
              type: declaration.spec.type,
              url: urlFor(declaration.spec, 'old'),
              config: {
                branch: declaration.spec.branch,
                collectionsPath: declaration.spec.collectionsPath
              },
              hubId: HUB_ID,
              hubSourceId: declaration.spec.sticker
            })]
            : [],
          ...declaration.storedCurrent
            ? [makeRegistrySource({
              id: storedIdFor(declaration.spec, 'new'),
              name: `Source ${declaration.spec.sticker}`,
              type: declaration.spec.type,
              url: urlFor(declaration.spec, 'new'),
              config: {
                branch: declaration.spec.branch,
                collectionsPath: declaration.spec.collectionsPath
              },
              hubId: HUB_ID,
              hubSourceId: declaration.spec.sticker
            })]
            : []
        ]);

        const consumerIds = scenario.declarations
          .filter((declaration) => declaration.renamed && declaration.hasConsumers)
          .map((declaration) => storedIdFor(declaration.spec, 'old'));

        const ports = portSet(stored, installedRecordSet(consumerIds), {
          failAddForIds: scenario.declarations
            .filter((declaration) => declaration.addFails)
            .map((declaration) => storedIdFor(declaration.spec, 'new')),
          withRemap: scenario.withRemap,
          failRemap: scenario.failRemap
        });

        await loadHubSources(HUB_ID, declarations, ports);

        // The pool a remap target may legitimately be drawn from: ids storage
        // actually received. Disabled declarations, rejected adds and matched
        // duplicates are protected from pruning but never written, so a remap
        // onto one of them would point installed bundles at a phantom source.
        const registered = writtenSourceIds(ports);

        for (const { newSourceId } of ports.calls.remapped) {
          expect(registered).toContain(newSourceId);
        }

        if (ports.calls.remapped.length > 0) {
          runsThatRemapped++;
        }
      }),
      { numRuns: 200 }
    );

    // Premise guard: a property about remap targets is vacuous if the
    // generator never produced a remap.
    expect(runsThatRemapped).toBeGreaterThan(0);
  });
});
