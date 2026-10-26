/**
 * Kind/route mismatch warning for `collection validate` (ADR-0009).
 *
 * `collection validate` is author-side and target-independent, so an item
 * is checked against the routes of every built-in target layout (user and
 * repository scope). A route's kind depends only on its key, so the union
 * is well defined. User and project layout overrides are not read.
 * @module app/collection/kind-route-warning
 */
import {
  findKindRouteMismatch,
  formatKindRouteMismatch,
  isPrimitiveKind,
  type KindRoutes,
} from '@ai-primitives-hub/core';
import {
  defaultLayouts,
} from '@ai-primitives-hub/infra';

/** Every `kindRoutes` key of the built-in layouts (values are unused). */
const BUILT_IN_ROUTES: KindRoutes = Object.fromEntries(
  Object.values(defaultLayouts.layouts).flatMap((layout) =>
    [layout.user, layout.repository].flatMap((scoped) => Object.entries(scoped?.kindRoutes ?? {})))
);

/**
 * Warning for a collection item whose declared kind differs from the kind
 * of the built-in install route its path matches.
 * Only kinds `collection validate` accepts are checked (case-insensitive);
 * an invalid kind already produces an error.
 * @param collectionRel - Repository-relative collection file.
 * @param index - Item index in `items[]`.
 * @param itemPath - Normalized item path.
 * @param kind - Item kind as declared.
 * @returns The warning message, or `null` when there is nothing to report.
 */
export const kindRouteMismatchWarning = (
  collectionRel: string,
  index: number,
  itemPath: string,
  kind: unknown
): string | null => {
  if (typeof kind !== 'string') {
    return null;
  }
  const declared = kind.toLowerCase();
  if (!isPrimitiveKind(declared)) {
    return null;
  }
  const mismatch = findKindRouteMismatch(itemPath, declared, BUILT_IN_ROUTES);
  return mismatch === null ? null : formatKindRouteMismatch(collectionRel, index, itemPath, kind, mismatch);
};
