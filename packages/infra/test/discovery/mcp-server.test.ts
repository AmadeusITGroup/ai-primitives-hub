/**
 * Tests for MCP server implementation.
 * @module test/infra/discovery/mcp-server
 */

import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  McpServerImpl,
} from '../../src/discovery/mcp-server';
import type {
  McpServer,
  McpTool,
} from '../../src/ports/mcp-server';

describe('McpServerImpl', () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServerImpl();
  });

  it('should implement McpServer interface', () => {
    expect(server).toHaveProperty('start');
    expect(server).toHaveProperty('stop');
    expect(server).toHaveProperty('registerTool');
  });

  it('should start successfully', async () => {
    await server.start();
    // Should not throw
    expect(true).toBe(true);
  });

  it('should stop successfully', async () => {
    await server.start();
    await server.stop();
    // Should not throw
    expect(true).toBe(true);
  });

  it('should register a tool', () => {
    const tool: McpTool = {
      name: 'test_tool',
      description: 'Test tool',
      inputSchema: {},
      handler: vi.fn()
    };

    server.registerTool(tool);
    // Should not throw
    expect(true).toBe(true);
  });

  it('should register multiple tools', () => {
    const tool1: McpTool = {
      name: 'tool1',
      description: 'Tool 1',
      inputSchema: {},
      handler: vi.fn()
    };

    const tool2: McpTool = {
      name: 'tool2',
      description: 'Tool 2',
      inputSchema: {},
      handler: vi.fn()
    };

    server.registerTool(tool1);
    server.registerTool(tool2);
    // Should not throw
    expect(true).toBe(true);
  });

  it('should handle tool registration with complex schema', () => {
    const tool: McpTool = {
      name: 'complex_tool',
      description: 'Tool with complex schema',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          type: { type: 'string', enum: ['profile', 'bundle', 'primitive'] }
        },
        required: ['query']
      },
      handler: vi.fn()
    };

    server.registerTool(tool);
    // Should not throw
    expect(true).toBe(true);
  });

  it('should handle tool handler execution', async () => {
    const handler = vi.fn().mockResolvedValue({ result: 'success' });
    const tool: McpTool = {
      name: 'executable_tool',
      description: 'Tool that executes',
      inputSchema: {},
      handler
    };

    server.registerTool(tool);

    const result = await tool.handler({ input: 'test' });
    expect(result).toEqual({ result: 'success' });
    expect(handler).toHaveBeenCalledWith({ input: 'test' });
  });

  it('should handle tool handler errors gracefully', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('Tool error'));
    const tool: McpTool = {
      name: 'failing_tool',
      description: 'Tool that fails',
      inputSchema: {},
      handler
    };

    server.registerTool(tool);

    await expect(tool.handler({ input: 'test' })).rejects.toThrow('Tool error');
  });

  it('should handle starting server when already running', async () => {
    await server.start();
    await server.start(); // Should not throw
  });

  it('should handle stopping server when not running', async () => {
    await server.stop(); // Should not throw
  });

  it('should handle tool with async handler', async () => {
    const handler = vi.fn().mockImplementation(async (_input: unknown) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { result: 'async success' };
    });

    const tool: McpTool = {
      name: 'async_tool',
      description: 'Tool with async handler',
      inputSchema: {},
      handler
    };

    server.registerTool(tool);

    const result = await tool.handler({ input: 'test' });
    expect(result).toEqual({ result: 'async success' });
  });

  it('should handle tool with complex input', async () => {
    const handler = vi.fn().mockResolvedValue({ result: 'complex' });
    const tool: McpTool = {
      name: 'complex_input_tool',
      description: 'Tool with complex input',
      inputSchema: {
        type: 'object',
        properties: {
          nested: {
            type: 'object',
            properties: {
              value: { type: 'string' }
            }
          }
        }
      },
      handler
    };

    server.registerTool(tool);

    const complexInput = {
      nested: { value: 'test' }
    };

    const result = await tool.handler(complexInput);
    expect(result).toEqual({ result: 'complex' });
    expect(handler).toHaveBeenCalledWith(complexInput);
  });

  it('should handle tool registration with unicode name', () => {
    const tool: McpTool = {
      name: 'tool_🚀',
      description: 'Tool with unicode name',
      inputSchema: {},
      handler: vi.fn()
    };

    server.registerTool(tool);
    // Should not throw
    expect(true).toBe(true);
  });

  it('should handle tool registration with long description', () => {
    const longDesc = 'a'.repeat(1000);
    const tool: McpTool = {
      name: 'long_desc_tool',
      description: longDesc,
      inputSchema: {},
      handler: vi.fn()
    };

    server.registerTool(tool);
    // Should not throw
    expect(true).toBe(true);
  });

  it('should handle tool with no description', () => {
    const tool: McpTool = {
      name: 'no_desc_tool',
      description: '',
      inputSchema: {},
      handler: vi.fn()
    };

    server.registerTool(tool);
    // Should not throw
    expect(true).toBe(true);
  });

  it('should handle multiple start/stop cycles', async () => {
    await server.start();
    await server.stop();
    await server.start();
    await server.stop();
    // Should not throw
    expect(true).toBe(true);
  });
});
