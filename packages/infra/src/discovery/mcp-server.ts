/**
 * MCP server implementation for resource discovery.
 *
 * Provides a mock MCP server for testing and development.
 * @module infra/discovery/mcp-server
 */

import type {
  McpServer as IMcpServer,
  McpTool,
} from '@prompt-registry/core';

/**
 * Mock MCP server implementation.
 */
export class McpServerImpl implements IMcpServer {
  private readonly tools: Map<string, McpTool> = new Map();

  /**
   * Start the MCP server.
   * @returns Promise that resolves when server is started.
   */
  public async start(): Promise<void> {
    // Mock implementation - no actual server to start
  }

  /**
   * Stop the MCP server.
   * @returns Promise that resolves when server is stopped.
   */
  public async stop(): Promise<void> {
    // Mock implementation - no actual server to stop
  }

  /**
   * Register a tool with the server.
   * @param tool Tool to register.
   */
  public registerTool(tool: McpTool): void {
    this.tools.set(tool.name, tool);
  }
}
