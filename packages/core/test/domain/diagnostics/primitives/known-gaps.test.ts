/**
 * Tests for the seed known gaps (design §3.5, requirements Appendix B).
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
  it('is exactly the 12 seed entries, in seed order', () => {
    expect(PRIMITIVE_KNOWN_GAPS.map((g) => g.key)).toEqual([
      'G05/I4/mcp-server',
      'G08/I4/hook@kiro',
      'G18/I8/copilot-cli@repository',
      'G15/I2/prompt',
      'G15/I2/instruction',
      'G15/I2/chat-mode',
      'G15/I2/agent',
      'G15/I2/hook',
      'G15/I2/mcp-server',
      'G15/I2/spec',
      'G13/I1/power',
      'G13/I2/power'
    ]);
    expect(new Set(PRIMITIVE_KNOWN_GAPS.map((g) => g.key)).size).toBe(12);
  });

  it('keys each entry by id and invariant', () => {
    for (const gap of PRIMITIVE_KNOWN_GAPS) {
      expect(gap.key.startsWith(`${gap.id}/${gap.invariant}/`)).toBe(true);
      expect(gap.id).toMatch(/^G\d{2}$/);
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

  it('carries the exact observed values seen on be1d161', () => {
    const byKey = new Map(PRIMITIVE_KNOWN_GAPS.map((g) => [g.key, g]));
    const rejected = { status: 'rejected', errorCode: 'BUNDLE.UNSUPPORTED_CONTENT' };
    expect(byKey.get('G05/I4/mcp-server')).toMatchObject({ match: { kinds: ['mcp-server'] }, observed: rejected });
    expect(byKey.get('G08/I4/hook@kiro')).toMatchObject({ match: { kinds: ['hook'], targets: ['kiro'] }, observed: rejected });
    expect(byKey.get('G18/I8/copilot-cli@repository')).toEqual(expect.objectContaining({
      match: { targets: ['copilot-cli'], scopes: ['repository'] },
      observed: { effectiveScope: 'user' }
    }));
    const g15: Record<string, string> = {
      prompt: 'hello-world.prompt',
      instruction: 'code-style.instructions',
      'chat-mode': 'review.chatmode',
      agent: 'security.agent',
      hook: 'pre-commit.hook',
      'mcp-server': 'github.mcp',
      spec: 'requirements'
    };
    for (const [kind, id] of Object.entries(g15)) {
      expect(byKey.get(`G15/I2/${kind}`)).toMatchObject({ match: { kinds: [kind] }, observed: { id, kind, occurrences: 1 } });
    }
    expect(byKey.get('G13/I1/power'))
      .toMatchObject({ match: { kinds: ['power'] }, observed: { missingArchivePaths: ['powers/stripe/steering/payments.md'] } });
    expect(byKey.get('G13/I2/power')).toMatchObject({ match: { kinds: ['power'] }, observed: { id: 'POWER', kind: 'power', occurrences: 1 } });
  });
});
