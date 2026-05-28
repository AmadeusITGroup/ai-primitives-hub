# Collection Schema Reference

Collection manifests (`.collection.yml`) define the structure and contents of a prompt collection.

## Annotated Example

```yaml
id: python-development              # Required. Lowercase, numbers, hyphens only
name: Python Development Suite      # Required. Human-readable display name (max 100 chars)
description: Prompts for Python dev # Required. What this collection does (max 500 chars)
version: 2.1.0                      # Optional. Semantic version
author: Python Team                 # Optional. Creator name
tags:                               # Optional. For discoverability
  - python
  - testing

items:                              # Required. List of resources (max 50)
  - path: prompts/write-tests.prompt.md   # Required. Relative path to file
    kind: prompt                          # Required. One of: prompt, instruction, chat-mode, agent
    title: Test Writer                    # Optional. Display title
    description: Generates unit tests     # Optional. Item description
    tags: [testing, pytest]               # Optional. Item-level tags

  - path: instructions/standards.instructions.md
    kind: instruction

  - path: agents/runner.agent.md
    kind: agent

mcp:                                # Optional. MCP server configurations
  items:
    # Stdio server (local process)
    python-analyzer:                # Server name
      type: stdio                   # Optional. Default: stdio
      command: python               # Required for stdio. Command to start server
      args:                         # Optional. Command arguments
        - "${bundlePath}/server.py" # ${bundlePath} = installed bundle path
      env:                          # Optional. Environment variables
        LOG_LEVEL: info
      envFile: "${bundlePath}/.env" # Optional. Path to env file
      disabled: false               # Optional. Default: false
      description: Python analyzer  # Optional. Human-readable description

    # Remote HTTP server
    api-server:
      type: http                    # Required for remote. One of: http, sse
      url: "https://api.example.com/mcp"  # Required for remote
      headers:                      # Optional. Authentication headers
        Authorization: "Bearer ${env:API_TOKEN}"

    # Remote SSE server
    streaming-server:
      type: sse
      url: "https://stream.example.com/mcp/events"

display:                            # Optional. UI preferences
  color: "#3776AB"                  # Color theme
  icon: python                      # Icon identifier
  ordering: manual                  # manual or alphabetical
  show_badge: true                  # Show badge in UI
```

## MCP Server Duplicate Detection

When multiple collections define the same MCP server, Prompt Registry automatically detects and manages duplicates to prevent conflicts in VS Code's `mcp.json`.

### How It Works

**Server Identity** is computed based on server type:
- **Stdio servers**: `command` + `args` (e.g., `node server.js --port 3000`)
- **Remote servers**: `url` (e.g., `https://api.example.com/mcp`)

**Behavior**:
1. First installed server with a given identity remains **enabled**
2. Subsequent duplicates are **disabled** with a description noting the original
3. When the active server's bundle is uninstalled, a disabled duplicate is **re-enabled**
4. At least one instance stays active until all bundles with that server are removed

This allows multiple collections to safely share common MCP servers without conflicts.

## Validation

Run `Ctrl+Shift+P` → "Prompt Registry: Validate Collections"

## See Also

- [Creating Collections](./creating-source-bundle.md)
- [Publishing Guide](./publishing.md)
