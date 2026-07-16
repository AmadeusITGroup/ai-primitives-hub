import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  isTarget,
  TARGET_TYPES,
} from '../../../src/domain/install/target';

describe('isTarget', () => {
  it('accepts a minimal valid target', () => {
    expect(isTarget({ name: 'my-vscode', type: 'vscode', scope: 'user' })).toBe(true);
  });

  it('accepts every known target type', () => {
    for (const type of TARGET_TYPES) {
      expect(isTarget({ name: `t-${type}`, type })).toBe(true);
    }
  });

  it('accepts a repository-scoped target with a commit mode', () => {
    expect(
      isTarget({
        name: 'repo-kiro',
        type: 'kiro',
        scope: 'repository',
        commitMode: 'local-only'
      })
    ).toBe(true);
  });

  it('rejects a missing or empty name', () => {
    expect(isTarget({ type: 'vscode' })).toBe(false);
    expect(isTarget({ name: '', type: 'vscode' })).toBe(false);
  });

  it('rejects an unknown type', () => {
    expect(isTarget({ name: 'x', type: 'not-a-real-target' })).toBe(false);
  });

  it('rejects an invalid scope or commit mode', () => {
    expect(isTarget({ name: 'x', type: 'vscode', scope: 'nonsense' })).toBe(false);
    expect(isTarget({ name: 'x', type: 'vscode', commitMode: 'nonsense' })).toBe(false);
  });

  it('rejects non-object values', () => {
    expect(isTarget(null)).toBe(false);
    expect(isTarget('vscode')).toBe(false);
    expect(isTarget(42)).toBe(false);
  });
});
