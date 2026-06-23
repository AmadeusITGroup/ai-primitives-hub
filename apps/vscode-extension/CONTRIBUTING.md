# Contributing to the VS Code Extension

This file covers development workflows specific to `apps/vscode-extension`. For workspace-wide setup, architecture, commit conventions, and PR process, see the [root CONTRIBUTING.md](../../CONTRIBUTING.md).

## Table of Contents

- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Build](#build)
- [Testing](#testing)
- [Extension Structure](#extension-structure)
- [Scaffolding Templates](#scaffolding-templates)
- [Debugging in VS Code](#debugging-in-vs-code)

---

## Prerequisites

- Node.js 18.x or 20.x
- pnpm 11.5+ (workspace root install covers this)
- VS Code latest stable

---

## Setup

From the **workspace root**, run:

```bash
pnpm install
pnpm build   # builds all packages the extension depends on first
```

Then inside `apps/vscode-extension/`:

```bash
cd apps/vscode-extension
npm run compile   # webpack production build
```

---

## Build

| Command | Description |
|---------|-------------|
| `pnpm --filter=prompt-registry run compile` | webpack production build |
| `pnpm --filter=prompt-registry run watch` | dev mode (auto-recompile on change) |
| `pnpm --filter=prompt-registry run package:vsix` | build a `.vsix` installable package |

> The extension is **webpack-bundled** (see `webpack.config.js`). TypeScript is not compiled directly to `out/` in production — the bundle goes to `dist/extension.js`.

---

## Testing

The extension uses **Mocha TDD style** (`suite` / `test` / `assert`) with a two-tier layout. Tests must be run from `apps/vscode-extension/` using `npm` (not `pnpm`), because the integration tier requires VS Code's Electron host.

### Run tests

```bash
cd apps/vscode-extension

# All tests (unit + integration)
LOG_LEVEL=ERROR npm test

# Unit / mocked-vscode tests only (fast, no VS Code host needed)
LOG_LEVEL=ERROR npm run test:unit

# Integration tests (spawns a real VS Code instance)
npm run test:integration

# Single test file (auto-compiles before running)
npm run test:one -- test/services/bundle-installer.test.ts

# Coverage
npm run test:coverage:unit    # c8 html report in coverage/
```

Use `LOG_LEVEL=ERROR` to suppress debug output during normal runs.

### Test layout

```
test/
├── adapters/       Unit tests for source adapters
├── commands/       Command handler tests
├── services/       Service layer tests
├── storage/        Storage tests
├── ui/             UI component tests
├── utils/          Utility tests
├── e2e/            Multi-component workflows (mocked VS Code)
├── suite/          Real VS Code integration tests (Electron host)
├── fixtures/       Test data and mock responses
├── helpers/        Shared test utilities
├── mocks/          Mock implementations
├── mocha.setup.js  Mocks require('vscode') before tests load
└── vscode-mock.js  VS Code API mock
```

Tests compile to `test-dist/` before execution. `test/suite/` = real VS Code; everything else = mocked Node.

| Type | Suffix | Purpose |
|------|--------|---------|
| Unit | `.test.ts` | Single component in isolation |
| Property | `.property.test.ts` | Invariant testing with `fast-check` |
| E2E (mocked) | `test/e2e/*.test.ts` | Multi-component workflows, no VS Code host |
| Integration | `test/suite/*.test.ts` | Real extension activation and command registration |

See [docs/contributor-guide/testing.md](../../docs/contributor-guide/testing.md) for full guidance.

---

## Extension Structure

```
src/
├── adapters/       Source adapters (GitHub, Local, APM, Skills)
├── commands/       VS Code command handlers
├── config/         Configuration defaults
├── integrations/   External integrations (Copilot)
├── notifications/  Notification services
├── services/       Core business logic (RegistryManager, BundleInstaller, etc.)
├── storage/        Persistent state management (hub-storage, etc.)
├── types/          TypeScript type definitions
├── ui/             WebView and TreeView providers
├── utils/          Shared utilities
└── extension.ts    Activation entry point
```

Key services:

| Service | File | Responsibility |
|---------|------|----------------|
| `RegistryManager` | `services/registry-manager.ts` | Central orchestrator |
| `BundleInstaller` | `services/bundle-installer.ts` | Download, extract, install |
| `UserScopeService` | `services/user-scope-service.ts` | Sync bundles to Copilot dirs |
| `McpServerManager` | `services/mcp-server-manager.ts` | MCP server install/tracking |
| `HubManager` | `services/hub-manager.ts` | Hub config and profiles |

---

## Scaffolding Templates

The extension ships scaffold templates for creating new prompt projects (`templates/scaffolds/`):

| Template | Location | Description |
|----------|----------|-------------|
| `github` | `templates/scaffolds/github/` | Full project with GitHub Actions CI for automated collection publishing |
| `apm` | `templates/scaffolds/apm/` | APM package template |

Templates use `{{variable}}` substitution syntax. When modifying templates:
- Run `npm run test:unit` — scaffold tests live in `test/commands/`
- Verify all generated files are valid and runnable

---

## Debugging in VS Code

1. Open the workspace root in VS Code
2. Press **F5** to launch the **Extension Development Host**
3. Set breakpoints directly in TypeScript source (`src/`)
4. View extension logs: **View → Output → Prompt Registry**
5. For WebView issues, use the browser DevTools (Help → Toggle Developer Tools)

For test debugging, add a breakpoint and run **"Extension Tests"** launch configuration.
