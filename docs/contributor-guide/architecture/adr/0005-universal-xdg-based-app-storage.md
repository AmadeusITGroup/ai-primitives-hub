# ADR-0005: Universal, XDG-Based Application Storage Port

**Status:** Accepted

## Context

`src/storage/registry-storage.ts` (`RegistryStorage`) and several other
extension services (`BundleInstaller`'s bundle download/staging cache,
`UserScopeService`'s bundle-manifest lookup for unsync, `PromptLoader`,
`ApmRuntimeManager`) resolve their on-disk root directly from
`vscode.ExtensionContext.globalStorageUri.fsPath`. `RegistryStorage`'s
constructor takes the **full** `vscode.ExtensionContext` and internally uses
*two* VS Code-specific substrates: `context.globalStorageUri.fsPath` for the
registry config file (sources, profiles, settings), source/bundle caches, and
installed-bundle records for `user`/`workspace` scope; and
`context.globalState` for small key/value data (bundle update preferences).
`RegistryManager` (constructs `RegistryStorage` directly), `BundleInstaller`
(ditto), and `UpdateChecker`/`AutoUpdateService` (take a `RegistryStorage`
instance via constructor injection) — all still pending strangler-fig
extraction (migration plan §7.5, Phase 4 item 2) — depend on this concrete,
`vscode`-coupled class.

**Verified not affected, despite an initial assumption otherwise:**
`HubManager` depends on `HubStorage` (`src/storage/hub-storage.ts`), a
*separate* class from `RegistryStorage`. `HubStorage`'s constructor already
takes a plain `storagePath: string` — it has zero `vscode` import at all; the
extension's composition root (`extension.ts`, `commands/hub-profile-commands.ts`)
is the only place that happens to pass `context.globalStorageUri.fsPath` in.
This is already exactly the target pattern (plain-string injection, same as
`app/install/*`'s `Target.rootPath`) — confirmed by direct inspection while
starting `HubManager`'s own strangler-fig slice, no port work needed there.

`packages/infra` already independently established the right pattern for
CLI-side state, twice, coincidentally without being unified into one port:
`harvest/default-paths.ts`'s `defaultCacheDir()` (respects `XDG_CACHE_HOME`
and an `AI_PRIMITIVES_HUB_CACHE` override, falls back to
`~/.cache/ai-primitives-hub`) and `stores/layout-config-store.ts`'s
`resolveUserConfigDir()` (respects `XDG_CONFIG_HOME`, falls back to
`~/.config/ai-primitives-hub`). Both are pure, env-injectable, and have no
`vscode` dependency — exactly the target shape.

`packages/app/src/install/*` (`InstallPipeline`/`installBundle`) is already
fully agnostic: it takes an explicit `Target` (with `rootPath`) and injected
port implementations, never resolving a storage root itself. That module is
proof the pattern already works end-to-end for the install/write path; the
gap is specifically the registry/bookkeeping storage layer used by the
services Phase 4 has not yet migrated.

The `packages/cli` package has, and must keep, zero dependency on the
`vscode` module. Without an explicit decision here, the path of least
resistance when extracting `RegistryManager`/`UpdateChecker`/`AutoUpdateService`
into `app` would be to port their *logic* but leave them taking a concrete,
`vscode`-coupled storage object — silently recreating the "two parallel
domains" problem ADR-0001 exists to fix, one layer deeper (storage instead
of business logic).

## Decision

1. Add a `core` port, `AppStorage` (`packages/core/src/ports/app-storage.ts`),
   modeling the directory/file responsibilities `RegistryStorage` already
   defines (config, cache, installed-bundle records per scope, profiles,
   logs) as an interface — no `vscode`, no direct `fs` calls, matching this
   repo's existing port style (`ports/filesystem.ts`, `ports/target-writer.ts`).
2. `infra` provides the default, universal implementation — an XDG Base
   Directory-compliant `AppStorage` (`XDG_DATA_HOME`/`XDG_CONFIG_HOME`/
   `XDG_CACHE_HOME`, each falling back to `~/.local/share`, `~/.config`,
   `~/.cache` + `ai-primitives-hub` per POSIX convention). This consolidates
   the two existing ad hoc XDG resolvers under one coherent, tested module
   instead of leaving three independent XDG implementations in the codebase
   long-term. This is what the CLI uses by default, and what any future
   non-VS-Code client uses too.
3. The VS Code extension keeps its **own** adapter backed by
   `context.globalStorageUri.fsPath` (either a thin wrapper or
   `RegistryStorage` itself refactored to implement the port). This is a
   deliberate, permanent choice, not a temporary shim: real users' data
   already lives under `globalStorageUri`, and relocating it would be a
   silent, undiscoverable migration for existing installs. This mirrors the
   precedent ADR-0004 already set — don't relocate/rename identifiers real
   users' data already depends on.
4. When `UpdateChecker`/`AutoUpdateService` and `RegistryManager` are
   extracted (migration plan §7.5, Phase 4 item 2, remaining sub-items),
   their `app`-layer use-cases depend on the `AppStorage` **port**, not on
   `RegistryStorage`/`vscode.ExtensionContext` directly — the same pattern
   `install-bundle.ts` already uses for
   `BundleDownloader`/`BundleExtractor`/`TargetWriter`. In practice this
   means `RegistryStorage` itself is refactored to depend on the injected
   port for its own path/state resolution, while remaining the single
   facade `UpdateChecker`/`AutoUpdateService`/`RegistryManager` depend on —
   so those three need no constructor/signature changes of their own.
5. `LockfileManager` and `HubManager`/`HubStorage` are explicitly **out of
   scope** for this decision: `LockfileManager`'s storage
   (`<repo-root>/prompt-registry.lock.json`) is already workspace-relative
   and portable (constructor takes a plain `repositoryPath: string`), and
   `HubStorage`'s constructor already takes a plain `storagePath: string`
   with zero `vscode` dependency (see Context above). Likewise `app/install/*`
   is already agnostic via `Target.rootPath` + injected ports. All three were
   verified by direct inspection while investigating this decision and need
   no change.

## Consequences

- **Positive:** the CLI can implement `hub`/`profile`/`source`/`status`
  commands (Phase 5, §7.6 item 3) against the exact same `app`-layer
  orchestration the extension uses, with zero `vscode` dependency — extending
  ADR-0001's "one shared domain" proof from business logic to persisted
  state.
- **Positive:** consolidates two ad hoc XDG resolvers into one coherent,
  fully-tested storage port, and closes a latent inconsistency
  (`XDG_DATA_HOME` was not respected anywhere) before it spreads further.
- **Negative:** the `RegistryManager`/`UpdateChecker`/`AutoUpdateService`
  extraction grows by one small, dedicated sub-step (defining the port + its
  two adapters, applied inside `RegistryStorage`) — accepted, since deferring
  it would mean redoing the extraction once this gap was noticed anyway.
- **Explicitly unaffected:** `LockfileManager`, `HubManager`/`HubStorage`, and `app/install/*` — already
  portable/agnostic, confirmed by direct inspection while drafting this ADR.
