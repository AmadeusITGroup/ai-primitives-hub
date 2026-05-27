import {
  describe,
  expect,
  it,
} from 'vitest';
import type {
  PluginItem,
} from '../../src/domain';
import {
  derivePluginItems,
  extractPluginMcpServers,
  parsePluginManifest,
  resolvePluginItemEntryPath,
} from '../../src/harvest/plugin-manifest';

describe('plugin-manifest', () => {
  it('parses our explicit items[] format and keeps kinds normalized', () => {
    const raw = JSON.stringify({
      id: 'test-plugin',
      name: 'test-plugin',
      description: 'A test plugin',
      items: [
        { kind: 'skill', path: './skills/my-skill' },
        { kind: 'agent', path: './agents' },
        { kind: 'prompt', path: './prompts/hello.prompt.md' }
      ]
    });
    const manifest = parsePluginManifest(raw);
    expect(manifest.id).toBe('test-plugin');
    expect(manifest.name).toBe('test-plugin');
    const items = derivePluginItems(manifest);
    expect(items).toStrictEqual([
      { kind: 'skill', path: './skills/my-skill' },
      { kind: 'agent', path: './agents' },
      { kind: 'prompt', path: './prompts/hello.prompt.md' }
    ]);
  });

  it('parses the upstream awesome-copilot format with separate agents[] + skills[] arrays', () => {
    const raw = JSON.stringify({
      name: 'upstream-plugin',
      description: 'A plugin using upstream awesome-copilot format',
      version: '1.1.0',
      skills: ['./skills/java-docs'],
      agents: ['./agents/code-reviewer']
    });
    const manifest = parsePluginManifest(raw);
    const items = derivePluginItems(manifest);
    expect(items).toStrictEqual([
      { kind: 'agent', path: './agents/code-reviewer' },
      { kind: 'skill', path: './skills/java-docs' }
    ]);
  });

  it('prefers explicit items[] over agents/skills arrays if both are present', () => {
    const raw = JSON.stringify({
      name: 'hybrid',
      description: 'Has both formats',
      items: [{ kind: 'skill', path: './skills/real' }],
      skills: ['./skills/ignored'],
      agents: ['./agents/ignored']
    });
    const manifest = parsePluginManifest(raw);
    const items = derivePluginItems(manifest);
    expect(items).toStrictEqual([{ kind: 'skill', path: './skills/real' }]);
  });

  it('rejects manifests missing name or description (soft-fail with empty items)', () => {
    const raw = JSON.stringify({ items: [] });
    const manifest = parsePluginManifest(raw);
    expect(manifest.name).toBe(undefined);
    expect(derivePluginItems(manifest)).toStrictEqual([]);
  });

  it('throws on malformed JSON', () => {
    expect(
      () => parsePluginManifest('{ not json')
    ).toThrow(/plugin manifest parse error/u);
  });

  it('resolvePluginItemEntryPath normalises ./ prefix + handles directory vs file items', () => {
    const pluginRoot = 'plugins/my-plugin';
    expect(
      resolvePluginItemEntryPath(pluginRoot, { kind: 'skill', path: './skills/my-skill' })
    ).toBe('plugins/my-plugin/skills/my-skill/SKILL.md');
    expect(
      resolvePluginItemEntryPath(pluginRoot, { kind: 'agent', path: './agents/code-reviewer' })
    ).toBe('plugins/my-plugin/agents/code-reviewer/AGENT.md');
    expect(
      resolvePluginItemEntryPath(pluginRoot, { kind: 'prompt', path: './prompts/hello.prompt.md' })
    ).toBe('plugins/my-plugin/prompts/hello.prompt.md');
    expect(
      resolvePluginItemEntryPath(pluginRoot, { kind: 'instruction', path: './instructions/style.instructions.md' })
    ).toBe('plugins/my-plugin/instructions/style.instructions.md');
    expect(
      resolvePluginItemEntryPath(pluginRoot, { kind: 'chat-mode', path: './modes/debug.chatmode.md' })
    ).toBe('plugins/my-plugin/modes/debug.chatmode.md');
  });

  it('extracts MCP servers from either mcp.items (our format) or mcpServers (alternative)', () => {
    const our = parsePluginManifest(JSON.stringify({
      name: 'mcp-plugin',
      description: 'Has an MCP server',
      mcp: {
        items: {
          context7: { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7'] }
        }
      }
    }));
    const ourServers = extractPluginMcpServers(our);
    expect(Object.keys(ourServers)).toStrictEqual(['context7']);
    expect(ourServers.context7).toStrictEqual({ type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7'] });

    const alt = parsePluginManifest(JSON.stringify({
      name: 'mcp-plugin',
      description: 'Has an MCP server',
      mcpServers: { filesystem: { type: 'stdio', command: 'mcp-filesystem' } }
    }));
    expect(extractPluginMcpServers(alt)).toStrictEqual({
      filesystem: { type: 'stdio', command: 'mcp-filesystem' }
    });

    const both = parsePluginManifest(JSON.stringify({
      name: 'mcp-plugin',
      description: '',
      mcp: { items: { shared: { type: 'stdio', command: 'ours' } } },
      mcpServers: { shared: { type: 'stdio', command: 'theirs' }, only: { type: 'http', url: 'x' } }
    }));
    const merged = extractPluginMcpServers(both);
    expect(merged.shared).toStrictEqual({ type: 'stdio', command: 'ours' });
    expect(merged.only).toStrictEqual({ type: 'http', url: 'x' });

    expect(extractPluginMcpServers(parsePluginManifest('{"name":"x","description":"x"}'))).toStrictEqual({});
  });

  it('ignores items with non-string path or unknown kind', () => {
    const raw = JSON.stringify({
      name: 'bad-items',
      description: 'Has a bunch of broken entries',
      items: [
        { kind: 'skill', path: './ok' },
        { kind: 'skill' }, // missing path
        { kind: 'unknown-kind', path: './nope' },
        { path: './still-no-kind' },
        { kind: 'prompt', path: 42 as unknown as string }
      ]
    });
    const manifest = parsePluginManifest(raw);
    const items: PluginItem[] = derivePluginItems(manifest);
    expect(items).toStrictEqual([{ kind: 'skill', path: './ok' }]);
  });
});
