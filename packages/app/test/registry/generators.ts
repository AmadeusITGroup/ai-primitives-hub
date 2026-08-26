/**
 * Shared fast-check generators and in-memory port fakes for the
 * `loadHubSources` property tests (design.md §Testing Strategy →
 * Generators).
 *
 * `portSet` is the generalized form of the `makePorts` helper in
 * `load-hub-sources.test.ts`: the same in-memory `HubSourceSync` over a
 * mutable source array, extended with a call log, real installation records,
 * an optional `remapBundleSource` port, and injectable rejection points so a
 * property can drive the failure branches without mocking the unit under
 * test.
 *
 * Everything here is in-memory: no filesystem, no network, no host.
 * @module test/registry/generators
 */
import type {
  HubSource,
  HubSourceSync,
  InstallationScope,
  InstalledBundle,
  RegistrySource,
  SourceType,
} from '@ai-primitives-hub/core';
import {
  generateSourceId,
} from '@ai-primitives-hub/core';
import * as fc from 'fast-check';

/** Source types a generated declaration can carry, kept to a spread. */
export const SOURCE_TYPES: SourceType[] = ['github', 'awesome-copilot', 'apm', 'skills'];

/**
 * A schema-valid hub declaration `id` (`^[a-zA-Z0-9-_]+$`) drawn from a
 * small pool, so distinct declarations and stored stickers collide often
 * enough for matching to be exercised rather than trivially unique.
 */
export const stickerArb: fc.Arbitrary<string> = fc
  .tuple(fc.constantFrom('src', 'coll', 'pack'), fc.integer({ min: 0, max: 5 }))
  .map(([prefix, index]) => `${prefix}_${index}`);

/**
 * One generated hub source declaration. The `url` is derived from the
 * sticker so distinct declarations carry distinct urls — and therefore
 * distinct generated stored ids — without a second uniqueness constraint.
 */
export interface HubSourceDeclarationSpec {
  sticker: string;
  type: SourceType;
  enabled: boolean;
  branch?: string;
  collectionsPath?: string;
}

/**
 * A declaration spec: a schema-valid sticker, a type, an `enabled` flag,
 * and optional `branch`/`collectionsPath` so both the defaulted and the
 * explicit descriptor shapes occur.
 * @returns An arbitrary declaration spec.
 */
export function hubSourceDeclaration(): fc.Arbitrary<HubSourceDeclarationSpec> {
  return fc.record<HubSourceDeclarationSpec>({
    sticker: stickerArb,
    type: fc.constantFrom(...SOURCE_TYPES),
    enabled: fc.boolean(),
    branch: fc.option(fc.constantFrom('main', 'release'), { nil: undefined }),
    collectionsPath: fc.option(fc.constantFrom('collections', 'curated'), { nil: undefined })
  });
}

/**
 * The url a declaration spec resolves to, in either its pre-rename or its
 * post-rename form. A rename changes only the url, never the sticker —
 * which is exactly the situation orphan matching has to survive.
 * @param spec The declaration spec.
 * @param variant Which url generation to produce.
 * @returns The url for that variant.
 */
export function urlFor(spec: HubSourceDeclarationSpec, variant: 'old' | 'new'): string {
  return `https://github.com/org/${spec.sticker}${variant === 'old' ? '-old' : '-new'}`;
}

/**
 * Turn a declaration spec into the `HubSource` a hub config would carry.
 * @param spec The declaration spec.
 * @param variant Which url generation the config declares.
 * @returns The hub source declaration.
 */
export function toHubSource(
  spec: HubSourceDeclarationSpec,
  variant: 'old' | 'new'
): HubSource {
  return {
    id: spec.sticker,
    name: `Source ${spec.sticker}`,
    type: spec.type,
    url: urlFor(spec, variant),
    enabled: spec.enabled,
    priority: 1,
    config: { branch: spec.branch, collectionsPath: spec.collectionsPath }
  };
}

/**
 * The stored id a declaration spec resolves to for one url generation — the
 * same derivation `loadHubSources` performs, so a test can name the id a sync
 * is about to produce without reaching into the implementation.
 * @param spec The declaration spec.
 * @param variant Which url generation to derive from.
 * @returns The generated stored source id.
 */
export function storedIdFor(
  spec: HubSourceDeclarationSpec,
  variant: 'old' | 'new'
): string {
  return generateSourceId(spec.type, urlFor(spec, variant), {
    branch: spec.branch,
    collectionsPath: spec.collectionsPath
  });
}

