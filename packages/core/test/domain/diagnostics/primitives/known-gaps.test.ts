/**
 * Tests for the primitive diagnostics known gaps.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
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
  it('is exactly the 12 known entries, in declaration order', () => {
    expect(PRIMITIVE_KNOWN_GAPS.map((g) => g.key)).toEqual([
      'mcp-server-rejected/I4/mcp-server',
      'kiro-hook-rejected/I4/hook@kiro',
      'copilot-cli-repository-scope/I8/copilot-cli@repository',
      'manifest-id-file-stem/I2/prompt',
      'manifest-id-file-stem/I2/instruction',
      'manifest-id-file-stem/I2/chat-mode',
      'manifest-id-file-stem/I2/agent',
      'manifest-id-file-stem/I2/hook',
      'manifest-id-file-stem/I2/mcp-server',
      'manifest-id-file-stem/I2/spec',
      'power-directory-unit/I1/power',
      'power-directory-unit/I2/power'
    ]);
    expect(new Set(PRIMITIVE_KNOWN_GAPS.map((g) => g.key)).size).toBe(12);
  });

  it('keys each entry by id and invariant', () => {
    for (const gap of PRIMITIVE_KNOWN_GAPS) {
      expect(gap.key.startsWith(`${gap.id}/${gap.invariant}/`)).toBe(true);
      expect(gap.id).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/);
      expect(gap.summary.length).toBeGreaterThan(0);
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
    }
  });

  it('declares no targets or scopes on bundle-level entries', () => {
    for (const gap of PRIMITIVE_KNOWN_GAPS.filter((g) => bundleLevel.has(g.invariant))) {
      expect(gap.match.targets).toBeUndefined();
      expect(gap.match.scopes).toBeUndefined();
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
  });
});
