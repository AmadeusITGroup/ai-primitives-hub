/**
 * Tests for the primitive diagnostics planner.
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
import {
  PRIMITIVE_KINDS,
} from '../../../../src/domain/primitive/types';

describe('planPrimitiveDiagnostics', () => {
  it('plans 462 cases over 23 bundles by default, in bundle → target → scope → mode order', () => {
    const plan = planPrimitiveDiagnostics({});
    expect(plan.bundles).toEqual(PRIMITIVE_DIAGNOSTIC_BUNDLES);
    expect(plan.bundles).toHaveLength(23);
    expect(plan.cases).toHaveLength(462);
    expect(plan.filters).toEqual({
      kinds: [...PRIMITIVE_KINDS],
      targets: [...TARGET_TYPES],
      scopes: [...DIAGNOSTIC_SCOPES]
    });
    expect(plan.notCovered).toEqual({ kinds: [] });
    const isMixed = (id: string): boolean => id.startsWith('aph-e2e-mix-');
    const expectedIds = PRIMITIVE_DIAGNOSTIC_BUNDLES.filter((b) => b.rejection === undefined).flatMap((b) =>
      TARGET_TYPES.flatMap((t) => DIAGNOSTIC_SCOPES.flatMap((s) => (isMixed(b.id)
        ? [`${b.id}__${t}__${s}`, `${b.id}__${t}__${s}__skip-unsupported`]
        : [`${b.id}__${t}__${s}`]))));
    expect(plan.cases.map((c) => c.id)).toEqual(expectedIds);
    expect(plan.cases.filter((c) => c.mode === 'skip-unsupported').every((c) => isMixed(c.bundle))).toBe(true);
    expect(plan.cases.filter((c) => !isMixed(c.bundle)).every((c) => c.mode === 'default')).toBe(true);
    expect(plan.cases[0]).toEqual({
      id: 'aph-e2e-only-prompt__vscode__user',
      bundle: 'aph-e2e-only-prompt',
      kinds: ['prompt'],
      items: [{ path: 'prompts/hello-world.prompt.md', kind: 'prompt' }],
      target: 'vscode',
      scope: 'user',
      mode: 'default',
      expectedStatus: 'installed'
    });
  });

  it('fills expectedStatus from the support matrix and the install mode', () => {
    const plan = planPrimitiveDiagnostics({});
    const status = (id: string): string | undefined => plan.cases.find((c) => c.id === id)?.expectedStatus;
    expect(status('aph-e2e-only-steering__vscode__user')).toBe('rejected');
    expect(status('aph-e2e-only-steering__kiro__repository')).toBe('installed');
    expect(status('aph-e2e-only-mcp-server__vscode__user')).toBe('installed');
    expect(status('aph-e2e-only-plugin__kiro__user')).toBe('installed');
    expect(status('aph-e2e-mix-portable__kiro__user')).toBe('installed');
    expect(status('aph-e2e-mix-portable__kiro__user__skip-unsupported')).toBe('installed');
    expect(status('aph-e2e-mix-all-kinds__vscode__user')).toBe('rejected');
    expect(status('aph-e2e-mix-all-kinds__vscode__user__skip-unsupported')).toBe('partial');
    // Isolated: 8 kinds everywhere plus the target-specific ones; then the portable mix everywhere, in both modes.
    const installed = 2 * (8 * 11 + 2 + 2 + 1 + 1 + 1 + 1 + 4 + 2 + 2) + 2 * 2 * 11;
    expect(plan.cases.filter((c) => c.expectedStatus === 'installed')).toHaveLength(installed);
    // The all-kinds mix: rejected by the default install, partial with --skip-unsupported, everywhere.
    expect(plan.cases.filter((c) => c.expectedStatus === 'partial')).toHaveLength(2 * 11);
    expect(plan.cases.filter((c) => c.expectedStatus === 'partial').every((c) => c.mode === 'skip-unsupported')).toBe(true);
    expect(plan.cases.filter((c) => c.expectedStatus === 'rejected')).toHaveLength(462 - installed - 2 * 11);
  });

  it('plans no install case for an invalid bundle, and a mixed bundle only when all its kinds are selected', () => {
    const plugin = planPrimitiveDiagnostics({ kinds: ['plugin'], targets: ['vscode'], scopes: ['user'] });
    expect(plugin.bundles.map((b) => b.id)).toEqual([
      'aph-e2e-only-plugin',
      'aph-e2e-bad-plugin-no-schema',
      'aph-e2e-bad-plugin-name',
      'aph-e2e-bad-plugin-author',
      'aph-e2e-bad-plugin-nested-manifest'
    ]);
    expect(plugin.cases.map((c) => c.id)).toEqual(['aph-e2e-only-plugin__vscode__user']);

    const portable = planPrimitiveDiagnostics({ kinds: ['prompt', 'instruction', 'agent', 'skill', 'plugin', 'hook'], targets: ['vscode'], scopes: ['user'] });
    expect(portable.bundles.map((b) => b.id)).toContain('aph-e2e-mix-portable');
    expect(portable.bundles.map((b) => b.id)).not.toContain('aph-e2e-mix-all-kinds');
    expect(portable.cases.find((c) => c.bundle === 'aph-e2e-mix-portable')?.items.map((i) => i.kind))
      .toEqual(['prompt', 'instruction', 'agent', 'skill', 'plugin', 'hook']);
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

  it('reports a filter kind no catalogued bundle contains as not covered', () => {
    const catalogue = PRIMITIVE_DIAGNOSTIC_BUNDLES.filter((b) => b.items.every((i) => i.kind !== 'plugin'));
    const empty = planPrimitiveDiagnostics({ kinds: ['plugin'] }, catalogue);
    expect(empty.bundles).toEqual([]);
    expect(empty.cases).toEqual([]);
    expect(empty.notCovered).toEqual({ kinds: ['plugin'] });

    const partial = planPrimitiveDiagnostics({ kinds: ['plugin', 'prompt'], targets: ['vscode'], scopes: ['user'] }, catalogue);
    expect(partial.filters.kinds).toEqual(['prompt', 'plugin']);
    expect(partial.notCovered).toEqual({ kinds: ['plugin'] });
    expect(partial.cases.map((c) => c.id)).toEqual(['aph-e2e-only-prompt__vscode__user']);

    expect(planPrimitiveDiagnostics({ kinds: ['plugin'] }).notCovered).toEqual({ kinds: [] });
  });

  it('selects a bundle only when all its kinds are in the filter, and plans a mixed bundle in both install modes', () => {
    const catalogue = [{ ...PRIMITIVE_DIAGNOSTIC_BUNDLES[0], id: 'mix', items: [PRIMITIVE_DIAGNOSTIC_BUNDLES[0].items[0], PRIMITIVE_DIAGNOSTIC_BUNDLES[1].items[0]] }];
    expect(planPrimitiveDiagnostics({ kinds: ['prompt'] }, catalogue).bundles).toEqual([]);
    const planned = {
      bundle: 'mix',
      kinds: ['prompt', 'instruction'],
      items: [{ path: 'prompts/hello-world.prompt.md', kind: 'prompt' }, { path: 'instructions/code-style.instructions.md', kind: 'instruction' }],
      target: 'vscode',
      scope: 'user',
      expectedStatus: 'installed'
    };
    expect(planPrimitiveDiagnostics({ kinds: ['prompt', 'instruction'], targets: ['vscode'], scopes: ['user'] }, catalogue).cases)
      .toEqual([
        { id: 'mix__vscode__user', ...planned, mode: 'default' },
        { id: 'mix__vscode__user__skip-unsupported', ...planned, mode: 'skip-unsupported' }
      ]);
  });

  it('plans a single-kind bundle in the default install mode only', () => {
    const plan = planPrimitiveDiagnostics({ kinds: ['steering'], targets: ['vscode', 'kiro'], scopes: ['user'] });
    expect(plan.cases.map((c) => [c.id, c.mode, c.expectedStatus])).toEqual([
      ['aph-e2e-only-steering__vscode__user', 'default', 'rejected'],
      ['aph-e2e-only-steering__kiro__user', 'default', 'installed']
    ]);
  });
});
