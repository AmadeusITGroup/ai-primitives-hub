/**
 * Tests for the primitive diagnostics placement oracle.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  DIAGNOSTIC_SCOPES,
  type DiagnosticBundle,
  expectedDestination,
  type FixtureItem,
  PLACEMENT_ROOTS,
  PLACEMENT_ROUTES,
  PRIMITIVE_DIAGNOSTIC_BUNDLES,
  PRIMITIVE_SUPPORT_MATRIX,
} from '../../../../src/domain/diagnostics/primitives';
import {
  TARGET_TYPES,
  type TargetType,
} from '../../../../src/domain/install/target';
import type {
  PrimitiveKind,
} from '../../../../src/domain/primitive/types';

const itemOf = (kind: PrimitiveKind): FixtureItem =>
  (PRIMITIVE_DIAGNOSTIC_BUNDLES.find((b: DiagnosticBundle) => b.items[0].kind === kind)!).items[0];

const labels = (target: TargetType, scope: 'user' | 'repository', kind: PrimitiveKind): string[] => {
  const item = itemOf(kind);
  return item.files.map((file) => {
    const destination = expectedDestination(target, scope, item, file);
    return destination.kind === 'file' ? destination.label : destination.kind;
  });
};

describe('PLACEMENT_ROUTES', () => {
  it('has a route for every supported cell and none for an unsupported cell', () => {
    for (const [kind, row] of Object.entries(PRIMITIVE_SUPPORT_MATRIX)) {
      for (const target of TARGET_TYPES) {
        const route = PLACEMENT_ROUTES[target][kind as PrimitiveKind];
        if (row[target] === 'unsupported') {
          expect(route, `${kind}@${target}`).toBeUndefined();
        } else {
          expect(route, `${kind}@${target}`).toBeDefined();
        }
      }
    }
  });

  it('routes mcp-server to a merged config on every target', () => {
    for (const target of TARGET_TYPES) {
      expect(PLACEMENT_ROUTES[target]['mcp-server']).toBe('config');
    }
  });

  it('keeps routes for the gapped cells so a fix PR only deletes the gap entry', () => {
    expect(PLACEMENT_ROUTES['copilot-cli']['chat-mode']).toBe('agents/');
    expect(PLACEMENT_ROUTES.kiro.hook).toBe('hooks/');
    expect(PLACEMENT_ROOTS['copilot-cli'].repository).toBe('<workspace>/.github');
  });

  it('roots every target at $HOME (user) and <workspace> (repository)', () => {
    for (const target of TARGET_TYPES) {
      for (const scope of DIAGNOSTIC_SCOPES) {
        expect(PLACEMENT_ROOTS[target][scope].startsWith(scope === 'user' ? '$HOME/.' : '<workspace>/.')).toBe(true);
      }
    }
  });
});

describe('expectedDestination', () => {
  // Expected labels: the placements the product produces today.
  it('places a prompt on kiro at user scope under steering/', () => {
    expect(labels('kiro', 'user', 'prompt')).toEqual(['$HOME/.kiro/steering/hello-world.prompt.md']);
  });

  it('places a skill directory unit on vscode at repository scope', () => {
    expect(labels('vscode', 'repository', 'skill')).toEqual([
      '<workspace>/.github/skills/standalone-skill/SKILL.md',
      '<workspace>/.github/skills/standalone-skill/references/guide.md',
      '<workspace>/.github/skills/standalone-skill/scripts/run.sh'
    ]);
  });

  it('places a spec on kiro', () => {
    expect(labels('kiro', 'user', 'spec')).toEqual(['$HOME/.kiro/specs/feature/requirements.md']);
    expect(labels('kiro', 'repository', 'spec')).toEqual(['<workspace>/.kiro/specs/feature/requirements.md']);
  });

  it('places devin user skills and agents under ~/.config/devin, where Devin reads them', () => {
    for (const target of ['devin', 'devin-cli'] as const) {
      expect(labels(target, 'user', 'skill').every((label) => label.startsWith('$HOME/.config/devin/skills/standalone-skill/'))).toBe(true);
      expect(labels(target, 'user', 'agent').every((label) => label.startsWith('$HOME/.config/devin/agents/'))).toBe(true);
      expect(labels(target, 'repository', 'skill').every((label) => label.startsWith('<workspace>/.devin/skills/standalone-skill/'))).toBe(true);
    }
  });

  it('places devin instructions as rules at both scopes', () => {
    for (const target of ['devin', 'devin-cli'] as const) {
      expect(labels(target, 'user', 'instruction').every((label) => label.startsWith('$HOME/.devin/rules/'))).toBe(true);
      expect(labels(target, 'repository', 'instruction').every((label) => label.startsWith('<workspace>/.devin/rules/'))).toBe(true);
    }
  });

  it('places prompts as Desktop workflows on devin and as rules on devin-cli', () => {
    expect(labels('devin', 'repository', 'prompt').every((label) => label.startsWith('<workspace>/.devin/workflows/'))).toBe(true);
    expect(labels('devin', 'user', 'prompt').every((label) => label.startsWith('$HOME/.codeium/windsurf/global_workflows/'))).toBe(true);
    expect(labels('devin-cli', 'repository', 'prompt').every((label) => label.startsWith('<workspace>/.devin/rules/'))).toBe(true);
    expect(labels('devin-cli', 'user', 'prompt').every((label) => label.startsWith('$HOME/.devin/rules/'))).toBe(true);
  });

  it('places a power on devin', () => {
    const item = itemOf('power');
    expect(expectedDestination('devin', 'user', item, 'powers/stripe/POWER.md'))
      .toEqual({ kind: 'file', label: '$HOME/.devin/powers/stripe/POWER.md' });
    expect(expectedDestination('devin', 'repository', item, 'powers/stripe/POWER.md'))
      .toEqual({ kind: 'file', label: '<workspace>/.devin/powers/stripe/POWER.md' });
  });

  it('returns config for mcp-server and none for an unsupported cell', () => {
    expect(labels('vscode', 'user', 'mcp-server')).toEqual(['config']);
    expect(labels('vscode', 'user', 'steering')).toEqual(['none']);
  });
});
