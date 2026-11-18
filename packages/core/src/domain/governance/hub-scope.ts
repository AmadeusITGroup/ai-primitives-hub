/** Pure semantic selection. No checkout state, IO, or defaults are consulted. */
export type HubEntity = Record<string, unknown> & { id: string };
export interface HubScopeDocument extends Record<string, unknown> {
  sources: HubEntity[];
  profiles: HubEntity[];
}
export interface HubScopeReference {
  profileId: string;
  source: string;
  id: string;
  version: string;
}
export interface HubScope {
  schemaVersion: 1;
  sources: { added: string[]; modified: string[]; removed: string[] };
  profiles: { added: string[]; modified: string[]; removed: string[] };
  sourceIds: string[];
  profileIds: string[];
  references: HubScopeReference[];
  removedReferences: HubScopeReference[];
  reasons: { entity: 'source' | 'profile'; id: string; reason: string }[];
  globalChanged: boolean;
  noOp: boolean;
}

/**
 * Stable serialization ignores mapping order, but preserves meaningful array order.
 * @param value
 */
export function semanticHubValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => semanticHubValue(entry)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${semanticHubValue(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/**
 * Validate identity before building maps: duplicates must never be overwritten.
 * @param value
 */
export function assertHubScopeDocument(value: unknown): asserts value is HubScopeDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Hub root must be a mapping.');
  }
  const root = value as Record<string, unknown>;
  for (const kind of ['sources', 'profiles']) {
    const entries = root[kind] === undefined && kind === 'profiles' ? [] : root[kind];
    if (!Array.isArray(entries)) {
      throw new Error(`${kind} must be an array.`);
    }
    const ids = new Set<string>();
    for (const candidate of entries as unknown[]) {
      const entry = candidate !== null && typeof candidate === 'object' ? candidate as Record<string, unknown> : {};
      if (typeof entry.id !== 'string' || !/^[a-zA-Z0-9_-]{1,50}$/.test(entry.id)) {
        throw new Error(`Malformed ${kind} ID.`);
      }
      if (ids.has(entry.id)) {
        throw new Error(`Duplicate ${kind} ID '${entry.id}'.`);
      }
      ids.add(entry.id);
      if (kind === 'profiles' && Array.isArray(entry.bundles)) {
        for (const reference of entry.bundles as unknown[]) {
          const ref = reference !== null && typeof reference === 'object' ? reference as Record<string, unknown> : {};
          if (typeof ref.id !== 'string' || !/^[\w.-]{1,200}$/.test(ref.id)
            || typeof ref.source !== 'string' || !/^[a-zA-Z0-9_-]{1,50}$/.test(ref.source)) {
            throw new Error('Malformed profile reference ID.');
          }
        }
      }
    }
  }
}

const entities = (doc: HubScopeDocument, kind: 'sources' | 'profiles'): HubEntity[] => doc[kind] ?? [];
const bundles = (entity: HubEntity): Record<string, unknown>[] => Array.isArray(entity.bundles) ? entity.bundles as Record<string, unknown>[] : [];
const sorted = (values: Iterable<string>): string[] => [...new Set(values)].toSorted();
const referenceKey = (ref: Record<string, unknown>): string => semanticHubValue(ref);

/**
 * Compute changed identities and the surviving dependency closure against explicit head data.
 * @param base
 * @param head
 * @param explicit
 * @param explicit.sourceIds
 * @param explicit.profileIds
 */
