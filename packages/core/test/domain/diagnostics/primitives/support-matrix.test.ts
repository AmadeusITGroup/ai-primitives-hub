/**
 * Tests for the primitive diagnostics support matrix.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  expectedStatus,
  PRIMITIVE_DIAGNOSTIC_BUNDLES,
  PRIMITIVE_SUPPORT_MATRIX,
} from '../../../../src/domain/diagnostics/primitives';
import {
  TARGET_TYPES,
} from '../../../../src/domain/install/target';
import type {
  PrimitiveKind,
} from '../../../../src/domain/primitive/types';

const catalogued = [...new Set(PRIMITIVE_DIAGNOSTIC_BUNDLES.flatMap((b) => b.items.map((i) => i.kind)))];

/** Kinds supported only on some targets: the targets they ARE supported on; every other kind is supported everywhere. */
const SUPPORTED_ONLY_ON: Record<string, readonly string[]> = {
  steering: ['kiro', 'kiro-cli'],
  spec: ['kiro', 'kiro-cli'],
  command: ['claude-code'],
  rule: ['cursor'],
  'output-style': ['claude-code'],
  tool: ['opencode'],
  power: ['kiro', 'kiro-cli', 'devin', 'devin-cli'],
  knowledge: ['devin', 'devin-cli'],
  playbook: ['devin', 'devin-cli']
};

describe('PRIMITIVE_SUPPORT_MATRIX', () => {
  it('has exactly one row per catalogued kind, each with all 11 targets', () => {
    expect(Object.keys(PRIMITIVE_SUPPORT_MATRIX).toSorted()).toEqual(catalogued.toSorted());
    for (const kind of catalogued) {
      expect(Object.keys(PRIMITIVE_SUPPORT_MATRIX[kind]!)).toEqual([...TARGET_TYPES]);
    }
  });

  it('matches the observed support (projected is unused)', () => {
    for (const kind of catalogued) {
      const row = PRIMITIVE_SUPPORT_MATRIX[kind]!;
      for (const target of TARGET_TYPES) {
        const supportedOn = SUPPORTED_ONLY_ON[kind];
        const expected = supportedOn === undefined || supportedOn.includes(target) ? 'native' : 'unsupported';
        expect(row[target], `${kind}@${target}`).toBe(expected);
      }
    }
  });

  it('marks the gapped cells and chat-mode on copilot-cli (fixed by #526) as supported', () => {
    expect(Object.values(PRIMITIVE_SUPPORT_MATRIX['mcp-server']!).every((level) => level === 'native')).toBe(true);
    expect(PRIMITIVE_SUPPORT_MATRIX.hook!.kiro).toBe('native');
    expect(PRIMITIVE_SUPPORT_MATRIX.plugin!.kiro).toBe('native');
    expect(PRIMITIVE_SUPPORT_MATRIX['chat-mode']!['copilot-cli']).toBe('native');
  });
});

describe('expectedStatus', () => {
  it('is installed when every kind is supported on the target, rejected when none is', () => {
    expect(expectedStatus(['prompt'], 'vscode')).toBe('installed');
    expect(expectedStatus(['steering'], 'vscode')).toBe('rejected');
    expect(expectedStatus(['steering'], 'kiro')).toBe('installed');
    expect(expectedStatus(['steering', 'spec'], 'vscode')).toBe('rejected');
    expect(expectedStatus(['mcp-server'], 'cursor')).toBe('installed');
  });

  it('is partial when the target supports some kinds of the bundle but not all', () => {
    expect(expectedStatus(['prompt', 'steering'], 'vscode')).toBe('partial');
    expect(expectedStatus(['prompt', 'steering'], 'kiro')).toBe('installed');
  });

  it('never gives partial for a single-kind bundle', () => {
    for (const kind of catalogued) {
      for (const target of TARGET_TYPES) {
        expect(expectedStatus([kind], target)).not.toBe('partial');
      }
    }
  });

  it('throws for a kind without a row', () => {
    expect(() => expectedStatus(['bogus' as PrimitiveKind], 'vscode')).toThrow('no support-matrix row for bogus');
  });

  it('expects the portable mix installed everywhere and the all-kinds mix partial everywhere', () => {
    const kindsOf = (id: string): PrimitiveKind[] => PRIMITIVE_DIAGNOSTIC_BUNDLES.find((b) => b.id === id)!.items.map((i) => i.kind);
    for (const target of TARGET_TYPES) {
      expect(expectedStatus(kindsOf('aph-e2e-mix-portable'), target), target).toBe('installed');
      expect(expectedStatus(kindsOf('aph-e2e-mix-all-kinds'), target), target).toBe('partial');
    }
  });
});
