/**
 * Property-based test for registry/load-hub-sources.ts — sticker persistence.
 *
 * Generalizes Cycle G across generated hub configs: declarations that are new
 * to storage, declarations already stored under the declared url *with* a
 * sticker, declarations already stored *without* one (the pre-feature record
 * whose sticker has to be backfilled), and declarations whose url was renamed
 * while their `id` stayed put. It does not replace that cycle's own tests:
 * they pin the exact payload shape and the no-`id` edge case that this
 * property leaves out by construction.
 *
 * Runs against in-memory ports only — no filesystem, no network, no host.
 */
import {
  generateSourceId,
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
  HubSourceDeclarationSpec,
} from './generators';
import {
  hubSourceDeclaration,
  makeRegistrySource,
  portSet,
  toHubSource,
  urlFor,
} from './generators';

/** The hub under sync. */
const HUB_ID = 'hub-a';

/** How a declaration is already represented in storage, if at all. */
type StoredShape =
  /** Nothing stored: the sync adds a new record. */
  | 'absent'
  /** Stored at the declared url with its sticker: the sync updates it. */
  | 'current-with-sticker'
  /** Stored at the declared url without a sticker: the sync backfills it. */
  | 'current-without-sticker'
  /** Stored at the pre-rename url: it orphans, and the sync adds the new id. */
  | 'renamed';

/** One declaration and the storage situation it is synced against. */
interface DeclarationScenario {
  spec: HubSourceDeclarationSpec;
  stored: StoredShape;
}

const declarationScenarioArb = fc.record<DeclarationScenario>({
  spec: hubSourceDeclaration(),
  stored: fc.constantFrom<StoredShape>(
    'absent',
    'current-with-sticker',
    'current-without-sticker',
    'renamed'
  )
});

const scenarioArb = fc.uniqueArray(declarationScenarioArb, {
  minLength: 1,
  maxLength: 5,
  selector: (declaration) => declaration.spec.sticker
});

/**
 * The stored id a declaration resolves to for one url generation — the same
 * derivation `loadHubSources` performs.
 * @param spec The declaration spec.
 * @param variant Which url generation to derive from.
 * @returns The generated stored source id.
 */
function storedIdFor(spec: HubSourceDeclarationSpec, variant: 'old' | 'new'): string {
  return generateSourceId(spec.type, urlFor(spec, variant), {
    branch: spec.branch,
    collectionsPath: spec.collectionsPath
  });
}

// Feature: hub-source-orphan-remap, Property 10: The sticker is persisted on every write
describe('loadHubSources — Property 10', () => {
  /**
   * **Validates: Requirements 1.1, 1.2, 1.3**
   */
  it('writes hubSourceId equal to the declaration id on every added and updated source', async () => {
    let runsThatAdded = 0;
    let runsThatUpdated = 0;
    let runsThatBackfilled = 0;

    await fc.assert(
      fc.asyncProperty(scenarioArb, async (declarations) => {
        // The config always declares the post-rename url; storage holds the
        // pre-rename record only for the `renamed` shape.
        const hubSources = declarations.map((declaration) =>
          toHubSource(declaration.spec, 'new'));

        // Stored id -> the sticker its declaration carries. Every write the
        // sync performs must land the sticker this map names.
        const expectedSticker = new Map(declarations.map((declaration) => [
          storedIdFor(declaration.spec, 'new'),
          declaration.spec.sticker
        ]));

        const stored = declarations.flatMap((declaration) => {
          const { spec, stored: shape } = declaration;
          const base = {
            name: `Source ${spec.sticker}`,
            type: spec.type,
            config: { branch: spec.branch, collectionsPath: spec.collectionsPath },
            hubId: HUB_ID
          };

          if (shape === 'renamed') {
            return [makeRegistrySource({
              ...base,
              id: storedIdFor(spec, 'old'),
              url: urlFor(spec, 'old'),
              hubSourceId: spec.sticker
            })];
          }

          if (shape === 'current-with-sticker') {
            return [makeRegistrySource({
              ...base,
              id: storedIdFor(spec, 'new'),
              url: urlFor(spec, 'new'),
              hubSourceId: spec.sticker
            })];
          }

          if (shape === 'current-without-sticker') {
            // The pre-feature record: same stored id, no sticker key at all.
            return [makeRegistrySource({
              ...base,
              id: storedIdFor(spec, 'new'),
              url: urlFor(spec, 'new')
            })];
          }

          return [];
        });

        const backfillIds = declarations
          .filter((declaration) => declaration.stored === 'current-without-sticker'
            && declaration.spec.enabled)
          .map((declaration) => storedIdFor(declaration.spec, 'new'));

        const ports = portSet(stored);

        await loadHubSources(HUB_ID, hubSources, ports);

        for (const source of ports.calls.added) {
          expect(source.hubSourceId).toBe(expectedSticker.get(source.id));
        }

        for (const update of ports.calls.updated) {
          expect(update.updates.hubSourceId).toBe(expectedSticker.get(update.sourceId));
        }

        // The observable end state, not just the call payloads: every id
        // storage received this cycle holds its declaration's sticker,
        // including the records that were persisted without the field.
        const writtenIds = [
          ...ports.calls.added.map((source) => source.id),
          ...ports.calls.updated.map((update) => update.sourceId)
        ];

        for (const id of writtenIds) {
          const persisted = ports.sources.find((source) => source.id === id);
          expect(persisted?.hubSourceId).toBe(expectedSticker.get(id));
        }

        for (const id of backfillIds) {
          expect(writtenIds).toContain(id);
        }

        if (ports.calls.added.length > 0) {
          runsThatAdded++;
        }
        if (ports.calls.updated.length > 0) {
          runsThatUpdated++;
        }
        if (backfillIds.length > 0) {
          runsThatBackfilled++;
        }
      }),
      { numRuns: 200 }
    );

    // Premise guards: a property about writes is vacuous unless the generator
    // produced adds, updates, and at least one sticker-less record to backfill.
    expect(runsThatAdded).toBeGreaterThan(0);
    expect(runsThatUpdated).toBeGreaterThan(0);
    expect(runsThatBackfilled).toBeGreaterThan(0);
  });
});