export function computeHubScope(base: unknown, head: unknown, explicit?: { sourceIds: string[]; profileIds: string[] }): HubScope {
  assertHubScopeDocument(base);
  assertHubScopeDocument(head);
  const changes = (kind: 'sources' | 'profiles') => {
    const before = new Map(entities(base, kind).map((e) => [e.id, e]));
    const after = new Map(entities(head, kind).map((e) => [e.id, e]));
    return {
      added: sorted([...after.keys()].filter((id) => !before.has(id))),
      modified: sorted([...after.keys()].filter((id) => before.has(id) && semanticHubValue(before.get(id)) !== semanticHubValue(after.get(id)))),
      removed: sorted([...before.keys()].filter((id) => !after.has(id)))
    };
  };
  const sources = changes('sources');
  const profiles = changes('profiles');
  if (explicit) {
    for (const [kind, ids] of [['sources', explicit.sourceIds], ['profiles', explicit.profileIds]] as const) {
      if (new Set(ids).size !== ids.length || ids.some((id) => !entities(head, kind).some((e) => e.id === id))) {
        throw new Error(`Unknown or duplicate ${kind} scope ID.`);
      }
    }
  }
  const changedSources = new Set(explicit?.sourceIds ?? [...sources.added, ...sources.modified, ...sources.removed]);
  const selectedProfiles = new Set(explicit?.profileIds ?? [...profiles.added, ...profiles.modified]);
  const reasons: HubScope['reasons'] = [];
  for (const id of changedSources) {
    reasons.push({ entity: 'source', id, reason: explicit ? 'explicit selection' : 'semantic source change' });
  }
  const references: HubScopeReference[] = [];
  const removedReferences: HubScopeReference[] = [];
  for (const profile of entities(base, 'profiles')) {
    const remaining = entities(head, 'profiles').find((p) => p.id === profile.id);
    const after = new Set((remaining ? bundles(remaining) : []).map((ref) => referenceKey(ref)));
    for (const ref of bundles(profile)) {
      if (!after.has(referenceKey(ref))) {
        removedReferences.push({ profileId: profile.id, source: String(ref.source), id: String(ref.id), version: String(ref.version) });
      }
    }
  }
  for (const id of profiles.removed) {
    reasons.push({ entity: 'profile', id, reason: 'profile removed' });
  }
  for (const profile of entities(head, 'profiles')) {
    const dependent = bundles(profile).some((ref) => changedSources.has(String(ref.source)));
    if (dependent) {
      selectedProfiles.add(profile.id);
    }
    if (!selectedProfiles.has(profile.id)) {
      continue;
    }
    reasons.push({ entity: 'profile', id: profile.id, reason: dependent ? 'depends on changed source' : (explicit ? 'explicit selection' : 'semantic profile change') });
    const old = entities(base, 'profiles').find((p) => p.id === profile.id);
    const before = new Set((old ? bundles(old) : []).map((ref) => referenceKey(ref)));
    for (const ref of bundles(profile)) {
      if (explicit?.profileIds.includes(profile.id) || changedSources.has(String(ref.source)) || !before.has(referenceKey(ref))) {
        references.push({ profileId: profile.id, source: String(ref.source), id: String(ref.id), version: String(ref.version) });
      }
    }
  }
  const globals = (doc: HubScopeDocument) => Object.fromEntries(Object.entries(doc).filter(([key]) => key !== 'sources' && key !== 'profiles'));
  const globalChanged = semanticHubValue(globals(base)) !== semanticHubValue(globals(head));
  const sourceIds = sorted([...changedSources].filter((id) => head.sources.some((s) => s.id === id)).concat(references.map((r) => r.source).filter((id) => head.sources.some((s) => s.id === id))));
  for (const id of sourceIds) {
    if (!changedSources.has(id)) {
      reasons.push({ entity: 'source', id, reason: 'required by selected reference' });
    }
  }
  return { schemaVersion: 1, sources, profiles, sourceIds, profileIds: sorted(selectedProfiles),
    references: references.toSorted((a, b) => semanticHubValue(a).localeCompare(semanticHubValue(b))),
    removedReferences: removedReferences.toSorted((a, b) => semanticHubValue(a).localeCompare(semanticHubValue(b))), reasons, globalChanged,
    noOp: !globalChanged && changedSources.size === 0 && selectedProfiles.size === 0 && profiles.removed.length === 0 };
}

