/**
 * Property-based tests for registry/load-hub-sources.ts — the keep-alive
 * safety net.
 *
 * Generalizes Cycle J across generated hub configs. Every keep-alive reason
 * the use case distinguishes — no candidate, ambiguous candidates, a missing
 * sticker, a rejecting remap port, and an absent remap port — is produced by
 * the generator, and each one must leave the orphan and its installed bundles
 * exactly where they were. It does not replace that cycle's own unit test:
 * the example pins the specific warning text and the per-reason branch; these
 * properties widen the *outcome* guarantee to any shape the generator emits.
 *
 * This file also holds Property 5 (task 3.14, the warning-content property),
 * one property per test.
 *
 * Runs against in-memory ports only — no filesystem, no network, no host.
 */
import type {
  HubSource,
  InstalledBundle,
  RegistrySource,
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
  PortSetOptions,
} from './generators';
import {
  hubSourceDeclaration,
  installedRecordSet,
  portSet,
  recordSourceIds,
  storedIdFor,
  toHubSource,
  toStoredSource,
} from './generators';

/** The hub under sync. */
const HUB_ID = 'hub-a';

/** The five reasons an orphan with consumers is kept rather than remapped. */
type KeepAliveReason =
  | 'no-candidate'
  | 'ambiguous-candidates'
  | 'missing-sticker'
  | 'remap-failed'
  | 'port-absent';

const KEEP_ALIVE_REASONS: KeepAliveReason[] = [
  'no-candidate',
  'ambiguous-candidates',
  'missing-sticker',
  'remap-failed',
  'port-absent'
];

/** One generated keep-alive scenario before it is compiled into ports. */
interface KeepAliveSpec {
  reason: KeepAliveReason;
  /** The declaration whose pre-rename stored source becomes the orphan. */
  orphanSpec: HubSourceDeclarationSpec;
  /** Unrelated sibling declarations, distinct stickers, always registered. */
  siblingSpecs: HubSourceDeclarationSpec[];
  /** How many installed bundles pin the orphan's pre-rename id. */
  consumerCount: number;
}

const keepAliveSpecArb: fc.Arbitrary<KeepAliveSpec> = fc
  .uniqueArray(hubSourceDeclaration(), {
    minLength: 1,
    maxLength: 4,
    selector: (spec) => spec.sticker
  })
  // Every declaration is enabled: a disabled one would never register, which
  // is a different (eligibility) concern than the keep-alive outcome here.
  .map((specs) => specs.map((spec) => ({ ...spec, enabled: true })))
  .chain((specs) => fc.record<KeepAliveSpec>({
    reason: fc.constantFrom(...KEEP_ALIVE_REASONS),
    orphanSpec: fc.constant(specs[0]),
    siblingSpecs: fc.constant(specs.slice(1)),
    consumerCount: fc.integer({ min: 1, max: 3 })
  }));

/** What a compiled scenario feeds to a sync, plus the orphan to inspect. */
interface CompiledScenario {
  declarations: HubSource[];
  stored: RegistrySource[];
  consumers: InstalledBundle[];
  orphanId: string;
  portOptions: PortSetOptions;
}

/**
 * Compile a generated spec into the config, storage, records, and port wiring
 * that provoke its keep-alive reason. The orphan is always a pre-rename stored
 * source of `orphanSpec` with live consumers; only the config shape and the
 * port options differ per reason.
 * @param spec The generated keep-alive spec.
 * @returns The compiled scenario.
 */
function compile(spec: KeepAliveSpec): CompiledScenario {
  const { reason, orphanSpec, siblingSpecs, consumerCount } = spec;

  // Siblings are declared new every time, so the sync always registers real
  // sources whose stickers differ from the orphan's — they must never become
  // the orphan's replacement candidate.
  const siblingDeclarations = siblingSpecs.map((sibling) => toHubSource(sibling, 'new'));

  const orphanId = storedIdFor(orphanSpec, 'old');
  const consumers = installedRecordSet(
    Array.from({ length: consumerCount }, () => orphanId)
  );

  // The orphan carries its sticker unless the reason under test is a missing
  // one, in which case the stored record predates the feature.
  const orphanStored = toStoredSource(
    orphanSpec,
    'old',
    HUB_ID,
    reason === 'missing-sticker' ? { hubSourceId: undefined } : {}
  );

  const base = {
    stored: [orphanStored],
    consumers,
    orphanId
  };

  switch (reason) {
    case 'no-candidate': {
      // The orphan's declaration is dropped from the config, so no source
      // registered this cycle carries its sticker.
      return { ...base, declarations: siblingDeclarations, portOptions: { withRemap: true } };
    }

    case 'missing-sticker': {
      // The renamed declaration is present and registers a sticker, but the
      // orphan has none, so `undefined === undefined` proves nothing.
      return {
        ...base,
        declarations: [toHubSource(orphanSpec, 'new'), ...siblingDeclarations],
        portOptions: { withRemap: true }
      };
    }

    case 'ambiguous-candidates': {
      // Two enabled declarations share the orphan's sticker under distinct
      // urls, so both register and the match is not unique.
      const candidateA = toHubSource(orphanSpec, 'new');
      const candidateB: HubSource = {
        ...candidateA,
        url: `${candidateA.url}-alt`,
        name: `${candidateA.name} (alt)`
      };

      return {
        ...base,
        declarations: [candidateA, candidateB, ...siblingDeclarations],
        portOptions: { withRemap: true }
      };
    }

    case 'remap-failed': {
      // Exactly one candidate, but the remap port rejects before any write.
      return {
        ...base,
        declarations: [toHubSource(orphanSpec, 'new'), ...siblingDeclarations],
        portOptions: { withRemap: true, failRemap: true }
      };
    }

    default: {
      // 'port-absent': exactly one candidate, but the host wired no remap port.
      return {
        ...base,
        declarations: [toHubSource(orphanSpec, 'new'), ...siblingDeclarations],
        portOptions: { withRemap: false }
      };
    }
  }
}

