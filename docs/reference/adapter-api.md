# SourceAdapter API Reference

AI Primitives Hub normalizes collection sources through the `SourceAdapter`
port in `packages/core/src/ports/source-adapter.ts`. Concrete implementations
live in `packages/infra/src/adapters/` and are constructed by
`packages/app/src/registry/create-source-adapter.ts`.

The repository does not currently expose runtime registration of arbitrary
third-party adapter classes. Supporting another source type requires a code
change to the shared packages.

## Interface

```typescript
interface SourceAdapter {
  readonly type: string;
  readonly source: RegistrySource;

  fetchBundles(): Promise<Bundle[]>;
  downloadBundle(bundle: Bundle): Promise<Buffer>;
  fetchMetadata(): Promise<SourceMetadata>;
  validate(): Promise<ValidationResult>;
  requiresAuthentication(): boolean;
  getManifestUrl(bundleId: string, version?: string): string;
  getDownloadUrl(bundleId: string, version?: string): string;
  downloadReadme(bundle: Bundle): Promise<string | null>;
  forceAuthentication?(): Promise<void>;
}
```

## Method Semantics

| Member | Current contract |
|---|---|
| `type` | Source-type identifier handled by the adapter |
| `source` | Normalized source configuration used to construct the adapter |
| `fetchBundles` | Return normalized bundle metadata available from the source |
| `downloadBundle` | Return the installable archive as a `Buffer` |
| `fetchMetadata` | Return source-level display and diagnostic metadata |
| `validate` | Return user-facing source validation details |
| `requiresAuthentication` | Indicate whether the configured source normally requires credentials |
| `getManifestUrl` | Return a URL/path for display or diagnostics |
| `getDownloadUrl` | Return a URL/path for display or diagnostics |
| `downloadReadme` | Return bundle README text, or `null` when unavailable |
| `forceAuthentication` | Optionally trigger delivery-supported reauthentication |

`downloadBundle` is the installation boundary for every adapter. Even when a
remote source exposes a ready-made ZIP URL, the adapter downloads it and
returns a buffer. The URL methods do not create a separate URL-based install
pipeline.

## Built-in Implementations

| Source type | Implementation |
|---|---|
| `github` | `GitHubAdapter` |
| `local` | `LocalAdapter` |
| `awesome-copilot` | `AwesomeCopilotAdapter` |
| `local-awesome-copilot` | `LocalAwesomeCopilotAdapter` |
| `apm` | `ApmAdapter` |
| `local-apm` | `LocalApmAdapter` |
| `skills` | `SkillsAdapter` |
| `local-skills` | `LocalSkillsAdapter` |
| `azure-devops` | `AzureDevOpsAdapter` |

The registry source union is broader than the Hub configuration schema. See
[Hub Schema](./hub-schema.md) before using a source type in
`hub-config.yml`.

## Factory Dependencies

`createSourceAdapter` requires delivery-provided implementations of:

```typescript
interface SourceAdapterFactoryDeps {
  fs: FileSystem;
  clock: Clock;
  httpClient: HttpClient;
  processRunner: ProcessRunner;
  fallbackTokenProviders: readonly TokenProvider[];
}
```

This keeps VS Code and Node/CLI details outside the domain and infrastructure
implementations.

For sources with credentials, an explicit `source.token` is placed before
the delivery fallbacks in a `CompositeTokenProvider`. GitHub-hosted adapters
receive a `GitHubApiClient`; Azure DevOps receives an
`AzureDevOpsApiClient`.

## Adding an Adapter in This Repository

1. Extend the source type and configuration in `packages/core`.
2. Implement `SourceAdapter` in `packages/infra/src/adapters/`.
3. Export it from the infra adapter index.
4. Add the construction case to `createSourceAdapter` in `packages/app`.
5. Add tests for the adapter and factory case.
6. Update source configuration documentation.
7. Update the Hub schema separately if Hubs should accept the new type.

## Creating a Custom Adapter

### Step 1: Implement the Interface