/**
 * Project only selected head entities/references; retain global settings verbatim.
 * @param head
 * @param scope
 */
export function selectHubScope(head: HubScopeDocument, scope: HubScope): HubScopeDocument {
  return { ...head, sources: head.sources.filter((s) => scope.sourceIds.includes(s.id)), profiles: entities(head, 'profiles').filter((p) => scope.profileIds.includes(p.id)).map((p) => ({ ...p,
    bundles: Array.isArray(p.bundles)
      ? bundles(p).filter((ref) => scope.references.some((r) =>
        r.profileId === p.id && r.source === String(ref.source) && r.id === String(ref.id) && r.version === String(ref.version)))
      : p.bundles
  })) };
}

/**
 * Validators see the projected (scoped) document, so their messages carry its indexes.
 * Map every source, profile and bundle index back to the real hub configuration.
 * @param projected The document the validator saw.
 * @param head The full head hub configuration.
 */
export function hubScopeLocationMapper(projected: HubScopeDocument, head: HubScopeDocument): (message: string) => string {
  const sourceIndex = (index: number): number | undefined => {
    const id = projected.sources[index]?.id;
    const found = head.sources.findIndex((source) => source.id === id);
    return found === -1 ? undefined : found;
  };
  const profileIndex = (index: number): number | undefined => {
    const id = entities(projected, 'profiles')[index]?.id;
    const found = entities(head, 'profiles').findIndex((profile) => profile.id === id);
    return found === -1 ? undefined : found;
  };
  const bundleIndex = (projectedProfile: number, index: number): number | undefined => {
    const profile = entities(projected, 'profiles')[projectedProfile];
    const original = entities(head, 'profiles').find((candidate) => candidate.id === profile?.id);
    const bundle = profile ? bundles(profile)[index] : undefined;
    if (!original || bundle === undefined) {
      return undefined;
    }
    const key = referenceKey(bundle);
    const found = bundles(original).findIndex((candidate) => candidate === bundle || referenceKey(candidate) === key);
    return found === -1 ? undefined : found;
  };
  const or = (mapped: number | undefined, fallback: string): string => mapped === undefined ? fallback : String(mapped);
  return (message) => message
    .replaceAll(/\/profiles\/(\d+)\/bundles\/(\d+)/g, (match, p: string, b: string) => {
      const profile = profileIndex(Number(p));
      const bundle = bundleIndex(Number(p), Number(b));
      return profile === undefined || bundle === undefined ? match : `/profiles/${profile}/bundles/${bundle}`;
    })
    .replaceAll(/profile\[(\d+)\]\.bundle\[(\d+)\]/g, (match, p: string, b: string) => {
      const profile = profileIndex(Number(p));
      const bundle = bundleIndex(Number(p), Number(b));
      return profile === undefined || bundle === undefined ? match : `profile[${profile}].bundle[${bundle}]`;
    })
    .replaceAll(/\/profiles\/(\d+)(?!\d|\/bundles\/\d)/g, (match, p: string) => `/profiles/${or(profileIndex(Number(p)), p)}`)
    .replaceAll(/profile\[(\d+)\](?!\.bundle\[)/g, (match, p: string) => `profile[${or(profileIndex(Number(p)), p)}]`)
    .replaceAll(/\/sources\/(\d+)/g, (match, s: string) => `/sources/${or(sourceIndex(Number(s)), s)}`)
    .replaceAll(/source\[(\d+)\]/g, (match, s: string) => `source[${or(sourceIndex(Number(s)), s)}]`)
    .replaceAll(/Profile '([^']+)' bundle #(\d+)/g, (match, id: string, n: string) => {
      const position = entities(projected, 'profiles').findIndex((profile) => profile.id === id);
      const bundle = position === -1 ? undefined : bundleIndex(position, Number(n) - 1);
      return bundle === undefined ? match : `Profile '${id}' bundle #${bundle + 1}`;
    });
}
