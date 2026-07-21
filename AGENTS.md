# AI Primitives Hub

AI Primitives Hub is a pnpm monorepo for a VS Code extension, collection tooling, documentation site, and emerging ports-and-adapters packages.

## Workspace

```text
apps/vscode-extension/  VS Code extension and its Mocha tests
lib/                    Collection build, validation, and publishing scripts
packages/               Core, infra, app, and CLI packages
github-actions/         Collection-validation action
docs/ and website/      Markdown source and Docusaurus site
```

The extension lives in `apps/vscode-extension/src/`: adapters fetch sources, services own business logic, commands wire VS Code actions, storage persists state, and UI provides marketplace/tree views. Repository scope uses `prompt-registry.lock.json` as its source of truth.

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

## Working Rules

- For a bug fix, reproduce with a focused failing test, make the minimal fix, rerun it, then run related coverage.
- Search existing implementation, helpers, and neighboring tests before adding code. Reuse instead of duplicating.
- Tests must verify observable behavior through public entry points; mock external boundaries, not the unit under test.
- Treat transformed values in failures as a production-path lead before rewriting fixtures.
- Use `Logger.getInstance()` rather than `console.log`; errors should be actionable.
- Update user-facing or contributor documentation with behavior, command, setting, schema, or workflow changes.

## Extension Conventions

- First `RegistryManager.getInstance()` call needs an `ExtensionContext`.
- Valid bundles have a root `deployment-manifest.yml`; validation checks id, version, and name.
- Add adapters through `RepositoryAdapterFactory.register()` and implement `IRepositoryAdapter`.
- Add migrations in `src/migrations/`, run them from activation, and tag temporary compatibility code with `@migration-cleanup(name)`.

## References

- [README](README.md) for project entry points
- [Contributor architecture](docs/contributor-guide/architecture.md)
- [Testing guide](docs/contributor-guide/testing.md)
- [Documentation index](docs/README.md)

## Subfolder Instructions

Read the closest applicable guide before editing files there; it overrides this file.

| Folder | Guide |
|---|---|
| `apps/vscode-extension/` | [extension workflow](apps/vscode-extension/AGENTS.md) |
| `apps/vscode-extension/src/adapters/` | [adapter implementation](apps/vscode-extension/src/adapters/AGENTS.md) |
| `apps/vscode-extension/src/services/` | [service patterns](apps/vscode-extension/src/services/AGENTS.md) |
| `apps/vscode-extension/test/` | [test conventions](apps/vscode-extension/test/AGENTS.md) |
| `apps/vscode-extension/test/e2e/` | [E2E conventions](apps/vscode-extension/test/e2e/AGENTS.md) |
| `docs/` | [documentation workflow](docs/AGENTS.md) |
