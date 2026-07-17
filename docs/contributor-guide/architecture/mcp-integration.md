# MCP Integration

Bundles can include MCP (Model Context Protocol) servers that extend Copilot's capabilities.

## Components

| Component | Responsibility |
|-----------|---------------|
| **BundleInstaller** | Calls MCP install/uninstall during bundle lifecycle |
| **McpServerManager** | Orchestrates installation, naming, tracking, input merging |
| **McpConfigService** | Reads/writes VS Code's `mcp.json`, merges/cleans inputs |

## Installation Flow

```mermaid
graph TD
    A["Bundle Install"]
    B["BundleInstaller.installMcpServers()"]
    C["McpServerManager.installServers() or\ninstallServersToWorkspace()"]
    D["• Add bundle prefix to name\n(prompt-registry:bundleId:server-name)\n• Substitute variables\n• mergeInputs() — deduplicate by id\n• Write servers + inputs to mcp.json\n• Create tracking metadata"]
    E["MCP servers + inputs available to Copilot"]
    
    A --> B
    B --> C
    C --> D
    D --> E
```

## Server Types

### Stdio Servers (Local Process)

```yaml
mcpServers:
  server-name:
    type: stdio              # Optional (default)
    command: string          # Required
    args: string[]           # Optional
    env: Record<string, string>  # Optional
    envFile: string          # Optional - path to .env file
    disabled: boolean        # Optional (default: false)
    description: string      # Optional
```

### Remote Servers (HTTP/SSE)

```yaml
mcpServers:
  api-server:
    type: http               # Required: 'http' or 'sse'
    url: string              # Required - supports http://, https://, unix://, pipe://
    headers: Record<string, string>  # Optional - for authentication
    disabled: boolean        # Optional
    description: string      # Optional
```

## Variable Substitution

| Variable | Description |
|----------|-------------|
| `${bundlePath}` | Absolute path to bundle directory |
| `${bundleId}` | Bundle identifier |
| `${bundleVersion}` | Bundle version |
| `${env:VAR_NAME}` | Environment variable |
| `${input:id}` | VS Code input prompt (defined in `mcp.inputs`) |

## Input Definitions

Collections can define `mcp.inputs` to declare secrets or configurable values that VS Code will prompt the user for. These follow the [VS Code `mcp.json` inputs spec](https://code.visualstudio.com/docs/copilot/chat/mcp-servers).

### Schema

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier, referenced as `${input:id}` in server config |
| `type` | `promptString` \| `pickString` \| `command` | Input type |
| `description` | string | Label shown to the user |
| `password` | boolean | Mask the value (for secrets) |
| `default` | string | Pre-filled default value |
| `options` | string[] | Choices for `pickString` type |

### Example

```yaml
mcp:
  inputs:
    - id: serviceToken
      type: promptString
      description: "Service access token (not stored)"
      password: true
    - id: serviceUser
      type: promptString
      description: "Service username"
    - id: servicePassword
      type: promptString
      description: "Service password or app password"
      password: true
  items:
    server-a:
      type: stdio
      command: podman
      args:
        - run
        - -e
        - "TOKEN=${input:serviceToken}"
        - my-mcp-server-a:latest
    server-b:
      type: stdio
      command: podman
      args:
        - run
        - -e
        - "USERNAME=${input:serviceUser}"
        - -e
        - "PASSWORD=${input:servicePassword}"
        - my-mcp-server-b:latest
```

### Merge Behaviour

When a collection is installed, its `mcp.inputs` are **merged** into the existing `mcp.json`:
- Inputs are deduplicated by `id` — the **existing** definition takes priority over incoming ones
- This allows multiple collections to share the same input without conflict
- Inputs are added to the top-level `inputs` array of `mcp.json`

## Deployment Manifest Format

When a collection is published as a GitHub release, `lib/bin/generate-manifest.js` converts the `.collection.yml` MCP section into the deployment manifest. The generated format uses a top-level `mcp` key that mirrors the collection schema:

```yaml
mcp:
  inputs:
    - id: serviceToken
      type: promptString
      description: "Service access token (not stored)"
      password: true
  items:
    server-a:
      type: stdio
      command: podman
      args:
        - run
        - -e
        - "TOKEN=${input:serviceToken}"
        - my-mcp-server-a:latest
```

> **Legacy format:** Older manifests may use a top-level `mcpServers` key (without `mcp.inputs`). The GitHub adapter accepts both formats — it reads `mcp.items` first, falling back to `mcpServers`, and reads `mcp.inputs` when present.

## Example

```yaml
mcpServers:
  custom-server:
    command: node
    args:
      - "${bundlePath}/servers/custom.js"
    env:
      BUNDLE_ID: "${bundleId}"
      API_KEY: "${env:MY_API_KEY}"
    description: Custom operations
```

## Uninstallation

1. Read tracking metadata for bundle's servers
2. Remove servers from `mcp.json`
3. Remove **orphaned inputs** — any `${input:id}` no longer referenced by any remaining server is removed from the `inputs` array
4. Update tracking metadata
5. Atomic operations with backup/rollback

> **Shared inputs are preserved**: if another installed bundle's server still references an input, it is kept.

## Duplicate Detection Algorithm

When multiple bundles define the same MCP server, duplicates are automatically detected and disabled.

### Server Identity Computation

```typescript
computeServerIdentity(config: McpServerConfig): string {
    if (isRemoteServerConfig(config)) {
        return `remote:${config.url}`;
    } else {
        const argsStr = config.args?.join('|') || '';
        return `stdio:${config.command}:${argsStr}`;
    }
}
```

| Server Type | Identity Format | Example |
|-------------|-----------------|----------|
| Stdio | `stdio:{command}:{args joined by \|}` | `stdio:node:server.js\|--port\|3000` |
| Remote | `remote:{url}` | `remote:https://api.example.com/mcp` |

### Detection Flow

```mermaid
graph TD
    A["After server installation"]
    B["detectAndDisableDuplicates()"]
    C["For each server in mcp.json"]
    D{"Identity already seen?"}
    E["Record identity → server mapping"]
    F["Mark as disabled\nAdd description: 'Duplicate of X'"]
    G["Write updated config"]
    
    A --> B
    B --> C
    C --> D
    D -->|No| E
    D -->|Yes & enabled| F
    E --> C
    F --> C
    C -->|Done| G
```

### Lifecycle Behavior

1. **Install**: First server with identity stays enabled; duplicates disabled
2. **Uninstall**: When active server's bundle is removed, remaining duplicates are re-evaluated
3. **Invariant**: At least one server per identity remains active until all bundles are removed

### Type Guards

```typescript
// Discriminate server types
isStdioServerConfig(config)  // true if has 'command', no 'url'
isRemoteServerConfig(config) // true if has 'url' and type is 'http'|'sse'
```

## See Also

- [Installation Flow](./installation-flow.md) — Bundle installation
- [Author Guide: Collection Schema](../../author-guide/collection-schema.md) — MCP in manifests