// Feature: hub-source-orphan-remap, Property 4: An unprovable match keeps the orphan alive
describe('loadHubSources — Property 4', () => {
  /**
   * **Validates: Requirements 3.1, 3.3, 3.4, 3.5, 9.8, 9.11, 9.13**
   */
  it('keeps the orphan in storage and leaves every installed record untouched', async () => {
    // Guard that the generator actually exercised every keep-alive reason,
    // so a passing run is not one where whole branches were never produced.
    const reasonsSeen = new Set<KeepAliveReason>();

    await fc.assert(
      fc.asyncProperty(keepAliveSpecArb, async (spec: KeepAliveSpec) => {
        const scenario = compile(spec);
        const ports = portSet(scenario.stored, scenario.consumers, scenario.portOptions);

        // The records as they stand before the sync: nothing may move them.
        const before = recordSourceIds(ports);

        const result = await loadHubSources(HUB_ID, scenario.declarations, ports);

        // The orphan is still stored, was never removed, and is not counted.
        expect(ports.sources.map((source) => source.id)).toContain(scenario.orphanId);
        expect(ports.calls.removed).not.toContain(scenario.orphanId);
        expect(result.removed).toBe(0);

        // No installed-bundle record's sourceId changed.
        expect(recordSourceIds(ports)).toEqual(before);

        reasonsSeen.add(spec.reason);
      }),
      { numRuns: 300 }
    );

    expect([...reasonsSeen].toSorted()).toEqual([...KEEP_ALIVE_REASONS].toSorted());
  });
});

/** The exact remediation clause every keep-alive warning must end with. */
const REMEDIATION_FRAGMENT = 'keep a source\'s `id` stable when changing its `url`';

// Feature: hub-source-orphan-remap, Property 5: Keep-alive warnings carry every diagnostic fragment
describe('loadHubSources — Property 5', () => {
  /**
   * **Validates: Requirements 3.6**
   */
  it('emits exactly one warn per orphan carrying every diagnostic fragment', async () => {
    const reasonsSeen = new Set<KeepAliveReason>();

    await fc.assert(
      fc.asyncProperty(keepAliveSpecArb, async (spec: KeepAliveSpec) => {
        const scenario = compile(spec);
        const ports = portSet(scenario.stored, scenario.consumers, scenario.portOptions);

        // The orphan is the single pre-rename stored source the scenario built.
        const [orphan] = scenario.stored;
        const consumerCount = scenario.consumers.length;

        // Capture every log event so the warning content can be inspected.
        const events: { level: string; message: string }[] = [];

        await loadHubSources(HUB_ID, scenario.declarations, ports, (event) => {
          events.push({ level: event.level, message: event.message });
        });

        // Exactly one warn event references this orphan by id.
        const orphanWarnings = events.filter(
          (event) => event.level === 'warn' && event.message.includes(orphan.id)
        );
        expect(orphanWarnings).toHaveLength(1);

        const [{ message }] = orphanWarnings;

        // Every diagnostic fragment the requirement enumerates is present.
        expect(message).toContain(orphan.id);
        expect(message).toContain(orphan.name);
        expect(message).toContain(`${consumerCount} installed bundle(s)`);
        expect(message).toContain(`[${spec.reason}]`);
        expect(message).toContain(REMEDIATION_FRAGMENT);

        reasonsSeen.add(spec.reason);
      }),
      { numRuns: 300 }
    );

    expect([...reasonsSeen].toSorted()).toEqual([...KEEP_ALIVE_REASONS].toSorted());
  });
});
