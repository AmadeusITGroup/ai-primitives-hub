# Testing Guide

How to run tests in the AI Primitives Hub extension.

> **For test writing patterns** (style, helpers, anti-patterns, deduplication rules), see [`test/AGENTS.md`](../../apps/vscode-extension/test/AGENTS.md). This file covers commands and tooling only.

## Testing Architecture

The project uses a **two-tier** test layout, both running under **Mocha TDD style** (`suite` / `test` / `assert`):

| Tier | Location | Runs In | Purpose |
|------|----------|---------|---------|
| Unit / Property / E2E (mocked) | `test/{services,adapters,commands,ui,utils,storage,e2e}/**/*.test.ts` | Node.js with `vscode` mocked via `test/mocha.setup.js` | Pure logic, data flow, multi-component workflows |
| Integration (real VS Code) | `test/suite/**/*.test.ts` | Electron via `test/runExtensionTests.js` | Extension activation, command registration, UI wiring |

Tests compile to `test-dist/` first (`pnpm run compile-tests`) — Mocha runs the compiled JS.

## Quick Start

```bash
# All tests (unit + integration)
LOG_LEVEL=ERROR pnpm test

# Unit / property / e2e only (no VS Code host)
LOG_LEVEL=ERROR pnpm run test:unit

# Integration tests (real VS Code)
pnpm run test:integration

# Single file (auto-compiles)
pnpm run test:one -- test/services/bundle-installer.test.ts

# Coverage
pnpm run test:coverage            # all tests
pnpm run test:coverage:unit       # unit only, c8 html report
pnpm run test:coverage:integration # integration only
```

Use `LOG_LEVEL=ERROR` to suppress debug output.

## Test Directory Layout

```
test/
├── adapters/           # Adapter unit tests
├── commands/           # Command handler tests
├── services/           # Service layer tests
├── storage/            # Storage tests
├── ui/                 # UI component tests
├── utils/              # Utility tests
├── e2e/                # Multi-component workflow tests (mocked VS Code)
├── suite/              # Real VS Code integration tests
├── fixtures/           # Test data and mock responses
├── helpers/            # Shared test utilities
├── mocks/              # Mock implementations
├── mocha.setup.js      # Mocks `require('vscode')` before tests load
└── vscode-mock.js      # VS Code API mock implementation
```

## Test Types

| Type | Suffix | Purpose |
|------|--------|---------|
| Unit | `.test.ts` | Single component |
| Property | `.property.test.ts` | Invariant testing with `fast-check` |
| E2E | `test/e2e/*.test.ts` | Multi-component workflows (mocked VS Code) |
| Integration | `test/suite/*.test.ts` | Real VS Code extension host |

## Debugging

```bash
LOG_LEVEL=DEBUG pnpm run test:one -- test/path/to/test.ts

# Capture for analysis
LOG_LEVEL=ERROR pnpm test 2>&1 | tee test.log | tail -20
```

## Coverage

```bash
pnpm run test:coverage:unit    # c8 html output in coverage/
```

Coverage reports are written to the `coverage/` directory.

## What These Suites Do Not Cover

Everything above is automated. The paths a person still has to walk by hand — installing the published extension on a clean machine, authenticating against real GitHub, confirming Copilot and Kiro actually recognize what was installed, publishing a collection through a real runner, upgrading from the previous major — are covered manually.

Start with the [Golden Path Test Cases](./testing/golden-path.md): three chained scenarios that every release must pass on both the extension and the CLI. 
The [Full Test Plan](./testing/test-plan.md) holds all 19 plans for area-by-area coverage when a PR touches something specific.

## See Also

- [`test/AGENTS.md`](../../apps/vscode-extension/test/AGENTS.md) — Test writing patterns, helpers, anti-patterns
- [`test/e2e/AGENTS.md`](../../apps/vscode-extension/test/e2e/AGENTS.md) — E2E-specific guidance
- [Development Setup](./development-setup.md) — Environment setup
- [Golden Path Test Cases](./testing/golden-path.md) — The three mandatory manual scenarios, and the release gate
- [Full Test Plan](./testing/test-plan.md) — All 19 plans, for area-by-area manual coverage
- [Testing SSH Remote](./testing/ssh-remote.md) — Testing in a VS Code remote SSH scenario
