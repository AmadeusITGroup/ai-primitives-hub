# Optional MCP Server Setup

This directory contains an optional Model Context Protocol (MCP) server configuration for your collection.

## What is MCP?

MCP (Model Context Protocol) allows your collection to provide custom tools and context to GitHub Copilot through server-side extensions.

## Quick Start

The MCP server configuration is **optional**. If you don't need MCP functionality, you can safely ignore this directory.

### Using a Pre-built MCP Server (Recommended)

The easiest way to add MCP functionality is to use an existing server that can be run with `npx`:

1. Uncomment the `mcp` section in your `*.collection.yml` file
2. Use one of these popular MCP servers:

```yaml
mcp:
  items:
    # Filesystem access server (read/write files)
    filesystem:
      command: npx
      args:
        - -y
        - "@modelcontextprotocol/server-filesystem"
        - ${env:HOME}/Documents

    # Memory/notes server (persistent key-value storage)
    memory:
      command: npx
      args:
        - -y
        - "@modelcontextprotocol/server-memory"

    # Time/date utilities server
    time:
      command: npx
      args:
        - -y
        - "@modelcontextprotocol/server-sequential-thinking"

    # GitHub API server
    github:
      command: npx
      args:
        - -y
        - "@modelcontextprotocol/server-github"
      env:
        GITHUB_PERSONAL_ACCESS_TOKEN: ${env:GITHUB_TOKEN}
```

### Creating a Custom MCP Server

If you want to create a custom server, add your implementation here:

```
mcp-server/
├── README.md (this file)
├── server.js (Node.js implementation)
└── server.py (Python implementation)
```

Then reference it in your collection:

```yaml
mcp:
  items:
    my-custom-server:
      command: node
      args:
        - ${bundlePath}/mcp-server/server.js
```

## Variable Substitution

You can use these variables in your MCP configuration:

- `${bundlePath}` - Absolute path to the installed bundle
- `${bundleId}` - Bundle identifier
- `${bundleVersion}` - Bundle version
- `${env:VAR_NAME}` - Environment variable

## Testing Your MCP Server

1. Install your collection bundle
2. Check that the server appears in VS Code's MCP settings
3. Interact with Copilot - it should have access to your MCP tools

## Learn More

- [MCP Documentation](https://modelcontextprotocol.io/)
- [MCP Server Examples](https://github.com/modelcontextprotocol/servers)