```typescript
import { IRepositoryAdapter, Bundle, SourceMetadata, ValidationResult } from '../types';

export class MyCustomAdapter implements IRepositoryAdapter {
    constructor(private config: MyAdapterConfig) {}
    
    async fetchBundles(): Promise<Bundle[]> {
        // Fetch bundle list from your source
        const response = await fetch(this.config.apiUrl);
        const data = await response.json();
        
        return data.bundles.map(item => ({
            id: item.id,
            name: item.name,
            version: item.version,
            description: item.description,
            // ... other bundle properties
        }));
    }
    
    async downloadBundle(bundle: Bundle): Promise<Buffer> {
        // For buffer-based adapters
        const response = await fetch(`${this.config.apiUrl}/download/${bundle.id}`);
        return Buffer.from(await response.arrayBuffer());
    }
    
    async fetchMetadata(): Promise<SourceMetadata> {
        return {
            name: this.config.name,
            type: 'my-custom',
            url: this.config.apiUrl,
        };
    }
    
    async validate(): Promise<ValidationResult> {
        try {
            await fetch(this.config.apiUrl);
            return { valid: true };
        } catch (error) {
            return { valid: false, error: error.message };
        }
    }
    
    getManifestUrl(bundleId: string, version: string): string {
        return `${this.config.apiUrl}/manifests/${bundleId}/${version}`;
    }
    
    getDownloadUrl(bundleId: string, version: string): string {
        return `${this.config.apiUrl}/download/${bundleId}/${version}`;
    }
}
```

### Step 2: Register the Adapter

Register your adapter with the `RepositoryAdapterFactory`:

```typescript
import { RepositoryAdapterFactory } from '../adapters/RepositoryAdapterFactory';
import { MyCustomAdapter } from './MyCustomAdapter';

// Register the adapter type
RepositoryAdapterFactory.register('my-custom', MyCustomAdapter);
```

### Step 3: Update Source Types

Add your adapter type to the `SourceType` union in `src/types/registry.ts`:

```typescript
export type SourceType = 
    | 'github' 
    | 'local' 
    | 'awesome-copilot'
    | 'local-awesome-copilot'
    | 'apm'
    | 'local-apm'
    | 'azure-devops'
    | 'my-custom';
```

## Built-in Adapters

| Adapter | Source Type | Description | Status |
|---------|-------------|-------------|--------|
| `GitHubAdapter` | `github` | Fetches releases and assets from GitHub repositories | Active |
| `LocalAdapter` | `local` | Installs from local file system directories | Active |
| `AwesomeCopilotAdapter` | `awesome-copilot` | Fetches YAML collections from GitHub, builds zips on-the-fly | Active |
| `LocalAwesomeCopilotAdapter` | `local-awesome-copilot` | Local YAML collections for development | Active |
| `ApmAdapter` | `apm` | APM package repositories | Active |
| `LocalApmAdapter` | `local-apm` | Local APM packages | Active |
| `SkillsAdapter` | `skills` | Fetches skills from a GitHub repository's `skills/` directory | Active |
| `LocalSkillsAdapter` | `local-skills` | Local filesystem skills directory | Active |
| `AzureDevOpsAdapter` | `azure-devops` | Fetches `.collection.yml` bundles from an Azure DevOps Git repo via PAT auth | Active |

## Authentication

Adapters that access private repositories should implement authentication. The GitHub and AwesomeCopilot adapters use a three-tier authentication chain:

### VS Code Extension

1. **VS Code GitHub Authentication** — Uses the built-in VS Code GitHub auth
2. **GitHub CLI** — Falls back to `gh auth token` if available
3. **Explicit Token** — Uses a configured token from source config

### CLI

1. **Environment variable** — `GITHUB_TOKEN` or `GH_TOKEN`
2. **GitHub CLI** — Falls back to `gh auth token`
3. **Explicit Token** — Passed via `--token` flag or `ai-primitives-hub.yml`

```typescript
private async getAuthenticationToken(): Promise<string | undefined> {
    // 1. Try VSCode GitHub authentication
    const session = await vscode.authentication.getSession('github', ['repo'], { silent: true });
    if (session) return session.accessToken;
    
    // 2. Try GitHub CLI
    const { stdout } = await execAsync('gh auth token');
    if (stdout.trim()) return stdout.trim();
    
    // 3. Try explicit token from source config
    const explicitToken = this.getAuthToken();
    if (explicitToken) return explicitToken;
    
    return undefined;
}
```

Use Bearer token format for authenticated requests:

```typescript
headers['Authorization'] = `Bearer ${token}`;
```

