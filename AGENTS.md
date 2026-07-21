# AI Primitives Hub

AI Primitives Hub is a pnpm monorepo built on a ports-and-adapters (Clean Architecture) core: one shared domain in `packages/`, delivered through two thin layers — the `ai-primitives-hub` CLI and the VS Code extension.

## Workspace

```text
packages/               Domain: core, infra, app, cli (the shared implementation)
apps/vscode-extension/  VS Code extension and its Mocha tests (delivery layer)
lib/                    Collection build, validation, and publishing scripts
github-actions/         Collection-validation action
docs/ and website/      Markdown source and Docusaurus site
```

The extension lives in `apps/vscode-extension/src/`: adapters fetch sources, services orchestrate VS Code workflows, commands wire actions, storage persists state, and UI provides marketplace/tree views. Repository scope uses `prompt-registry.lock.json` as its source of truth.

## Commands

Use Node 22+ and pnpm 11+.

```bash
pnpm install
pnpm run compile
pnpm run test:unit
pnpm run lint
pnpm run package:vsix
```

`lib/` has its own test cycle: `cd lib && npm test`. For package work, run `pnpm -C packages -r build`, `pnpm -C packages -r lint`, or `pnpm -C packages -r test`.

## Architecture

Dependencies point inward only — `CLI` and `Extension` → `app` → `infra` → `core`:

- `packages/core` — domain types, business rules, and port interfaces. No dependency on infra, delivery frameworks, `vscode`, or direct `fs`.
- `packages/infra` — adapters implementing core's ports (GitHub, HTTP, filesystem, ZIP, search, XDG `AppStorage`). Depends only on `core`.
- `packages/app` — use-case orchestration and the public SDK surface (install, registry, discovery, transforms). No business rules.
- `packages/cli` — thin Clipanion delivery adapter; commands stay logic-free (delegate to `app`).
- `apps/vscode-extension` — the second delivery layer, being migrated onto `app`/`core`/`infra`.

New domain or use-case logic belongs in `packages/`, not in a delivery layer. See [ADRs](docs/contributor-guide/architecture/adr/adr-index.md) and [library-centric architecture](docs/contributor-guide/architecture/library-centric-architecture/clean-architecture.md).

### Migration & naming rules

- **Strangler-fig migration (ADR-0001):** the extension's `src/services/*` are becoming thin delegators to `app`. Extract logic into `app` and delegate; don't add new business rules to a service, and don't duplicate what `app` already does.
- **Dual naming is deliberate, not a bug (ADR-0004):** new artifacts use `ai-primitives-hub` / `@ai-primitives-hub/*`; existing machine identifiers stay as-is — the repo lockfile (`prompt-registry.lock.json`), the extension `package.json` name/publisher (`AmadeusITGroup.prompt-registry`), and command IDs (`promptregistry.*`). Do not "unify" these.
- **Storage (ADR-0005):** resolve on-disk roots through the injected `AppStorage` port (XDG default in `infra`), never `vscode.ExtensionContext.globalStorageUri` directly in new `app` code.

## Working Rules

- For bug fixes and feature integrations, start with a focused failing test, implement the minimal change, rerun it, then run related coverage.
- Search existing implementation, helpers, and neighboring tests before adding code. Reuse instead of duplicating.
- Tests must verify observable behavior through public entry points; mock external boundaries, not the unit under test.
- Treat transformed values in failures as a production-path lead before rewriting fixtures.
- Use `Logger.getInstance()` rather than `console.log`; errors should be actionable.
- Update user-facing or contributor documentation with behavior, command, setting, schema, or workflow changes.

## Extension Conventions

- First `RegistryManager.getInstance()` call needs an `ExtensionContext`.
- Valid bundles have a root `deployment-manifest.yml`; validation checks id, version, and name.
- Add new source adapters in `packages/infra/src/adapters/` (implement `core`'s `SourceAdapter`), not in the extension — `src/adapters/` is post-cutover dead code (see its guide).
- Add migrations in `src/migrations/`, run them from activation, and tag temporary compatibility code with `@migration-cleanup(name)`.

## References

- [README](README.md) for project entry points
- [Contributing guide](CONTRIBUTING.md)
- [Contributor architecture](docs/contributor-guide/architecture.md)
- [Testing guide](docs/contributor-guide/testing.md)
- [Documentation index](docs/README.md)

## Subfolder Instructions

Read the closest applicable guide before editing files there; it overrides this file.

| Folder | Guide |
|---|---|
| `packages/` | [layered packages](packages/AGENTS.md) |
| `apps/vscode-extension/` | [extension workflow](apps/vscode-extension/AGENTS.md) |
| `apps/vscode-extension/src/adapters/` | [adapter implementation](apps/vscode-extension/src/adapters/AGENTS.md) |
| `apps/vscode-extension/src/services/` | [service patterns](apps/vscode-extension/src/services/AGENTS.md) |
| `apps/vscode-extension/test/` | [test conventions](apps/vscode-extension/test/AGENTS.md) |
| `apps/vscode-extension/test/e2e/` | [E2E conventions](apps/vscode-extension/test/e2e/AGENTS.md) |
| `docs/` | [documentation workflow](docs/AGENTS.md) |
