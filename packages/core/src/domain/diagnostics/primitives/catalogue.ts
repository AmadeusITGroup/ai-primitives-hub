/**
 * Domain layer — the primitive diagnostics catalogue.
 *
 * Derived from the fixture declarations, in report order: one isolated
 * single-item bundle per kind (`PRIMITIVE_KINDS` order), the mixed-kind
 * bundles, then the invalid Agent Plugin bundles that `collection validate`
 * and `bundle build` must reject.
 * @module domain/diagnostics/primitives/catalogue
 */
import * as path from 'node:path';
import type {
  PrimitiveKind,
} from '../../primitive/types';
import {
  collectionFileFor,
  fixtureExecutablePaths,
  fixtureItemSourcePaths,
  isolatedBundleId,
  mixedBundleItems,
  type PluginComponents,
  PRIMITIVE_FIXTURE_ITEMS,
  PRIMITIVE_INVALID_PLUGIN_BUNDLES,
  PRIMITIVE_MIXED_BUNDLES,
  type PrimitiveFixtureItem,
} from './fixture';

/** Error code `bundle build` reports for an invalid Agent Plugin item. */
const INVALID_PLUGIN_ERROR_CODE = 'PLUGIN.INVALID_MANIFEST';

/** One collection item of a diagnostic bundle. */
export interface FixtureItem {
  kind: PrimitiveKind;
  /** Collection item path (entry point). */
  path: string;
  expectedId: string;
  unit: 'file' | 'directory';
  /** Every source file of the item; for a directory unit, the whole tree under dirname(path). Sorted. */
  files: readonly string[];
  /** Files of the item whose intended mode is executable. Sorted. */
  executable: readonly string[];
  /** Source-side prefix the placement oracle strips (e.g. 'prompts/', '.kiro/specs/'). */
  sourcePrefix: string;
  /** Plugin items only: the components the plugin ships. */
  plugin?: PluginComponents;
}

/** One diagnostic bundle: a collection of the fixture repository. */
export interface DiagnosticBundle {
  /** The collection id: `aph-e2e-only-<kind>`, `aph-e2e-mix-…` or `aph-e2e-bad-plugin-…`. */
  id: string;
  /** `collections/<id>.collection.yml`. */
  collectionFile: string;
  version: '1.0.0';
  /** In collection order. */
  items: readonly FixtureItem[];
  /**
   * Present on an invalid bundle: `collection validate` and `bundle build`
   * must both reject it with this error code (build) and message (both),
   * and write no archive. Such a bundle is never installed.
   */
  rejection?: { errorCode: string; message: string };
}

const toFixtureItem = (declared: PrimitiveFixtureItem, sources: readonly string[], executable: readonly string[]): FixtureItem => {
  const root = `${path.posix.dirname(declared.path)}/`;
  const files = declared.unit === 'directory'
    ? sources.filter((source) => source.startsWith(root))
    : [declared.path];
  return { ...declared, files, executable: files.filter((file) => executable.includes(file)) };
};

const bundleOf = (id: string, items: readonly FixtureItem[]): DiagnosticBundle =>
  ({ id, collectionFile: collectionFileFor(id), version: '1.0.0', items });

/** Every bundle, in report order: isolated (`PRIMITIVE_KINDS` order), mixed, invalid. */
export const PRIMITIVE_DIAGNOSTIC_BUNDLES: readonly DiagnosticBundle[] = (() => {
  const sources = fixtureItemSourcePaths();
  const executable = fixtureExecutablePaths();
  const item = (declared: PrimitiveFixtureItem): FixtureItem => toFixtureItem(declared, sources, executable);
  return [
    ...PRIMITIVE_FIXTURE_ITEMS.map((declared) => bundleOf(isolatedBundleId(declared.kind), [item(declared)])),
    ...PRIMITIVE_MIXED_BUNDLES.map((mixed) => bundleOf(mixed.id, mixedBundleItems(mixed).map((declared) => item(declared)))),
    ...PRIMITIVE_INVALID_PLUGIN_BUNDLES.map((invalid): DiagnosticBundle => {
      const bundle = bundleOf(invalid.id, [item(invalid.item)]);
      return {
        ...bundle,
        rejection: {
          errorCode: INVALID_PLUGIN_ERROR_CODE,
          message: `${bundle.collectionFile}: items[0] plugin ${invalid.item.path}: ${invalid.issue}`
        }
      };
    })
  ];
})();
