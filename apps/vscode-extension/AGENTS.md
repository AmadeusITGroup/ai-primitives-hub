# VS Code Extension

This package ships the AI Primitives Hub extension — one of two delivery layers over the shared domain in `packages/`. `src/extension.ts` activates it; commands expose VS Code actions, UI provides the marketplace and tree view, and services orchestrate those workflows.

Business logic lives in `@ai-primitives-hub/app`/`core`/`infra`, not here. Per [ADR-0001](../../docs/contributor-guide/architecture/adr/0001-ports-and-adapters-for-cli-and-extension.md), `src/services/*` are being migrated (strangler fig) into thin delegators to `app`. Before adding logic to a service, check whether `app` already provides it or should.

## Commands

From the repository root:

```bash
pnpm run compile                  # bundle src/
pnpm run test:extension           # unit + integration (the package's own test:all)
pnpm run test:extension:unit      # unit only, ~20s
pnpm run lint:extension
pnpm -C apps/vscode-extension run package:vsix
```

**Use one of the `test:extension*` scripts, not `test:unit` on its own.** `test:unit` executes `test-dist/` and compiles nothing — it has no `pre` hook (`pretest` belongs to `test`), so running it after editing a `.ts` file silently re-runs the previous build: a changed test keeps its old assertions and a new test file is simply absent from the glob. The suite then passes and tells you nothing. `test:unit` stays a separate script because CI applies post-compilation fixes between the two steps.

Two layers, and only the second one sees VS Code:

| Layer | Files | Sees |
|---|---|---|
| unit | `test/**` except `test/suite/` | everything importable with a mocked `vscode` |
| integration | `test/suite/` | command registration, `package.json` contributions, real activation |

So a change to `package.json` contributions or to `extension.ts` command wiring is **not** verified by a passing unit run. `test:extension` covers both; it launches a real VS Code and needs a display.

`compile-tests` is also the only typecheck for `test/**`, since `compile` (webpack) only covers `src/`. It emits JavaScript even when it reports type errors, so tests can pass while the types are broken — read its output, do not just check that tests ran afterwards.

Building `packages/` first is a precondition for both: cross-package types resolve through the built `dist/`. `pnpm run verify` does the whole chain in order.

## Architecture

```text
src/adapters/    Source-specific implementations
src/services/    Installation, scope, registry, hub, and update workflows
src/commands/    VS Code command handlers
src/storage/     Persistent global-storage data
src/ui/          Marketplace webview and registry tree
src/migrations/  Activation-time data migrations
```

- `RegistryManager` coordinates adapters, storage, and installation. Its first `getInstance()` call needs `ExtensionContext`.
- `BundleInstaller` requires a root `deployment-manifest.yml` and validates id, version, and name.
- Repository installations are governed by `prompt-registry.lock.json`; user and workspace placement goes through `UserScopeService`.
- Register source implementations with `RepositoryAdapterFactory.register()`.
- Use `Logger.getInstance()`, throw actionable errors, and let commands surface them through VS Code notifications.

## Change Rules

- Find existing services, utilities, and tests before adding code; do not duplicate helpers in `src/utils/` or `test/helpers/`.
- Write a focused failing test before changing behavior, then run it and the tests in the same service or adapter directory as the changed file, plus all unit tests: `pnpm -C apps/vscode-extension run test:unit`.
- Keep activation events, `package.json` contributions, and tests aligned.
- Add migrations in `src/migrations/`, wire them through `runMigrations()`, and mark temporary migration compatibility code with `@migration-cleanup(name)`.
- Update relevant user or contributor docs; see [documentation guidance](../../docs/AGENTS.md).

## Local Guides

Read the closest guide before editing these paths:
If a local AGENTS.md guide conflicts with rules in this file, the local guide takes precedence for files under its path.

| Path | Guide |
|---|---|
| `src/adapters/` | [adapter rules](src/adapters/AGENTS.md) |
| `src/services/` | [service rules](src/services/AGENTS.md) |
| `test/` | [test rules](test/AGENTS.md) |
| `test/e2e/` | [E2E rules](test/e2e/AGENTS.md) |