/**
 * A declaration list where exactly one entry's `url` moved to its
 * post-rename generation while its `id` stayed put — the situation orphan
 * matching exists for. Every declaration is enabled, so each one is actually
 * registered and the renamed entry has real siblings competing to be picked.
 */
export interface OneRenameSpec {
  specs: HubSourceDeclarationSpec[];
  /** Index into `specs` of the declaration whose url was renamed. */
  renamedIndex: number;
}

/**
 * A multi-source hub config with exactly one renamed declaration.
 * @param options Bounds on how many declarations the hub carries.
 * @param options.minLength
 * @param options.maxLength
 * @returns An arbitrary one-rename hub config.
 */
export function hubConfigWithOneRename(
  options: { minLength?: number; maxLength?: number } = {}
): fc.Arbitrary<OneRenameSpec> {
  const minLength = options.minLength ?? 1;
  const maxLength = options.maxLength ?? 5;

  return fc
    .uniqueArray(hubSourceDeclaration(), {
      minLength,
      maxLength,
      selector: (spec) => spec.sticker
    })
    .chain((specs) => fc
      .integer({ min: 0, max: specs.length - 1 })
      .map((renamedIndex) => ({
        // Disabled declarations are never registered, so they could not be
        // replacement candidates and would make the property vacuous.
        specs: specs.map((spec) => ({ ...spec, enabled: true })),
        renamedIndex
      })));
}

/**
 * The url generation a declaration is *declared* at in a one-rename config:
 * the renamed entry moved to its new url, every sibling stayed on its old one.
 * @param scenario The one-rename config.
 * @param index Index into `scenario.specs`.
 * @returns Which url generation the config declares for that entry.
 */
export function declaredVariant(scenario: OneRenameSpec, index: number): 'old' | 'new' {
  return index === scenario.renamedIndex ? 'new' : 'old';
}

/**
 * Build a stored source, defaulting every field a test does not care about.
 * @param overrides Fields to set on the stored source.
 * @returns The stored source.
 */
export function makeRegistrySource(overrides: Partial<RegistrySource> = {}): RegistrySource {
  return {
    id: 'stored-source',
    name: 'Stored Source',
    type: 'awesome-copilot',
    url: 'https://github.com/org/stored',
    enabled: true,
    priority: 1,
    config: { branch: 'main', collectionsPath: 'collections' },
    ...overrides
  };
}

/**
 * The stored source a declaration spec would have been persisted as, at one
 * url generation. Carries the sticker, so a source stored at the pre-rename
 * url is a matchable orphan rather than an unprovable one.
 * @param spec The declaration spec.
 * @param variant Which url generation the stored record holds.
 * @param hubId The hub the source is attributed to.
 * @param overrides Fields to override on the stored source.
 * @returns The stored source.
 */
export function toStoredSource(
  spec: HubSourceDeclarationSpec,
  variant: 'old' | 'new',
  hubId: string,
  overrides: Partial<RegistrySource> = {}
): RegistrySource {
  return makeRegistrySource({
    id: storedIdFor(spec, variant),
    name: `Source ${spec.sticker}${variant === 'old' ? ' (pre-rename)' : ''}`,
    type: spec.type,
    url: urlFor(spec, variant),
    config: { branch: spec.branch, collectionsPath: spec.collectionsPath },
    hubId,
    hubSourceId: spec.sticker,
    ...overrides
  });
}

/**
 * Build one installation record pointing at a source id. Only `sourceId`
 * matters to orphan handling; the rest exists so the record is a real
 * `InstalledBundle` rather than a structural stand-in.
 * @param bundleId Bundle identifier, unique per record.
 * @param sourceId The source the record references.
 * @param scope The installation scope.
 * @returns The installation record.
 */
