import {
  describe,
  expect,
  it,
} from 'vitest';
import type {
  ExtractedFiles,
  ValidatedManifest,
} from '../../../src';
import {
  findUnsupportedPayloadContent,
} from '../../../src';

describe('runtime-target MCP payload policy', () => {
  const manifest = {
    id: 'mcp-bundle',
    version: '1.0.0',
    name: 'MCP bundle',
    items: [{ id: 'welcome', kind: 'prompt', path: 'prompts/welcome.prompt.md' }],
    mcpServers: { workspace: { command: 'node', args: ['server.js'] } },
    mcpInputs: []
  } as unknown as ValidatedManifest;
  const files: ExtractedFiles = new Map([
    ['deployment-manifest.yml', Buffer.from('id: mcp-bundle\nversion: 1.0.0\nname: MCP bundle\n')]
  ]);

  it('continues to reject MCP declarations unless the delivery enables MCP handling', () => {
    expect(findUnsupportedPayloadContent(manifest, files)).toContain('manifest declares unsupported "mcpServers" content');
    expect(findUnsupportedPayloadContent(manifest, files, { allowMcpServers: true })).toEqual([]);
  });

  it('never relaxes unrelated capability or file-path rejections', () => {
    const plugin = { ...manifest, plugins: [{ id: 'plugin' }] } as unknown as ValidatedManifest;
    const withPlugin = findUnsupportedPayloadContent(plugin, files, { allowMcpServers: true });
    expect(withPlugin).toContain('manifest declares unsupported "plugins" content');

    const withMcpPath: ExtractedFiles = new Map([...files, ['mcp/config.json', Buffer.from('{}')]]);
    expect(findUnsupportedPayloadContent(manifest, withMcpPath))
      .toContain('payload file "mcp/config.json" is under an unsupported capability prefix');
    expect(findUnsupportedPayloadContent(manifest, withMcpPath, { allowMcpServers: true }))
      .toEqual([]);

    const withMcpItem = {
      ...manifest,
      items: [{ id: 'server', kind: 'mcp-server', path: 'mcp/server.json' }]
    } as unknown as ValidatedManifest;
    expect(findUnsupportedPayloadContent(withMcpItem, files, { allowMcpServers: true }))
      .toContain('manifest item "mcp/server.json" declares unsupported kind "mcp-server"');

    const declarationless = { ...manifest, mcpServers: undefined } as unknown as ValidatedManifest;
    expect(findUnsupportedPayloadContent(declarationless, withMcpPath, { allowMcpServers: true }))
      .toContain('payload file "mcp/config.json" is under an unsupported capability prefix');
  });
});
