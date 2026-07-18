#!/usr/bin/env node

/**
 * Example MCP Server for {{projectName}}
 * 
 * This is a minimal Model Context Protocol server implementation.
 * Rename this file to server.js to activate it, or create your own implementation.
 * 
 * Requirements:
 * - Node.js 18+
 * - @modelcontextprotocol/sdk package
 * 
 * Install: npm install @modelcontextprotocol/sdk
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// Create MCP server instance
const server = new Server(
  {
    name: '{{projectName}}-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'hello',
        description: 'Returns a greeting message',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Name to greet',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'get_collection_info',
        description: 'Returns information about this prompt collection',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'hello':
      return {
        content: [
          {
            type: 'text',
            text: `Hello, ${args.name}! Welcome to {{projectName}}.`,
          },
        ],
      };

    case 'get_collection_info':
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                name: '{{projectName}}',
                description: 'Custom prompt collection',
                version: '1.0.0',
                tools: ['hello', 'get_collection_info'],
              },
              null,
              2
            ),
          },
        ],
      };

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('{{projectName}} MCP server running on stdio');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
