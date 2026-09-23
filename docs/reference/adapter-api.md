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

Do not register the adapter in an extension-only factory. Both delivery
layers use the shared application factory.

## See Also

- [Source Adapter Architecture](../contributor-guide/architecture/adapters.md)
- [Authentication](../contributor-guide/architecture/authentication.md)
- [Development Setup](../contributor-guide/development-setup.md)
- [Testing](../contributor-guide/testing.md)
