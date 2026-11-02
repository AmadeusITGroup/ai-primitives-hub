/**
 * The items a deployment manifest declares, and their counts by kind.
 *
 * A governed release (`formatVersion: 1`) lists its items once, in the
 * canonical `items[]`. Older manifests list them in per-type arrays
 * (`prompts`, `agents`, `instructions`, `hooks`, `plugins`, `skills`), whose
 * entries carry a `type` that may be a legacy alias. Writers, the
 * marketplace breakdown and the tree read the same enumeration from here.
 *
 * Tolerant reader: the input is `unknown` because manifest shapes differ
 * between producers (`hooks` is a lifecycle-hook map in some of them).
 * Non-array lists and malformed entries are ignored; it never throws.
 *
 * Pure domain: no IO.
 * @module domain/install/manifest-items
 */
import {
  normalizePrimitiveKind,
  type PrimitiveKind,
} from '../primitive/types';

/** One item a manifest declares: its bundle-relative file and its kind. */
export interface ManifestItemRef {
  /** Bundle-relative path of the item's file. */
  file: string;
  /** Declared kind, as written (canonical kind or legacy alias). */
  type: string;
  /** Item id, when the manifest gives one. */
  id?: string;
}

/**
 * Legacy per-type lists, in enumeration order, with the kind an entry gets
 * when it declares no `type`.
 */
const LEGACY_LISTS: readonly (readonly [list: string, kind: PrimitiveKind])[] = [
  ['prompts', 'prompt'],
  ['agents', 'agent'],
  ['instructions', 'instruction'],
  ['hooks', 'hook'],
  ['plugins', 'plugin'],
  ['skills', 'skill']
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const entries = (value: unknown): Record<string, unknown>[] =>
  (Array.isArray(value) ? value.filter((entry) => isRecord(entry)) : []);

const withId = (ref: ManifestItemRef, id: unknown): ManifestItemRef =>
  (typeof id === 'string' ? { ...ref, id } : ref);

const canonicalItems = (manifest: Record<string, unknown>): ManifestItemRef[] =>
  entries(manifest.items).flatMap((entry) =>
    (typeof entry.path === 'string' && typeof entry.kind === 'string'
      ? [withId({ file: entry.path, type: entry.kind }, entry.id)]
      : []));

const legacyItems = (manifest: Record<string, unknown>): ManifestItemRef[] =>
  LEGACY_LISTS.flatMap(([list, defaultKind]) =>
    entries(manifest[list]).flatMap((entry) => {
      if (typeof entry.file !== 'string') {
        return [];
      }
      const ref = { file: entry.file, type: typeof entry.type === 'string' ? entry.type : defaultKind };
      // Legacy skill ids were descriptive metadata, not install destinations.
      return [list === 'skills' ? ref : withId(ref, entry.id)];
    }));

/**
 * Enumerate the items a deployment manifest declares.
 *
 * A `formatVersion: 1` manifest with an `items` array yields only its
 * canonical items; any legacy lists it also carries are projections of the
 * same items. Otherwise, canonical items come first, followed by the legacy
 * lists in the order `prompts`, `agents`, `instructions`, `hooks`, `plugins`,
 * `skills`. A legacy entry without a string `type` gets its list's kind.
 * @param manifest - Parsed manifest of any shape.
 * @returns The declared items; empty for a non-object input.
 */
export const manifestItems = (manifest: unknown): ManifestItemRef[] => {
  if (!isRecord(manifest)) {
    return [];
  }
  if (manifest.formatVersion === 1 && Array.isArray(manifest.items)) {
    return canonicalItems(manifest);
  }
  return [...canonicalItems(manifest), ...legacyItems(manifest)];
};

/**
 * Count a manifest's declared items by canonical primitive kind.
 * @param manifest - Parsed manifest of any shape.
 * @returns Non-zero counts keyed by kind; items of unknown kinds are not counted.
 */
export const countManifestItemsByKind = (manifest: unknown): Partial<Record<PrimitiveKind, number>> => {
  const counts: Partial<Record<PrimitiveKind, number>> = {};
  for (const item of manifestItems(manifest)) {
    const kind = normalizePrimitiveKind(item.type);
    if (kind !== null) {
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
  }
  return counts;
};