## Bundle Manifest Format

Bundles must include a `deployment-manifest.yml` file:

```yaml
version: "1.0"
id: "my-bundle"
name: "My Custom Bundle"
prompts:
  - id: "my-prompt"
    name: "My Prompt"
    type: "prompt"
    file: "prompts/my-prompt.prompt.md"
    tags: ["custom", "example"]
# Optional: MCP servers with user-configurable inputs
mcpInputs:
    - id: myToken
        type: promptString
        description: "API token"
        password: true
mcpServers:
    my-server:
        type: stdio
        command: node
        args:
            - "${bundlePath}/server.js"
            - "--token"
            - "${input:myToken}"
```

The nested `mcp.items` and `mcp.inputs` shape is used in source collection files and is converted to these top-level deployment-manifest fields during bundle generation. Older deployment manifests may contain `mcpServers` without `mcpInputs`.

## Error Handling

Adapters should handle errors gracefully and return meaningful error messages:

```typescript
async fetchBundles(): Promise<Bundle[]> {
    try {
        const response = await fetch(this.config.apiUrl);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return await response.json();
    } catch (error) {
        Logger.getInstance().error(`[MyAdapter] Failed to fetch bundles: ${error.message}`);
        throw error;
    }
}
```

## Target Writers

The `TargetWriter` port (`packages/core/src/ports/target-writer.ts`) writes extracted bundle files into an install target's filesystem layout. The built-in implementation is `FileTreeTargetWriter` (`packages/app/src/writers/file-tree-writer.ts`).

```typescript
interface TargetWriter {
    write(files: BundleFile[], target: Target): Promise<TargetWriteResult[]>;
}
```

Each target type has a layout defined in `packages/infra/src/writers/default-layouts.json` that maps primitive kinds to directories:

| Target | Prompts → | Instructions → | Agents → | Skills → | MCP Config |
|--------|----------|----------------|----------|----------|------------|
| `vscode` | `prompts/` | `instructions/` | `agents/` | `skills/` | `mcp.json` (key: `servers`) |
| `kiro` (Kiro IDE / Kiro CLI) | `steering/` | `steering/` | `agents/` | `skills/` | `settings/mcp.json` (key: `mcpServers`) |
| `windsurf` | `rules/` | `rules/` | `agents/` | `skills/` | `mcp_config.json` (key: `mcpServers`) |
| `claude-code` | `commands/` | `instructions/` | `agents/` | `skills/` | `.claude.json` (key: `mcpServers`) |
| `copilot-cli` | `prompts/` | `instructions/` | `agents/` | `skills/` | `mcp-config.json` (key: `mcpServers`) |

## Resource Transformers

The `ResourceTransformer` port (`packages/core/src/ports/resource-transformer.ts`) adapts file content per target — for example, ensuring mandatory frontmatter fields for Kiro, adjusting formatting for Windsurf, etc.

```typescript
interface ResourceTransformer {
    transform(file: BundleFile, context: TransformContext): TransformResult;
}
```

Built-in transformers (registered in `TransformerRegistry`):

| Transformer | Target | What It Does |
|-------------|--------|-------------|
| `KiroTransformer` | `kiro` | Ensures agent files have `name` field in frontmatter (per [Kiro subagents spec](https://kiro.dev/docs/chat/subagents/)) |
| `WindsurfTransformer` | `windsurf` (Devin) | Adds `trigger` field to rules frontmatter (`always_on`, `model_decision`, `glob`, `manual`); maps `applyTo` glob to `trigger: glob` + `globs` (per [Windsurf rules spec](https://docs.windsurf.com/windsurf/cascade/memories#rules)) |
| `ClaudeCodeTransformer` | `claude-code` | Ensures agent files have both `name` and `description` in frontmatter (per [Claude Code subagents spec](https://code.claude.com/docs/en/sub-agents)) |
| `NoOpTransformer` | `vscode`, `vscode-insiders`, `copilot-cli` | Pass-through — no content modifications |

## See Also

- [Source Adapter Architecture](../contributor-guide/architecture/adapters.md)
- [Authentication](../contributor-guide/architecture/authentication.md)
- [Development Setup](../contributor-guide/development-setup.md)
- [Testing](../contributor-guide/testing.md)
