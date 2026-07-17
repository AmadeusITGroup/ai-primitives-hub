/**
 * Tests for `framework/suggest.ts`.
 *
 * `suggestCommand` returns a "Did you mean: ..." string when the user
 * types something close to a known command path.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  suggestCommand,
} from '../../src/framework';

interface FakeDefinition {
  path: string;
  description: string;
}

const fakeCli = (defs: FakeDefinition[]): { definitions: () => FakeDefinition[] } => ({
  definitions: () => defs
});

describe('suggestCommand', () => {
  it('suggests the closest known command for a typo', () => {
    const cli = fakeCli([
      { path: 'ai hub add', description: 'Add a hub' },
      { path: 'ai hub list', description: 'List hubs' }
    ]);
    const result = suggestCommand(['hubb', 'add'], cli as unknown as Parameters<typeof suggestCommand>[1], 'ai');
    expect(result).toBe('hub add');
  });

  it('returns undefined for an empty or very different input', () => {
    const cli = fakeCli([
      { path: 'ai hub add', description: 'Add a hub' }
    ]);
    expect(suggestCommand(['xyz'], cli as unknown as Parameters<typeof suggestCommand>[1], 'ai')).toBeUndefined();
    expect(suggestCommand([], cli as unknown as Parameters<typeof suggestCommand>[1], 'ai')).toBeUndefined();
  });

  it('ignores built-in flags and definitions with no description', () => {
    const cli = fakeCli([
      { path: 'ai --help', description: 'Show help' },
      { path: 'ai --version', description: 'Show version' },
      { path: 'ai hub add', description: 'Add a hub' },
      { path: 'ai hub', description: '' }
    ]);
    const result = suggestCommand(['hubb', 'add'], cli as unknown as Parameters<typeof suggestCommand>[1], 'ai');
    expect(result).toBe('hub add');
  });

  it('stops at the first flag when reconstructing the attempted command', () => {
    const cli = fakeCli([
      { path: 'ai index search', description: 'Search index' }
    ]);
    const result = suggestCommand(['index', 'serch', '--verbose'], cli as unknown as Parameters<typeof suggestCommand>[1], 'ai');
    expect(result).toBe('index search');
  });
});