export function makeInstalledBundle(
  bundleId: string,
  sourceId: string,
  scope: InstallationScope = 'user'
): InstalledBundle {
  return {
    bundleId,
    version: '1.0.0',
    installedAt: '2024-01-01T00:00:00.000Z',
    scope,
    installPath: `/mock/${scope}/${bundleId}`,
    sourceId,
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
 * Installation records referencing the given source ids, one record per id
 * with a unique bundle id so nothing collapses on upsert.
 * @param sourceIds Source ids the records reference, in order.
 * @returns The installation records.
 */
export function installedRecordSet(sourceIds: string[]): InstalledBundle[] {
  return sourceIds.map((sourceId, index) => makeInstalledBundle(`bundle-${index}`, sourceId));
}

/** Every call a sync made through the ports, in invocation order. */
export interface HubSourceSyncCalls {
  /** Sources a successful `addSource` wrote. */
  added: RegistrySource[];
  /** Sources a successful `updateSource` wrote. */
  updated: { sourceId: string; updates: Partial<RegistrySource> }[];
  /** Source ids `removeSource` was called with. */
  removed: string[];
  /** Every remap invocation, whether it resolved or rejected. */
  remapped: { oldSourceId: string; newSourceId: string }[];
}

/** In-memory `HubSourceSync` with its store and its call log exposed. */
export interface RecordingHubSourcePorts extends HubSourceSync {
  /** The live store, mutated by add/update/remove. */
  sources: RegistrySource[];
  /** The live installation records, repointed by a successful remap. */
  installed: InstalledBundle[];
  calls: HubSourceSyncCalls;
}

/** Injectable failure points and port wiring for `portSet`. */
export interface PortSetOptions {
  /** Stored source ids whose `addSource` must reject. */
  failAddForIds?: readonly string[];
  /** Wire the optional `remapBundleSource` port (default `true`). */
  withRemap?: boolean;
  /** Make every remap invocation reject. */
  failRemap?: boolean;
}

/**
 * In-memory `HubSourceSync` over a mutable source array, recording every
 * write so a property can compare what a sync attempted against what
 * storage actually received.
 * @param initial Stored sources the sync starts from.
 * @param installed Installation records `listInstalledBundles` returns.
 * @param options Failure injection and port wiring.
 * @returns The recording ports.
 */
export function portSet(
  initial: RegistrySource[] = [],
  installed: InstalledBundle[] = [],
  options: PortSetOptions = {}
): RecordingHubSourcePorts {
  const sources = structuredClone(initial);
  const records = structuredClone(installed);
  const failAddForIds = new Set(options.failAddForIds);
  const calls: HubSourceSyncCalls = { added: [], updated: [], removed: [], remapped: [] };

  const ports: RecordingHubSourcePorts = {
    sources,
    installed: records,
    calls,
    listSources: () => Promise.resolve(structuredClone(sources)),
    addSource: (source: RegistrySource) => {
      if (failAddForIds.has(source.id)) {
        return Promise.reject(new Error(`Source validation failed for ${source.id}`));
      }
      sources.push(structuredClone(source));
      calls.added.push(structuredClone(source));

      return Promise.resolve();
    },
    updateSource: (sourceId: string, updates: Partial<RegistrySource>) => {
      const index = sources.findIndex((source) => source.id === sourceId);
      if (index !== -1) {
        sources[index] = { ...sources[index], ...updates };
      }
      calls.updated.push({ sourceId, updates: structuredClone(updates) });

      return Promise.resolve();
    },
    removeSource: (sourceId: string) => {
      const index = sources.findIndex((source) => source.id === sourceId);
      if (index !== -1) {
        sources.splice(index, 1);
      }
      calls.removed.push(sourceId);

      return Promise.resolve();
    },
    listInstalledBundles: () => Promise.resolve(structuredClone(records))
  };

  if (options.withRemap ?? true) {
    ports.remapBundleSource = (oldSourceId: string, newSourceId: string) => {
      calls.remapped.push({ oldSourceId, newSourceId });

      if (options.failRemap) {
        // Reject before touching a record, mirroring the real use case's
        // resolve-first-or-throw order: a keep-alive must be observable as
        // records that never moved, not merely as a call that was logged.
        return Promise.reject(new Error(`remap ${oldSourceId} -> ${newSourceId} failed`));
      }

      for (const record of records) {
        if (record.sourceId === oldSourceId) {
          record.sourceId = newSourceId;
        }
      }

      return Promise.resolve();
    };
  }

  return ports;
}

/**
 * The installation records as they stand now, so a property can compare the
 * store before and after a sync.
 * @param ports The recording ports a sync ran against.
 * @returns Bundle id to the source id it currently references.
 */
export function recordSourceIds(ports: RecordingHubSourcePorts): Map<string, string> {
  return new Map(ports.installed.map((record) => [record.bundleId, record.sourceId]));
}

/**
 * The ids storage actually received this cycle: every id a successful
 * `addSource` or `updateSource` wrote. The only pool a remap target may
 * legitimately come from.
 * @param ports The recording ports a sync ran against.
 * @returns The written source ids.
 */
export function writtenSourceIds(ports: RecordingHubSourcePorts): Set<string> {
  return new Set([
    ...ports.calls.added.map((source) => source.id),
    ...ports.calls.updated.map((update) => update.sourceId)
  ]);
}
