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

Use Node 24+ and pnpm 11+.

```bash
pnpm install
pnpm run verify            # everything, in the right order, one exit code
pnpm run verify:packages   # packages/ only: build + test + lint:fix (~30s)
```

`verify` is `verify:packages` followed by the extension's `compile`, `test:extension`, and `lint:extension`. Prefer it over running the steps by hand: the ordering matters and this bakes it in. It takes ~110s and prints thousands of lines, so redirect it and only read the tail on failure — a passing run needs no output at all:

```bash
pnpm run verify > /tmp/verify.log 2>&1 || tail -40 /tmp/verify.log
```

The individual steps, when you need a tighter loop:

```bash
pnpm run build:packages    # required before the extension typechecks
pnpm run test:packages
pnpm run compile           # extension bundle
pnpm run test:extension    # compile-tests, then test:unit
pnpm run lint:fix          # packages + extension
pnpm run package:vsix
```

Use these scripts rather than open-coding a recursive command. `pnpm -r <script>` and `pnpm -C packages -r <script>` both resolve the whole workspace — the latter looks scoped but is not — so they also run `lib/`, `website/`, and `github-actions/`: 4920 lines of output where the scoped script gives 181. The scripts filter on `@ai-primitives-hub/*`, matching what CI does.

`lib/` has its own test cycle: `cd lib && npm test`.

There is no root `eslint.config.mjs`, so a bare `npx eslint <path>` fails at the repository root. Lint through `lint:fix` (or `lint:packages` / `lint:extension`), always with the `:fix` option. Do not run the corresponding non-fixing lint command afterwards: it reports the same remaining issues without adding useful validation. `src test` carries accepted warnings, so add `--quiet` when you only want errors.

## Verification

- **Judge success by exit status, not by grepping output.** A pipe replaces the exit code with the last command's, so `vitest … | tail` and `eslint … | grep` both report success for a failing run. Run the command bare, or end it with `&& echo PASS || echo FAIL`.
- **`pnpm run test:unit` alone proves nothing.** It executes the already-compiled `test-dist/` and compiles nothing, so after editing any `.ts` it silently re-runs the previous build and passes. Use `pnpm run test:extension`, which compiles first.
- **Rebuild `packages/` after switching branches or changing a cross-package type.** Lint and `tsc` resolve `@ai-primitives-hub/*` through built `dist/`, so a stale build invents errors that are absent from the checked-out source and hides ones that are present. The usual symptoms are a new export reported as "has no exported member" and type errors naming a symbol you cannot find in `src/`.
- Vitest (`packages/*`) prints `Tests N passed`; Mocha (the extension) prints `N passing`. Pass `--no-color` to Vitest before matching on that line; otherwise ANSI codes break the match.
- Extension unit tests log expected errors from negative-path cases (`cmd.exe not found`, `[AI Primitives Hub] ERROR: …`). Those are not failures. Only the summary line and the exit status are.

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
