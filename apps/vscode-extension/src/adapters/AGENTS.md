# Adapter Implementation Guide

## Purpose

Adapters provide a unified interface for prompt bundle sources (GitHub, Local, Awesome Copilot, APM, Skills, and their local variants).

## 🚨 Status: `RegistryManager` now runs on `@ai-primitives-hub/infra`'s adapters 🚨

The adapter-unification cutover (migration plan §7.5, Phase 4 item 3, decision #10) is **complete**. `RegistryManager` no longer builds adapters from this directory - it calls `createRegistryAdapter` (`infra-adapter-factory.ts`), which delegates to `@ai-primitives-hub/app`'s `createSourceAdapter` (`packages/app/src/registry/create-source-adapter.ts`), which builds the eight concrete adapters living in `packages/infra/src/adapters/*`.

The eight files below, `repository-adapter.ts`'s `RepositoryAdapterFactory`, and their `test/adapters/*.test.ts` counterparts **still exist and still pass their own tests**, but are **no longer reachable from `RegistryManager`** (or anywhere else in `src/`) - they are dead code kept only until a deliberate follow-up removal. **Do not add new functionality here or "fix" a bug by editing one of these files** - the live implementation is in `packages/infra/src/adapters/*`, and this directory's copy has already drifted (it does not have `packages/infra`'s `clearCache`/`clearManifestCache` cache-busting methods, for one).

## Adding a New Adapter (do this in `packages/infra`, not here)

1. Copy an existing adapter in `packages/infra/src/adapters/` (e.g. `github-adapter.ts`)
2. Implement `SourceAdapter` (`@ai-primitives-hub/core`'s port - see that package's `src/ports/source-adapter.ts`)
3. Wire it into `createSourceAdapter`'s switch statement (`packages/app/src/registry/create-source-adapter.ts`), adding the new `SourceType` literal to `@ai-primitives-hub/core` first if needed
4. Add a matching case to `test/registry/create-source-adapter.test.ts` (app) and, if the extension needs a distinct auth policy for it (see below), to `test/adapters/infra-adapter-factory.test.ts` (extension)

## Interface

`SourceAdapter` (`@ai-primitives-hub/core`'s port, aliased as `IRepositoryAdapter` in `src/adapters/repository-adapter.ts` for this extension's own pre-cutover call sites - the two are structurally identical):

```typescript
interface SourceAdapter {
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

Resolved in order, via a single `CompositeTokenProvider` built per source by `createSourceAdapter`:
1. Explicit `token` on `RegistrySource` (`StaticTokenProvider`)
2. This extension's `VsCodeSessionTokenProvider` (`vscode.authentication.getSession('github', ...)`, wired in as the first `fallbackTokenProviders` entry by `infra-adapter-factory.ts`)
3. GitHub CLI (`gh auth token`, `@ai-primitives-hub/infra`'s `GhCliTokenProvider`, the second `fallbackTokenProviders` entry)
4. No auth (public repos only)

`infra-adapter-factory.ts` builds the fallback chain per source in `buildDeps`, with the VS Code session step's `createIfNone` policy set to `true` (prompts the user to sign in) for every type except `skills`, which gets `false` - matching that one source type's pre-cutover exception.

### Auth observability

- Every chain carries a `createAuthEventLogger(source.id)` handler (`auth-event-logger.ts`): one INFO line naming the winning `TokenOrigin`, per-step detail at DEBUG.
- `buildDeps` is per-source because that handler needs the source id to label its lines.
- Pass the handler to the providers *and* the `CompositeTokenProvider` - they emit different events; `deps.onAuthEvent` covers the `StaticTokenProvider` built from `source.token`.
- Never put token material in an event; use `describeTokenType` for the type prefix.
- Three other chains need the same treatment when touched: `hub-manager.ts` and two in `registry-manager.ts`.
- Full contract: [authentication](../../../../docs/contributor-guide/architecture/authentication.md).

## Existing Adapters (live implementation: `packages/infra/src/adapters/`)

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

- [ ] Implements `SourceAdapter` (`@ai-primitives-hub/core`)
- [ ] Implements all required `SourceAdapter` methods
- [ ] Returns `Buffer` from `downloadBundle`
- [ ] Returns `ValidationResult` from `validate` with actionable error messages
- [ ] Auth (if GitHub-hosted) goes through the injected `TokenProvider`, not a hand-rolled chain
- [ ] Wired into `createSourceAdapter`'s switch statement (`packages/app/src/registry/create-source-adapter.ts`)
- [ ] Has a matching unit test file in `packages/infra/test/adapters/`
