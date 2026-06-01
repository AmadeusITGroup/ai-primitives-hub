# Adapter Implementation Guide

## Purpose

Adapters provide a unified interface for prompt bundle sources (GitHub, Local, Awesome Copilot, APM, Skills, and their local variants).

## Adding a New Adapter

1. Copy an existing adapter (e.g., `github-adapter.ts`)
2. Extend `RepositoryAdapter` (see `repository-adapter.ts`)
3. Accept optional `client?: GitHubClient` in constructor for testability
4. Delegate all GitHub API calls to `GitHubClient` (from `src/services/github-client.ts`)
5. Use shared helpers from `helpers/` for parsing/mapping logic
6. Register in `RegistryManager` via `RepositoryAdapterFactory.register('type', AdapterClass)`

## Interface

`IRepositoryAdapter` (defined in `src/adapters/repository-adapter.ts`):

```typescript
interface IRepositoryAdapter {
  readonly type: string;
  readonly source: RegistrySource;

  fetchBundles(): Promise<Bundle[]>;
  downloadBundle(bundle: Bundle): Promise<Buffer>;
  fetchMetadata(): Promise<SourceMetadata>;
  validate(): Promise<ValidationResult>;
  requiresAuthentication(): boolean;
  getManifestUrl(bundleId: string, version?: string): string;
  getDownloadUrl(bundleId: string, version?: string): string;
  forceAuthentication?(): Promise<void>;   // optional
}
```

- `downloadBundle` always returns a `Buffer` — whether the source provides pre-packaged ZIPs (GitHub) or builds them dynamically (Awesome Copilot, Local).
- `getDownloadUrl` / `getManifestUrl` return `string` URLs — used for UI display and debug links, not for the actual download (which goes through `downloadBundle`).
- `validate` returns a `ValidationResult` (not a boolean) — contains error details for user-facing diagnostics.

## GitHubClient (`src/services/github-client.ts`)

All GitHub-based adapters delegate HTTP to `GitHubClient`. Key API:

| Method | Returns | Purpose |
|--------|---------|---------|
| `getContents(path, ref?)` | `GitHubContentItem[]` | List directory contents |
| `getFileContent(path, ref?)` | `Buffer` | Download file content |
| `listReleases()` | `GitHubRelease[]` | List repository releases |
| `getTree(sha, recursive?)` | `TreeEntry[]` | Get git tree (single API call) |
| `downloadAsset(url)` | `Buffer` | Download release asset |
| `getRepository()` | `RepoMetadata` | Get repo name/description |

Authentication chain (handled internally by GitHubClient):
1. VS Code GitHub authentication session (`vscode.authentication.getSession`)
2. Explicit `token` from `RegistrySource`
3. GitHub CLI (`gh auth token`)
4. No auth (public repos only)

## Shared Helpers (`helpers/`)

| File | Functions | Used By |
|------|-----------|---------|
| `release-mapper.ts` | `mapReleaseToBundle`, `hasValidBundleAssets`, `extractDescription/Envs/Tags` | GitHubAdapter |
| `skill-parser.ts` | `parseSkillMd`, `calculateContentHash`, `formatSkillVersion`, `mapSkillToBundle` | SkillsAdapter, LocalSkillsAdapter |
| `collection-parser.ts` | `parseCollectionYaml`, `mapCollectionToBundle`, `calculateBreakdown`, `inferEnvironments` | AwesomeCopilotAdapter, LocalAwesomeCopilotAdapter |

## Existing Adapters

| File | Type |
|------|------|
| `github-adapter.ts` | Remote GitHub repo releases |
| `awesome-copilot-adapter.ts` | Awesome Copilot repo (dynamic bundle assembly) |
| `apm-adapter.ts` | Remote APM registry |
| `skills-adapter.ts` | Remote Skills source |
| `local-adapter.ts` | Local filesystem bundles |
| `local-apm-adapter.ts` | Local APM registry |
| `local-awesome-copilot-adapter.ts` | Local Awesome Copilot clone |
| `local-skills-adapter.ts` | Local Skills source |

## Checklist

- [ ] Extends `RepositoryAdapter`
- [ ] Implements all required `IRepositoryAdapter` methods
- [ ] Constructor accepts optional `client?: GitHubClient` for testability
- [ ] All GitHub API calls go through `GitHubClient` (no raw `node:https`)
- [ ] Uses shared helpers from `helpers/` where applicable
- [ ] Returns `Buffer` from `downloadBundle`
- [ ] Returns `ValidationResult` from `validate` with actionable error messages
- [ ] Registered in `RepositoryAdapterFactory`
- [ ] Tests mock `GitHubClient` (no nock/HTTP mocking needed)
- [ ] Has corresponding test file in `test/adapters/`
