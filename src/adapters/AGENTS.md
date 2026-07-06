# Adapter Implementation Guide

## Purpose

Adapters provide a unified interface for prompt bundle sources (GitHub, Local, Awesome Copilot, APM, Skills, and their local variants).

## Adapter Class Hierarchy

```
RepositoryAdapter (abstract, repository-adapter.ts)
  └─ GitHubBackedAdapter (abstract, github-backed-adapter.ts)   ← shared GitHub logic
       ├─ GitHubAdapter            (github-adapter.ts)
       ├─ AwesomeCopilotAdapter    (awesome-copilot-adapter.ts)
       └─ SkillsAdapter            (skills-adapter.ts)
```

`GitHubBackedAdapter` hoists everything the three GitHub-backed adapters share, so they no
longer re-implement it:

- **URL parsing / validation** — `parseGitHubUrl()`, `isValidGitHubUrl()` (validated in the constructor)
- **URL builders** — `apiBase`, `buildContentsUrl(owner, repo, path, ref?)`, `buildRawUrl(owner, repo, branch, path)`
- **Auth chain** — `getAuthenticationToken()` (explicit token → VS Code session → gh CLI), with
  memoization, retry accounting, and `invalidateAuthCache()`
- **HTTP transport** — `httpGet()` (redirects, sanitized header logging) plus the `getJson<T>()` /
  `getText()` / `getBuffer()` wrappers; `getJson` invalidates auth and retries once on 401/403
- **Progressive fetch** — `processInChunks(items, chunkSize, processItem, onPartial?)` runs each chunk
  with `Promise.allSettled` (one failure drops only that item) and streams a growing snapshot to
  `onPartial` after each chunk — this is what drives incremental marketplace refresh during large syncs
- **Validation** — `validateGitHubRepository()` and a default `validate()` (subclasses override for
  collection/skill-specific structure)

Local adapters (`local-*`) are filesystem-backed and extend `RepositoryAdapter` directly, not this class.

## Adding a New Adapter

1. Copy the closest existing adapter (`github-adapter.ts` for GitHub-backed, `local-adapter.ts` otherwise)
2. Extend `GitHubBackedAdapter` for GitHub sources (inherits auth/HTTP/URL/chunking) or
   `RepositoryAdapter` for non-GitHub sources (implement auth/HTTP yourself)
3. Route `fetchBundles(onPartialBundles?)` through `processInChunks` so the UI renders progressively
4. Register in `RegistryManager` via `RepositoryAdapterFactory.register('type', AdapterClass)`

## Interface

`IRepositoryAdapter` (defined in `src/adapters/repository-adapter.ts`):

```typescript
interface IRepositoryAdapter {
  readonly type: string;
  readonly source: RegistrySource;

  fetchBundles(onPartialBundles?: (bundles: Bundle[]) => void | Promise<void>): Promise<Bundle[]>;
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
- `fetchBundles` accepts an optional `onPartialBundles` callback — invoked with a growing snapshot after each parse chunk so the UI can render progressively during large syncs. Implementing it is optional; adapters that omit it simply resolve once with the full list. `SkillsAdapter` uses it to stream 360+ skills as they parse.

## Authentication Chain (GitHub)

Resolved in order:
1. Explicit `token` on `RegistrySource`
2. VS Code GitHub authentication session (`vscode.authentication.getSession('github', ...)`)
3. GitHub CLI (`gh auth token`)
4. No auth (public repos only)

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

- [ ] Extends `GitHubBackedAdapter` (GitHub sources) or `RepositoryAdapter` (non-GitHub sources)
- [ ] Implements all required `IRepositoryAdapter` methods
- [ ] `fetchBundles` streams partial results via `processInChunks` (GitHub-backed adapters)
- [ ] Returns `Buffer` from `downloadBundle`
- [ ] Returns `ValidationResult` from `validate` with actionable error messages
- [ ] Handles authentication via inherited helpers where possible
- [ ] Registered in `RepositoryAdapterFactory`
- [ ] Has corresponding test file in `test/adapters/`
