/**
 * Domain layer — the primitive diagnostics catalogue.
 *
 * One isolated single-item bundle per non-plugin kind, derived from the
 * fixture declarations. Catalogue order is `PRIMITIVE_KINDS` order without
 * `plugin`, which is also the report order. Plugin, mixed and negative
 * bundles can be added later as more data.
 * @module domain/diagnostics/primitives/catalogue
 */
import * as path from 'node:path';
import type {
  PrimitiveKind,
} from '../../primitive/types';
import {
  collectionFileFor,
  fixtureItemSourcePaths,
  isolatedBundleId,
  PRIMITIVE_FIXTURE_ITEMS,
  type PrimitiveFixtureItem,
} from './fixture';

/** One collection item of a diagnostic bundle. */
export interface FixtureItem {
  kind: PrimitiveKind;
  /** Collection item path (entry point). */
  path: string;
  expectedId: string;
  unit: 'file' | 'directory';
  /** Every source file of the item; for a directory unit, the whole tree under dirname(path). Sorted. */
  files: readonly string[];
  /** Source-side prefix the placement oracle strips (e.g. 'prompts/', '.kiro/specs/'). */
  sourcePrefix: string;
}

/** One diagnostic bundle: a collection of the fixture repository. */
export interface DiagnosticBundle {
  /** `aph-e2e-only-<kind>`; the collection id. */
  id: string;
  /** `collections/<id>.collection.yml`. */
  collectionFile: string;
  version: '1.0.0';
  /** Exactly one item today (isolated bundles). */
  items: readonly FixtureItem[];
}

const toFixtureItem = (declared: PrimitiveFixtureItem, sources: readonly string[]): FixtureItem => {
  const root = `${path.posix.dirname(declared.path)}/`;
  const files = declared.unit === 'directory'
    ? sources.filter((source) => source.startsWith(root))
    : [declared.path];
  return { ...declared, files };
};

/** The isolated bundles, in `PRIMITIVE_KINDS` order without `plugin`. */
export const PRIMITIVE_DIAGNOSTIC_BUNDLES: readonly DiagnosticBundle[] = (() => {
  const sources = fixtureItemSourcePaths();
  return PRIMITIVE_FIXTURE_ITEMS.map((declared): DiagnosticBundle => {
    const id = isolatedBundleId(declared.kind);
    return { id, collectionFile: collectionFileFor(id), version: '1.0.0', items: [toFixtureItem(declared, sources)] };
  });
})();
