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
    kind: prompt                          # Required. See "Item Kinds" below (e.g., prompt, instruction, chat-mode, agent, skill, plugin)
    title: Test Writer                    # Optional. Display title
    description: Generates unit tests     # Optional. Item description
    tags: [testing, pytest]               # Optional. Item-level tags

  - path: instructions/standards.instructions.md
    kind: instruction

  - path: agents/runner.agent.md
    kind: agent
readme:                                   # Optional. Documentation for the collection.
  path: docs/python-development/readme.md 

mcp:                                # Optional. MCP server configurations
  inputs:                           # Optional. Input definitions for secrets/configurable values
    - id: apiToken                  # Required. Referenced as ${input:apiToken} in server config
      type: promptString            # Required. One of: promptString, pickString, command
      description: API access token # Optional. Label shown to the user
      password: true                # Optional. Mask the value (for secrets)
    - id: environment
      type: pickString
      description: Target environment
      options: [staging, production]
      default: staging
  items:
    # Stdio server (local process)
    python-analyzer:                # Server name
      type: stdio                   # Optional. Default: stdio
      command: python               # Required for stdio. Command to start server
      args:                         # Optional. Command arguments
        - "${bundlePath}/server.py" # ${bundlePath} = installed bundle path
      env:                          # Optional. Environment variables
        LOG_LEVEL: info
        TOKEN: "${input:apiToken}"  # Reference an input
      envFile: "${bundlePath}/.env" # Optional. Path to env file
      disabled: false               # Optional. Default: false
      description: Python analyzer  # Optional. Human-readable description

    # Remote HTTP server
    api-server:
      type: http                    # Required for remote. One of: http, sse
      url: "https://api.example.com/mcp"  # Required for remote
      headers:                      # Optional. Authentication headers
        Authorization: "Bearer ${input:apiToken}"  # Use an input for secrets

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

## Item Kinds

The `items[].kind` field accepts any of the primitive kinds defined in `collection.schema.json`:

- **Portable / cross-client:** `prompt`, `instruction`, `chat-mode`, `agent`, `skill`, `plugin`, `hook`, `mcp-server`
- **Harness-specific:** `steering`, `spec`, `command`, `rule`, `output-style`, `tool`, `power`, `knowledge`, `playbook`

## Plugin Items

A `kind: plugin` item points to the root manifest of an
[Agent Plugins](https://agent-plugins.org/specification) plugin:

```yaml
items:
  - path: plugins/my-plugin/plugin.json
    kind: plugin
```

The directory that contains `plugin.json` is the plugin root, and the whole
directory is bundled. `plugin.json` must be an Agent Plugins 1.0.0 manifest, and
its `name` must equal the directory name.

Scaffold a plugin and add it to a collection with:

```bash
ai-primitives-hub plugin create my-plugin --collection <collection-id>
```

This writes `plugins/my-plugin/plugin.json` and adds the item above. `--path <dir>`
changes the parent directory (default `plugins/`). The manifest passes
`collection validate` as written:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "A my-plugin plugin",
  "author": {
    "name": "Jane Doe"
  }
}
```

The name must be 1–64 characters of lowercase letters, digits, `.` and `-`, start
and end with a letter or digit, and contain no `--` or `..`. An invalid name such as
`My_Plugin` is rejected with a suggested valid name, and nothing is written. An
existing `plugin.json` is never overwritten.

Add components inside the plugin directory, for example a skill:

```bash
ai-primitives-hub skill create my-skill --path plugins/my-plugin/skills
```

See [Validating Collections](./validation.md#plugin-manifests) for the full list of checks.

## MCP Input Definitions

Use `mcp.inputs` to declare secrets or user-configurable values. VS Code will prompt the user when the server starts. Inputs are referenced in server configuration using `${input:id}`.

| Field | Required | Description |
|-------|----------|-------------|
| `id` | ✅ | Unique identifier (alphanumeric, `-`, `_`) |
| `type` | ✅ | `promptString`, `pickString`, or `command` |
| `description` | — | Label shown to the user |
| `password` | — | Mask the input (use for secrets) |
| `default` | — | Pre-filled value |
| `options` | — | List of choices for `pickString` |

**Install behaviour**: inputs from `mcp.inputs` are merged into `.vscode/mcp.json`. Existing inputs with the same `id` are preserved — they are never overwritten.

**Uninstall behaviour**: when a bundle is uninstalled, inputs that are no longer referenced by any remaining MCP server are automatically removed from `mcp.json`.

## MCP Server Duplicate Detection

When multiple collections define the same MCP server, AI Primitives Hub automatically detects and manages duplicates to prevent conflicts in VS Code's `mcp.json`.

## Documentation

Make sure to provide a readme for your collections. This is what gets displayed in the detailed view of the collection in the marketplace.

> **Note :** The current version only supports absolute links for images.
>
> **example :**
> `![alt text](https://somedomain.com/awesomeimage.jpg)` ✅
> `![alt text](./assets/awesomeimage.jpg)` ❌

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

Open the Command Palette (`Ctrl+Shift+P` on Windows/Linux or `Cmd+Shift+P` on
macOS) and run **AI Primitives Hub: Validate Collections**.

## See Also

- [Creating Collections](./creating-source-bundle.md)
- [Publishing Guide](./publishing.md)
