/**
 * Tests for `framework/help-renderer.ts`.
 *
 * `renderGlobalHelp` produces a landing-page help string from clipanion
 * command definitions, grouped by category.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  renderGlobalHelp,
} from '../../src/framework';

interface FakeDefinition {
  path: string;
  description: string;
  category?: string;
}

const fakeCli = (defs: FakeDefinition[]) => ({
  definitions: ({ colored: _colored }: { colored?: boolean }) => defs.map((d) => ({
    path: d.path,
    description: d.description,
    category: d.category,
    usage: '',
    options: []
  }))
});

describe('renderGlobalHelp', () => {
  it('renders the binary name and version', () => {
    const cli = fakeCli([]);
    const out = renderGlobalHelp(cli as unknown as Parameters<typeof renderGlobalHelp>[0], 'ai', '1.0.0');
    expect(out).toContain('ai 1.0.0');
  });

  it('renders the quick start section', () => {
    const cli = fakeCli([]);
    const out = renderGlobalHelp(cli as unknown as Parameters<typeof renderGlobalHelp>[0], 'ai', '1.0.0');
    expect(out).toContain('Quick Start');
    expect(out).toContain('target add');
  });

  it('groups commands by category and strips the binary prefix', () => {
    const cli = fakeCli([
      { path: 'ai index search', description: 'Search index', category: 'Index & Search' },
      { path: 'ai index build', description: 'Build index', category: 'Index & Search' },
      { path: 'ai hub add', description: 'Add a hub', category: 'Hub & Discovery' }
    ]);
    const out = renderGlobalHelp(cli as unknown as Parameters<typeof renderGlobalHelp>[0], 'ai', '1.0.0');
    expect(out).toContain('Index & Search');
    expect(out).toContain('index search');
    expect(out).toContain('index build');
    expect(out).toContain('Hub & Discovery');
    expect(out).toContain('hub add');
  });

  it('skips built-ins and definitions without descriptions', () => {
    const cli = fakeCli([
      { path: 'ai --help', description: 'Show help' },
      { path: 'ai --version', description: 'Show version' },
      { path: 'ai hub add', description: 'Add a hub', category: 'Hub' },
      { path: 'ai hidden', description: '', category: 'Hub' }
    ]);
    const out = renderGlobalHelp(cli as unknown as Parameters<typeof renderGlobalHelp>[0], 'ai', '1.0.0');
    expect(out).not.toContain('--help');
    expect(out).not.toContain('--version');
    expect(out).not.toContain('hidden');
  });

  it('alphabetically sorts commands within a category', () => {
    const cli = fakeCli([
      { path: 'ai zebra', description: 'Z', category: 'Test' },
      { path: 'ai alpha', description: 'A', category: 'Test' }
    ]);
    const out = renderGlobalHelp(cli as unknown as Parameters<typeof renderGlobalHelp>[0], 'ai', '1.0.0');
    const alphaIndex = out.indexOf('alpha');
    const zebraIndex = out.indexOf('zebra');
    expect(alphaIndex).toBeLessThan(zebraIndex);
  });
});
