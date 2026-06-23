# Contributing to Prompt Registry

Thank you for your interest in contributing to Prompt Registry! This is a pnpm monorepo shipping both a **VS Code extension** and a **CLI** (`prompt-registry`). This document covers the workspace as a whole; for extension-specific details see [apps/vscode-extension/CONTRIBUTING.md](apps/vscode-extension/CONTRIBUTING.md).

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Monorepo Structure](#monorepo-structure)
- [Architecture](#architecture)
- [Build Commands](#build-commands)
- [Testing](#testing)
- [Coding Standards](#coding-standards)
- [Commit Messages](#commit-messages)
- [Pull Request Process](#pull-request-process)
- [Release Process](#release-process)

---

## Code of Conduct

This project adheres to a [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

---

## Getting Started

### Prerequisites

- **Node.js** 18.x or 20.x
- **pnpm** 11.5.0+ (`npm install -g pnpm@11`)
- **Git**
- **VS Code** (latest stable) — only required for extension development

### Quick Start

```bash
# Fork on GitHub, then:
git clone https://github.com/YOUR_USERNAME/prompt-registry.git
cd prompt-registry
pnpm install
pnpm build
pnpm test
```

Before starting any work: check [existing issues](https://github.com/AmadeusITGroup/prompt-registry/issues) to avoid duplicates, and open an issue to discuss major features before coding.

---

## Monorepo Structure

This is a **pnpm workspace** (`pnpm-workspace.yaml`). Members are `packages/*`, `apps/*`, and `lib`.

```
prompt-registry/
├── packages/
│   ├── core/      @prompt-registry/core   — Domain types + port interfaces. No external deps.
│   ├── infra/     @prompt-registry/infra  — Adapters (GitHub, HTTP, fs, ZIP, search, stores, writers)
│   ├── app/       @prompt-registry/app    — Use-case orchestration (install/uninstall pipelines)
│   ├── cli/       @prompt-registry/cli    — Clipanion CLI (binary: prompt-registry)
│   └── sdk/       @prompt-registry/sdk    — High-level API for integrations
├── apps/
│   └── vscode-extension/                  — VS Code extension (webpack, Mocha tests)
├── lib/                                   — Legacy collection scripts (deprecated, being migrated)
├── docs/                                  — Contributor and user documentation
├── schemas/                               — JSON Schemas for manifests/configs
├── pnpm-workspace.yaml
├── tsconfig.base.json                     — Shared TS config
└── tsconfig.json                          — Solution root (references all packages)
```

Internal dependencies use `workspace:*`. Each package extends `tsconfig.base.json`.

---

## Architecture

The codebase follows **Clean Architecture / Ports & Adapters**. The load-bearing rule: **dependencies point inward toward `core`**. Never import `infra` from `core`.

| Layer | Package | Responsibility |
|-------|---------|----------------|
| Domain | `core` | Types (`Bundle`, `Collection`, `Target`, `Hub`, `Profile`), port interfaces, validation |
| Infrastructure | `infra` | Concrete adapters for ports: `NodeHttpClient`, `GitHubClient`, target writers, source resolvers |
| Application | `app` | Wires ports + adapters into use cases: install/uninstall pipeline, resource transformers |
| Delivery | `cli`, `sdk`, `vscode-extension` | Thin layers over `app` |

**Adding a capability that touches the outside world:**
1. Define or extend a **port** (interface) in `core`
2. Implement the **adapter** in `infra`
3. Orchestrate in `app`
4. Expose in `cli`/`sdk`/extension

See [docs/contributor-guide/architecture.md](docs/contributor-guide/architecture.md) and [docs/library-centric-architecture/](docs/library-centric-architecture/) for full diagrams.

---

## Build Commands

### Workspace-level (runs recursively across all packages)

```bash
pnpm install          # Install all dependencies
pnpm build            # Build all packages (pnpm -r run build)
pnpm test             # Run all tests
pnpm lint             # Lint all packages
pnpm lint:fix         # Auto-fix lint issues
```

### Per-package (preferred while iterating — much faster)

```bash
pnpm --filter=@prompt-registry/core  run build
pnpm --filter=@prompt-registry/infra run build
pnpm --filter=@prompt-registry/app   run build
pnpm --filter=@prompt-registry/cli   run build
pnpm --filter=@prompt-registry/cli   run test
pnpm --filter=@prompt-registry/infra run test:watch
pnpm --filter=@prompt-registry/app   run test:coverage
```

### VS Code extension

```bash
pnpm --filter=prompt-registry run compile       # webpack production build
pnpm --filter=prompt-registry run watch         # dev mode (auto-compile)
pnpm --filter=prompt-registry run package:vsix  # build .vsix
```

See [apps/vscode-extension/CONTRIBUTING.md](apps/vscode-extension/CONTRIBUTING.md) for extension-specific workflows.

---

## Testing

### Packages (`packages/*`) — Vitest

```bash
pnpm --filter=@prompt-registry/cli  run test             # run once
pnpm --filter=@prompt-registry/infra run test:watch      # watch mode
pnpm --filter=@prompt-registry/app  run test:coverage    # with coverage
```

> Note: `core` and `infra` builds copy assets via a Node script (`copy-schemas` / `copy-templates`). Don't replace those steps with shell `cp` — the Node approach is intentional for Windows compatibility.

### VS Code extension — Mocha (two-tier)

```bash
cd apps/vscode-extension

LOG_LEVEL=ERROR npm run test:unit          # Node, vscode mocked
npm run test:integration                   # real VS Code (Electron host)
npm test                                   # both
npm run test:one -- test/services/foo.test.ts   # single file
```

Tests compile to `test-dist/` first. `test/suite/` = real VS Code; everything else = mocked.

See [docs/contributor-guide/testing.md](docs/contributor-guide/testing.md) for full test guidance.

---

## Coding Standards

- **TypeScript strict**, no `any`. ESLint flat-config: root `eslint.config.mjs` + per-package configs extending `eslint.shared.mjs`.
- **Named exports** preferred over default exports.
- **Naming**: `PascalCase` classes/interfaces, `camelCase` functions, `UPPER_SNAKE_CASE` constants, files match class name or `camelCase` for utilities.
- **No `process.exit` outside the framework entry points** — commands use `ctx.exit()`.
- **CLI commands**: use `getCommandContext(this)`, `formatOutput(...)`, and `failWith(...)` — never write to stdout directly. Honor `-o/--output` format (`text`/`json`/`yaml`/`ndjson`). Register new command classes in `packages/cli/src/main.ts`.

See [docs/contributor-guide/coding-standards.md](docs/contributor-guide/coding-standards.md) for full standards.

---

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>
```

**Types**: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `perf`, `ci`

**Examples:**

```
feat(cli): add install --dry-run flag
fix(infra): handle rate-limit retry on GitHub API
docs(contributing): update monorepo structure
test(app): add coverage for uninstall pipeline
```

- Subject: ≤50 chars, imperative mood ("add" not "added")
- Body: wrap at 72 chars, explain *what* and *why*
- Footer: reference issues (`Closes #123`, `Fixes #456`)

---

## Pull Request Process

1. **Update from main**: `git fetch upstream && git rebase upstream/main`
2. **Run checks**: `pnpm lint && pnpm build && pnpm test`
3. **Add tests** for new features or bug fixes
4. **Open PR** using the [PR template](.github/pull_request_template.md)
5. **Address review feedback**
6. Maintainers merge after CI passes and at least one approval

---

## Release Process

See [docs/contributor-guide/releasing.md](docs/contributor-guide/releasing.md) for the full process.

We use [Semantic Versioning](https://semver.org/). Publishing the VS Code extension to the Marketplace is triggered automatically by creating a GitHub release. The CLI packages are published to npm independently.

---

## License

This project is licensed under the Apache License 2.0 — see [LICENSE.txt](LICENSE.txt) for details. By contributing, you agree your contributions are licensed under the same terms.


## Thank You! 🙏

Your contributions make this project better. Whether it's a bug fix, feature, or documentation improvement, we appreciate your time and effort.

**Happy coding!** 🚀

---

**Questions?** Open an issue or discussion - we're here to help!
