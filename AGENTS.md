# AGENTS.md

This file provides guidance to coding agents working in this repository.

## AGENTS Index

Use the nearest AGENTS.md for slice-specific instructions in addition to this root file:

- `./AGENTS.md` — repository-wide architecture, workflows, and conventions
- `./packages/core/AGENTS.md` — domain model and port-layer rules
- `./packages/infra/AGENTS.md` — adapter, resolver, and writer guidance
- `./packages/app/AGENTS.md` — install pipeline and transformer orchestration
- `./packages/cli/AGENTS.md` — Clipanion command structure and output rules
- `./packages/sdk/AGENTS.md` — public integration API constraints
- `./apps/vscode-extension/AGENTS.md` — extension architecture and test strategy
- `./apps/vscode-extension/test/AGENTS.md` — general extension test-writing rules
- `./apps/vscode-extension/test/e2e/AGENTS.md` — extension E2E test entry-point rules

## What this is

Prompt Registry — a marketplace for discovering, installing, and managing GitHub Copilot prompt libraries (bundles/collections) from multiple sources (GitHub, Local, Awesome Copilot, APM). It ships as both a **VS Code extension** (`apps/vscode-extension`) and a **CLI** (`packages/cli`, binary `prompt-registry`).

## Monorepo layout

pnpm workspace (`pnpm@11.5.0`, Node ≥18). Members: `packages/*`, `apps/*`, `lib`, `github-actions/*`.

```
packages/core   @prompt-registry/core    Domain types + port interfaces. Depends on nothing.
packages/infra  @prompt-registry/infra   Adapters implementing ports (GitHub, HTTP, fs, ZIP, search, stores, writers). Depends on core.
packages/app    @prompt-registry/app     Use-case orchestration (install/uninstall pipelines, registry, transform). Depends on core + infra.
packages/cli    @prompt-registry/cli     Clipanion CLI. Depends on app + core + infra.
packages/sdk    @prompt-registry/sdk     High-level API for integrations. Depends on core + infra.
apps/vscode-extension                     VS Code extension (webpack-bundled, Mocha tests).
lib             @prompt-registry/collection-scripts  Legacy collection scripts — deprecated, being migrated out.
```

Internal deps use `workspace:*`. Each package extends `tsconfig.base.json`; root `tsconfig.json` is a solution file referencing all packages.

> `lib/` (`@prompt-registry/collection-scripts`) is **deprecated** and being migrated out. Do not add code there.

## Architecture (Clean / Ports & Adapters)

Dependencies point **inward** toward `core`. This is the load-bearing rule of the repo:

- **`core`** defines domain types (`Bundle`, `Collection`, `Primitive`, `Target`, `Source`, `Profile`, `Hub`) and **ports** (interfaces) in `src/ports/` — e.g. `IBundleDownloader`, `IFilesystem`, `IHttpClient`, `IGitHubApi`, `ITargetWriter`, `IResourceTransformer`. Business rules (validation, parsing) live here. No imports of infra/app.
- **`infra`** provides concrete adapters for those ports (e.g. `NodeHttpClient`, `GitHubClient`, target writers in `src/writers/`, source resolvers in `src/resolvers/`). Swappable without touching domain logic.
- **`app`** wires ports + adapters into use cases. Install/uninstall flow lives in `src/install/` (`pipeline.ts`, `install-bundle.ts`, `layout-resolver.ts`). Resource transformation in `src/transform/` (`transformer-registry.ts` + `transformers/`, e.g. `kiro-transformer`).
- **`cli` / `sdk`** are thin delivery adapters over `app`.

When adding a capability that touches the outside world: define/extend a **port** in `core`, implement the **adapter** in `infra`, orchestrate in `app`, expose in `cli`/`sdk`. Never import infra from core.

**Quick decision table: where does new code go?**

| What you're adding | Where |
|--------------------|-------|
| New domain type or business rule | `core/src/domain/` |
| New I/O interface | Port in `core/src/ports/`, adapter in `infra` |
| New install/transform step | `app/src/install/` or `app/src/transform/` |
| New CLI command | `packages/cli/src/commands/` + register in `main.ts` |
| New VS Code UI feature | `apps/vscode-extension/src/` |

