/**
 * Tests for the primitive diagnostics known gaps.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  DIAGNOSTIC_INSTALL_MODES,
  DIAGNOSTIC_SCOPES,
  INVARIANTS,
  PRIMITIVE_DIAGNOSTIC_BUNDLES,
  PRIMITIVE_KNOWN_GAPS,
} from '../../../../src/domain/diagnostics/primitives';
import {
  TARGET_TYPES,
} from '../../../../src/domain/install/target';

const catalogued = new Set<string>(PRIMITIVE_DIAGNOSTIC_BUNDLES.flatMap((b) => b.items.map((i) => i.kind)));
const bundleLevel = new Set<string>(INVARIANTS.filter((i) => i.level === 'bundle').map((i) => i.id));

describe('PRIMITIVE_KNOWN_GAPS', () => {
  it('is exactly the 21 known entries, in declaration order', () => {
    expect(PRIMITIVE_KNOWN_GAPS.map((g) => g.key)).toEqual([
      'mcp-server-rejected/I4/mcp-server',
      'kiro-hook-rejected/I4/hook@kiro',
      'mcp-server-rejected/I9/mcp-server',
      'kiro-hook-rejected/I9/hook@kiro',
      'kiro-plugin-rejected/I4/plugin@kiro',
      'kiro-plugin-rejected/I9/plugin@kiro',
      'kiro-hook-rejected/I4/hook@kiro/skip-unsupported',
      'kiro-plugin-rejected/I4/plugin@kiro/skip-unsupported',
      'copilot-cli-repository-scope/I8/copilot-cli@repository',
      'manifest-id-file-stem/I2/prompt',
      'manifest-id-file-stem/I2/instruction',
      'manifest-id-file-stem/I2/chat-mode',
      'manifest-id-file-stem/I2/agent',
      'manifest-id-file-stem/I2/hook',
      'manifest-id-file-stem/I2/mcp-server',
      'manifest-id-file-stem/I2/spec',
      'power-directory-unit/I1/power',
      'power-directory-unit/I2/power',
      'plugin-skill-projection/I11/plugin',
      'plugin-mcp-projection/I12/plugin',
      'plugin-root-unresolved/I14/plugin'
    ]);
    expect(new Set(PRIMITIVE_KNOWN_GAPS.map((g) => g.key)).size).toBe(21);
    // The default all-or-nothing rejection of a mixed bundle is expected, not a gap.
    expect(PRIMITIVE_KNOWN_GAPS.map((g) => g.id)).not.toContain('all-or-nothing-install');
  });

  it('keys each entry by id and invariant', () => {
    for (const gap of PRIMITIVE_KNOWN_GAPS) {
      expect(gap.key.startsWith(`${gap.id}/${gap.invariant}/`)).toBe(true);
      expect(gap.id).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/);
      expect(gap.summary.length).toBeGreaterThan(0);
    }
  });

  it('names the tracking GitHub issue where one exists', () => {
    const issues = Object.fromEntries(PRIMITIVE_KNOWN_GAPS.filter((g) => g.issue !== undefined).map((g) => [g.key, g.issue]));
    expect(issues).toEqual({
      'kiro-hook-rejected/I4/hook@kiro': 549,
      'kiro-hook-rejected/I9/hook@kiro': 549,
      'kiro-plugin-rejected/I4/plugin@kiro': 549,
      'kiro-plugin-rejected/I9/plugin@kiro': 549,
      'kiro-hook-rejected/I4/hook@kiro/skip-unsupported': 549,
      'kiro-plugin-rejected/I4/plugin@kiro/skip-unsupported': 549,
      'plugin-skill-projection/I11/plugin': 549,
      'plugin-mcp-projection/I12/plugin': 549,
      'plugin-root-unresolved/I14/plugin': 549
    });
  });

  it('selects only catalogued bundles', () => {
    const ids = new Set(PRIMITIVE_DIAGNOSTIC_BUNDLES.map((b) => b.id));
    for (const bundle of PRIMITIVE_KNOWN_GAPS.flatMap((g) => g.match.bundles ?? [])) {
      expect(ids.has(bundle), bundle).toBe(true);
    }
  });

  it('references catalogued kinds, valid targets and scopes, and an evaluated invariant', () => {
    for (const gap of PRIMITIVE_KNOWN_GAPS) {
      expect(gap.invariant).not.toBe('HARNESS');
      expect(INVARIANTS.map((i) => i.id)).toContain(gap.invariant);
      for (const kind of gap.match.kinds ?? []) {
        expect(catalogued.has(kind)).toBe(true);
      }
      for (const target of gap.match.targets ?? []) {
        expect(TARGET_TYPES).toContain(target);
      }
      for (const scope of gap.match.scopes ?? []) {
        expect(DIAGNOSTIC_SCOPES).toContain(scope);
      }
      for (const mode of gap.match.modes ?? []) {
        expect(DIAGNOSTIC_INSTALL_MODES).toContain(mode);
      }
    }
  });

  it('declares no targets, scopes or modes on bundle-level entries', () => {
    for (const gap of PRIMITIVE_KNOWN_GAPS.filter((g) => bundleLevel.has(g.invariant))) {
      expect(gap.match.targets).toBeUndefined();
      expect(gap.match.scopes).toBeUndefined();
      expect(gap.match.modes).toBeUndefined();
    }
  });

  it('carries the exact observed values the product produces today', () => {
    const byKey = new Map(PRIMITIVE_KNOWN_GAPS.map((g) => [g.key, g]));
    const rejected = { status: 'rejected', errorCode: 'BUNDLE.UNSUPPORTED_CONTENT' };
    expect(byKey.get('mcp-server-rejected/I4/mcp-server')).toMatchObject({ match: { kinds: ['mcp-server'] }, observed: rejected });
    expect(byKey.get('kiro-hook-rejected/I4/hook@kiro')).toMatchObject({ match: { kinds: ['hook'], targets: ['kiro'] }, observed: rejected, issue: 549 });
    expect(byKey.get('copilot-cli-repository-scope/I8/copilot-cli@repository')).toEqual(expect.objectContaining({
      match: { targets: ['copilot-cli'], scopes: ['repository'] },
      observed: { effectiveScope: 'user' }
    }));
    const fileStemIds: Record<string, string> = {
      prompt: 'hello-world.prompt',
      instruction: 'code-style.instructions',
      'chat-mode': 'review.chatmode',
      agent: 'security.agent',
      hook: 'pre-commit.hook',
      'mcp-server': 'github.mcp',
      spec: 'requirements'
    };
    for (const [kind, id] of Object.entries(fileStemIds)) {
      expect(byKey.get(`manifest-id-file-stem/I2/${kind}`)).toMatchObject({ match: { kinds: [kind] }, observed: { id, kind, occurrences: 1 } });
    }
    expect(byKey.get('power-directory-unit/I1/power'))
      .toMatchObject({ match: { kinds: ['power'] }, observed: { missingArchivePaths: ['powers/stripe/steering/payments.md'] } });
    expect(byKey.get('power-directory-unit/I2/power')).toMatchObject({ match: { kinds: ['power'] }, observed: { id: 'POWER', kind: 'power', occurrences: 1 } });
    expect(byKey.get('mcp-server-rejected/I9/mcp-server')).toMatchObject({ match: { kinds: ['mcp-server'] }, observed: { rejected: true } });
    expect(byKey.get('kiro-hook-rejected/I9/hook@kiro')).toMatchObject({ match: { kinds: ['hook'], targets: ['kiro'] }, observed: { rejected: true } });
    expect(byKey.get('kiro-plugin-rejected/I4/plugin@kiro')).toMatchObject({ match: { kinds: ['plugin'], targets: ['kiro'] }, observed: rejected });
    expect(byKey.get('kiro-plugin-rejected/I9/plugin@kiro')).toMatchObject({ match: { kinds: ['plugin'], targets: ['kiro'] }, observed: { rejected: true } });
    const partial = { status: 'partial', errorCode: null };
    expect(byKey.get('kiro-hook-rejected/I4/hook@kiro/skip-unsupported'))
      .toEqual(expect.objectContaining({ match: { kinds: ['hook'], targets: ['kiro'], modes: ['skip-unsupported'] }, observed: partial, issue: 549 }));
    expect(byKey.get('kiro-plugin-rejected/I4/plugin@kiro/skip-unsupported'))
      .toEqual(expect.objectContaining({ match: { kinds: ['plugin'], targets: ['kiro'], modes: ['skip-unsupported'] }, observed: partial, issue: 549 }));
    expect(byKey.get('plugin-skill-projection/I11/plugin')).toMatchObject({ match: { kinds: ['plugin'] }, observed: { unprojected: ['plugin-skill'] } });
    expect(byKey.get('plugin-mcp-projection/I12/plugin')).toMatchObject({ match: { kinds: ['plugin'] }, observed: { unprojected: ['aph-e2e'] } });
    expect(byKey.get('plugin-root-unresolved/I14/plugin')).toMatchObject({ match: { kinds: ['plugin'] }, observed: { unresolved: ['aph-e2e'] } });
  });
});
