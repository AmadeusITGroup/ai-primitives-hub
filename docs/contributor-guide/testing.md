# Testing Guide

How to run tests in the AI Primitives Hub extension.

> **For test writing patterns** (style, helpers, anti-patterns, deduplication rules), see [`test/AGENTS.md`](../../test/AGENTS.md). This file covers commands and tooling only.

## Testing Architecture

The project uses a **two-tier** test layout, both running under **Mocha TDD style** (`suite` / `test` / `assert`):

| Tier | Location | Runs In | Purpose |
|------|----------|---------|---------|
| Unit / Property / E2E (mocked) | `test/{services,adapters,commands,ui,utils,storage,e2e}/**/*.test.ts` | Node.js with `vscode` mocked via `test/mocha.setup.js` | Pure logic, data flow, multi-component workflows |
| Integration (real VS Code) | `test/suite/**/*.test.ts` | Electron via `test/runExtensionTests.js` | Extension activation, command registration, UI wiring |

Tests compile to `test-dist/` first (`npm run compile-tests`) — Mocha runs the compiled JS.

## Quick Start

```bash
# All tests (unit + integration)
LOG_LEVEL=ERROR npm test

# Unit / property / e2e only (no VS Code host)
LOG_LEVEL=ERROR npm run test:unit

# Integration tests (real VS Code)
npm run test:integration

# Single file (auto-compiles)
npm run test:one -- test/services/bundle-installer.test.ts

# Coverage
npm run test:coverage            # all tests
npm run test:coverage:unit       # unit only, c8 html report
npm run test:coverage:integration # integration only
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
LOG_LEVEL=DEBUG npm run test:one -- test/path/to/test.ts

# Capture for analysis
LOG_LEVEL=ERROR npm test 2>&1 | tee test.log | tail -20
```

## Coverage

```bash
npm run test:coverage:unit    # c8 html output in coverage/
```

Coverage reports are written to the `coverage/` directory.

## See Also

- [`test/AGENTS.md`](../../test/AGENTS.md) — Test writing patterns, helpers, anti-patterns
- [`test/e2e/AGENTS.md`](../../test/e2e/AGENTS.md) — E2E-specific guidance
- [Development Setup](./development-setup.md) — Environment setup
