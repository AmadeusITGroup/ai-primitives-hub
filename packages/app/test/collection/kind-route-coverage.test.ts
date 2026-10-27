/**
 * Every route of the built-in layouts names a primitive kind.
 *
 * `routeKindOf` derives a route's kind from its `kindRoutes` key alone. A
 * layout key it cannot map would silently escape `allowedKinds` filtering
 * and the kind/route mismatch warning of `collection validate`.
 */
import {
  routeKindOf,
} from '@ai-primitives-hub/core';
import {
  defaultLayouts,
} from '@ai-primitives-hub/infra';
import {
  describe,
  expect,
  it,
} from 'vitest';

describe('built-in layout routes', () => {
  const keys = Object.entries(defaultLayouts.layouts).flatMap(([targetType, layout]) =>
    (['user', 'repository'] as const).flatMap((scope) =>
      Object.keys(layout[scope]?.kindRoutes ?? {}).map((key) => `${targetType}/${scope}: ${key}`)));

  it('covers at least one route', () => {
    expect(keys.length).toBeGreaterThan(0);
  });

  it.each(keys)('maps %s to a primitive kind', (entry) => {
    const key = entry.slice(entry.indexOf(': ') + 2);
    expect(routeKindOf(key)).not.toBeNull();
  });
});
