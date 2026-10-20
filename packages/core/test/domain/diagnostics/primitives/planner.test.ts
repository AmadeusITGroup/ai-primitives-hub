/**
 * Tests for the primitive diagnostics planner (design §3.8).
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  DIAGNOSTIC_SCOPES,
  planPrimitiveDiagnostics,
  PRIMITIVE_DIAGNOSTIC_BUNDLES,
} from '../../../../src/domain/diagnostics/primitives';
import {
  TARGET_TYPES,
} from '../../../../src/domain/install/target';

describe('planPrimitiveDiagnostics', () => {
  it('plans 352 cases over 16 bundles by default, in bundle → target → scope order', () => {
    const plan = planPrimitiveDiagnostics({});
    expect(plan.bundles).toEqual(PRIMITIVE_DIAGNOSTIC_BUNDLES);
    expect(plan.cases).toHaveLength(352);
    expect(plan.filters).toEqual({
      kinds: PRIMITIVE_DIAGNOSTIC_BUNDLES.map((b) => b.items[0].kind),
      targets: [...TARGET_TYPES],
      scopes: [...DIAGNOSTIC_SCOPES]
    });
    expect(plan.notCovered).toEqual({ kinds: [] });
    const expectedIds = PRIMITIVE_DIAGNOSTIC_BUNDLES.flatMap((b) =>
      TARGET_TYPES.flatMap((t) => DIAGNOSTIC_SCOPES.map((s) => `${b.id}__${t}__${s}`)));
    expect(plan.cases.map((c) => c.id)).toEqual(expectedIds);
    expect(plan.cases[0]).toEqual({
      id: 'aph-e2e-only-prompt__vscode__user',
      bundle: 'aph-e2e-only-prompt',
      kinds: ['prompt'],
      target: 'vscode',
      scope: 'user',
      expectedStatus: 'installed'
    });
  });

  it('fills expectedStatus from the support matrix', () => {
    const plan = planPrimitiveDiagnostics({});
    const status = (id: string): string | undefined => plan.cases.find((c) => c.id === id)?.expectedStatus;
    expect(status('aph-e2e-only-steering__vscode__user')).toBe('rejected');
    expect(status('aph-e2e-only-steering__kiro__repository')).toBe('installed');
    expect(status('aph-e2e-only-mcp-server__vscode__user')).toBe('installed');
    expect(plan.cases.filter((c) => c.expectedStatus === 'installed')).toHaveLength(2 * (7 * 11 + 2 + 2 + 1 + 1 + 1 + 1 + 4 + 2 + 2));
  });

  it('filters kinds × targets into 12 cases, in plan order', () => {
    const plan = planPrimitiveDiagnostics({ kinds: ['prompt', 'hook', 'mcp-server'], targets: ['vscode', 'kiro'] });
    expect(plan.bundles.map((b) => b.id)).toEqual(['aph-e2e-only-prompt', 'aph-e2e-only-hook', 'aph-e2e-only-mcp-server']);
    expect(plan.cases.map((c) => c.id)).toEqual([
      'aph-e2e-only-prompt__vscode__user',
      'aph-e2e-only-prompt__vscode__repository',
      'aph-e2e-only-prompt__kiro__user',
      'aph-e2e-only-prompt__kiro__repository',
      'aph-e2e-only-hook__vscode__user',
      'aph-e2e-only-hook__vscode__repository',
      'aph-e2e-only-hook__kiro__user',
      'aph-e2e-only-hook__kiro__repository',
      'aph-e2e-only-mcp-server__vscode__user',
      'aph-e2e-only-mcp-server__vscode__repository',
      'aph-e2e-only-mcp-server__kiro__user',
      'aph-e2e-only-mcp-server__kiro__repository'
    ]);
  });

  it('ignores duplicates and filter order', () => {
    const a = planPrimitiveDiagnostics({ kinds: ['hook', 'prompt'], targets: ['kiro', 'vscode'], scopes: ['repository', 'user'] });
    const b = planPrimitiveDiagnostics({ kinds: ['prompt', 'hook', 'prompt'], targets: ['vscode', 'kiro', 'kiro'], scopes: ['user', 'repository', 'user'] });
    expect(a).toEqual(b);
    expect(a.filters).toEqual({ kinds: ['prompt', 'hook'], targets: ['vscode', 'kiro'], scopes: ['user', 'repository'] });
  });

  it('reports plugin as not covered', () => {
    const empty = planPrimitiveDiagnostics({ kinds: ['plugin'] });
    expect(empty.bundles).toEqual([]);
    expect(empty.cases).toEqual([]);
    expect(empty.notCovered).toEqual({ kinds: ['plugin'] });

    const partial = planPrimitiveDiagnostics({ kinds: ['plugin', 'prompt'], targets: ['vscode'], scopes: ['user'] });
    expect(partial.filters.kinds).toEqual(['prompt', 'plugin']);
    expect(partial.notCovered).toEqual({ kinds: ['plugin'] });
    expect(partial.cases.map((c) => c.id)).toEqual(['aph-e2e-only-prompt__vscode__user']);
  });

  it('selects a bundle only when all its kinds are in the filter', () => {
    const catalogue = [{ ...PRIMITIVE_DIAGNOSTIC_BUNDLES[0], id: 'mix', items: [PRIMITIVE_DIAGNOSTIC_BUNDLES[0].items[0], PRIMITIVE_DIAGNOSTIC_BUNDLES[1].items[0]] }];
    expect(planPrimitiveDiagnostics({ kinds: ['prompt'] }, catalogue).bundles).toEqual([]);
    expect(planPrimitiveDiagnostics({ kinds: ['prompt', 'instruction'], targets: ['vscode'], scopes: ['user'] }, catalogue).cases)
      .toEqual([{ id: 'mix__vscode__user', bundle: 'mix', kinds: ['prompt', 'instruction'], target: 'vscode', scope: 'user', expectedStatus: 'installed' }]);
  });
});
