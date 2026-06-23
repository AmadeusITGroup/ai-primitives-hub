# Adapter API Reference

This document describes how to create custom adapters for the AI Primitives Hub extension.

## Overview

Adapters provide a unified interface for fetching bundles from different sources. The AI Primitives Hub uses the adapter pattern to support multiple source types (GitHub, local files, and curated collections).

## IRepositoryAdapter Interface

All adapters must implement the `IRepositoryAdapter` interface:

```typescript
interface IRepositoryAdapter {
    // The type of repository this adapter handles
    readonly type: string;
    
    // The source configuration
    readonly source: RegistrySource;
    
    // Fetch all bundles from this source
    fetchBundles(): Promise<Bundle[]>;
    
    // Download a specific bundle (returns zip Buffer)
    downloadBundle(bundle: Bundle): Promise<Buffer>;
    
    // Get metadata about the source
    fetchMetadata(): Promise<SourceMetadata>;
    
    // Validate source configuration
    validate(): Promise<ValidationResult>;
    
    // Check if source requires authentication
    requiresAuthentication(): boolean;
    
    // Get URLs for bundles
    getManifestUrl(bundleId: string, version?: string): string;
    getDownloadUrl(bundleId: string, version?: string): string;
    
    // Force re-authentication (optional)
    forceAuthentication?(): Promise<void>;
}
```

## Installation Paths

Adapters can use one of two installation paths:

### URL-Based Installation

For pre-packaged zip bundles on remote servers. The adapter returns a download URL, and `BundleInstaller.install()` handles the download.

**Used by:** GitHub, AwesomeCopilot adapters

```typescript
// Adapter returns URL string
getDownloadUrl(bundleId: string, version: string): string {
    return `https://example.com/bundles/${bundleId}/${version}.zip`;
}
```

### Buffer-Based Installation

For dynamically created bundles. The adapter builds the zip in memory and returns a Buffer. `BundleInstaller.installFromBuffer()` handles extraction.

**Used by:** AwesomeCopilot, Local adapters

```typescript
// Adapter returns Buffer
async downloadBundle(bundle: Bundle): Promise<Buffer> {
    const archive = archiver('zip');
    // ... build zip contents
    return archive.finalize();
}
```

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

## Authentication

Adapters that access private repositories should implement authentication. The GitHub and AwesomeCopilot adapters use a three-tier authentication chain:

1. **VS Code GitHub Authentication** — Uses the built-in VS Code GitHub auth
2. **GitHub CLI** — Falls back to `gh auth token` if available
3. **Explicit Token** — Uses a configured token from source config

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
```

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

## See Also

- [Architecture](../contributor-guide/architecture.md) — System architecture overview
- [Development Setup](../contributor-guide/development-setup.md) — Setting up the development environment
- [Testing](../contributor-guide/testing.md) — Testing strategies and patterns