**Targets & transformers** (library-centric model): a `Target` (tagged union by `TargetType` — `vscode`, `vscode-insiders`, `copilot-cli`, `kiro`, `windsurf`, `claude-code`) describes where primitives get installed. Target writers (`infra/writers`) materialize files; transformers (`app/transform/transformers`) adapt primitive content per target. Adding a target type means touching `core` (type), a writer (`infra`), and possibly a transformer (`app`).

## Build / test / lint

Run from the repo root (recursive across all packages):

```bash
pnpm install
pnpm build        # pnpm -r run build
pnpm test         # pnpm -r run test
pnpm lint         # pnpm -r run lint
pnpm lint:fix
```

**Per-package** (preferred while iterating — much faster):

```bash
pnpm --filter=@prompt-registry/core run build
pnpm --filter=@prompt-registry/cli  run test          # vitest
pnpm --filter=@prompt-registry/infra run test:watch
pnpm --filter=@prompt-registry/app  run test:coverage
```

**Running a single test file with Vitest** — do NOT use `run test -- <file>` (pnpm passes the arg after `--` as a positional, not a vitest filter, so all tests run). Use `exec` instead:

```bash
# From repo root (preferred):
pnpm --filter=@prompt-registry/cli exec vitest run test/commands/argument-parsing.test.ts

# Or cd into the package first:
cd packages/cli && npx vitest run test/commands/argument-parsing.test.ts
```

`packages/*` use **Vitest** (`vitest run`). `core` and `infra` builds also copy assets via Node (`copy-schemas` / `copy-templates`) — don't replace those `node -e fs.cpSync` steps with shell `cp` (Windows compatibility was a deliberate fix).

## VS Code extension

The extension is **not** Vitest — it uses **Mocha (TDD style)** with a two-tier layout, and is webpack-bundled.

```bash
pnpm extension:compile        # pnpm --filter=prompt-registry run compile  (webpack prod build)
pnpm extension:watch
pnpm extension:package        # builds the .vsix (package:full)
```

Run extension tests from `apps/vscode-extension/` (these scripts are npm, not pnpm-filtered):

```bash
# All unit tests — tests compile to test-dist/ automatically via pretest hook:
cd apps/vscode-extension
LOG_LEVEL=ERROR npm run test:unit

# Single test file — auto-compiles via compile-tests, then runs just that file:
npm run test:one -- test/services/foo.test.ts

# If compile-tests already done, skip recompile:
npm run test:one -- test/services/foo.test.ts --no-compile

# Real VS Code host (Electron) — integration tests only:
npm run test:integration

# Both unit + integration:
npm run test:all
```

**Prerequisite:** `compile-tests` requires `@prompt-registry/collection-scripts` in devDependencies (it is there via `workspace:*`). If `tsc` fails with "Cannot find module '@prompt-registry/collection-scripts'", run `pnpm install` from the repo root.

`test/suite/**` = real-VS-Code integration; everything else = mocked unit/e2e. `LOG_LEVEL=ERROR` suppresses noisy runtime logs. See `apps/vscode-extension/test/AGENTS.md` for test-writing patterns.

## CLI

Clipanion-based. Each command is a class in `packages/cli/src/commands/` (static `paths`, `Command.Usage`, `Option.*`, `execute()`). Commands are registered in `packages/cli/src/main.ts` (`commandClasses` / `commands` arrays) — **a new command file must be imported and added there to be reachable.** Shared helpers (context, output formatting, `RegistryError`, parsers) come from `src/framework/`. Use `getCommandContext(this)`, `formatOutput(...)`, and `failWith(...)` rather than writing to stdout directly; honor the `-o/--output` format (`text`/`json`/`yaml`/`ndjson`).

## Conventions

- **Conventional Commits** (`feat:`, `fix(scope):`, etc.).
- TypeScript strict, no `any`. ESLint is flat-config: root `eslint.config.mjs` + per-package configs extending `eslint.shared.mjs`.
- JSON Schemas for manifests/configs live in `schemas/` (collection, hub-config, apm, lockfile, default-hubs-config); `core` also ships schemas under `src/public/schemas`.

## Docs

- `docs/contributor-guide/architecture.md`, `core-flows.md`, `testing.md`, `coding-standards.md`
- `docs/library-centric-architecture/` — clean-architecture, codemap, container/component diagrams, CLI user flows (current direction of the codebase)
