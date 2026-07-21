# VS Code Extension

This package ships the AI Primitives Hub extension — one of two delivery layers over the shared domain in `packages/`. `src/extension.ts` activates it; commands expose VS Code actions, UI provides the marketplace and tree view, and services orchestrate those workflows.

Business logic lives in `@ai-primitives-hub/app`/`core`/`infra`, not here. Per [ADR-0001](../../docs/contributor-guide/architecture/adr/0001-ports-and-adapters-for-cli-and-extension.md), `src/services/*` are being migrated (strangler fig) into thin delegators to `app`. Before adding logic to a service, check whether `app` already provides it or should.

## Commands

Run from the repository root:

```bash
pnpm -C apps/vscode-extension run compile
pnpm -C apps/vscode-extension run compile-tests
pnpm -C apps/vscode-extension run test:unit
pnpm -C apps/vscode-extension run test:integration
pnpm -C apps/vscode-extension run package:vsix
```

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
