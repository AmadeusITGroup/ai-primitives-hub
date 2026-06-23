# vscode-extension

VS Code extension. Webpack-bundled. Uses **Mocha (TDD style)** — not Vitest. Entry point: `src/extension.ts`.

## Source Structure

```
src/
├── extension.ts    → Activation entry point; registers all VS Code commands
├── adapters/       → Source adapters (GitHub, AwesomeCopilot, Local, APM)
├── commands/       → VS Code command handler classes
├── services/       → Core business logic services
├── storage/        → Persistence (lockfile, target state)
├── ui/             → WebView, TreeView, QuickPick components
├── integrations/   → MCP and other integrations
├── migrations/     → State migration logic
├── notifications/  → Notification handlers
├── config/         → Extension configuration
└── utils/          → Shared utilities
```

## Build & Package

```bash
pnpm extension:compile        # webpack production build
pnpm extension:watch          # dev/watch mode
pnpm extension:package        # produces .vsix (package:full)
```

## Tests

**Run from `apps/vscode-extension/` using `npm run`, not `pnpm --filter`.**

```bash
# All unit tests (compiles to test-dist/ first, LOG_LEVEL suppresses runtime noise):
LOG_LEVEL=ERROR npm run test:unit

# Single test file — auto-compiles then runs just that file:
npm run test:one -- test/services/foo.test.ts

# Real VS Code Electron host (integration only):
npm run test:integration

# Both unit + integration:
npm run test:all

# Coverage:
npm run test:coverage
npm run test:coverage:unit
```

**Compile step:** `npm run compile-tests` runs `tsc -p tsconfig.test.json` + copies fixtures into `test-dist/`. Requires `@prompt-registry/collection-scripts` devDependency (`workspace:*` — already in package.json). If you see "Cannot find module '@prompt-registry/collection-scripts'", run `pnpm install` from the repo root.

`test/mocha.setup.js` intercepts `require('vscode')` and loads `test/vscode-mock.js` — add missing VS Code APIs there before adding per-test stubs.

## Test Layout

| Location | Runner | When to use |
|----------|--------|-------------|
| `test/suite/**` | Electron (real VS Code) | `vscode.commands.executeCommand`, TreeView/WebView, activation lifecycle |
| `test/e2e/` | Node (mocked VS Code) | Multi-component E2E workflows through command handler classes |
| `test/services/`, `test/adapters/`, etc. | Node (mocked VS Code) | Unit tests for individual classes |
| `test/**/*.property.test.ts` | Node | `fast-check` property/invariant tests |

## Test Deduplication Rules (CRITICAL)

**One class = maximum two test files:** `<name>.test.ts` (unit) + `<name>.property.test.ts` (property). No more.

- Unit tests: specific input → specific output, edge cases, error messages
- Property tests: invariants across all inputs — cover **different** concerns than unit tests
- E2E tests: user-facing workflows through actual entry points only (see below)

Before creating a test file: `grep -r "behavior you want to test" test/ --include="*.test.ts"` — if it exists, add to that file.

## E2E Tests: Never Reimplement Production Code

E2E tests must invoke the **actual code path**, not duplicate it. Two valid patterns:

```typescript
// Option 1: Real VS Code command (test/suite/ only)
await vscode.commands.executeCommand('promptRegistry.installBundle', bundleId, opts);

// Option 2: Command handler class directly (test/e2e/)
const cmd = new InstallBundleCommands(registryManager, ...);
await cmd.install(bundleId, opts);
```

Never construct internal service pipelines manually in a test — that tests the test, not the extension.

## Key Test Helpers (`test/helpers/`)

```typescript
import { BundleBuilder, createMockInstalledBundle } from '../helpers/bundle-test-helpers';
import { setupReleaseMocks, createMockGitHubSource } from '../helpers/repository-fixture-helpers';
import { createE2ETestContext } from '../helpers/e2e-test-helpers';
import { LockfileBuilder } from '../helpers/lockfile-test-helpers';
// Also: property-test-helpers, auto-update-test-helpers, marketplace-test-helpers,
//       ui-test-helpers, process-test-helpers, setup-state-test-helpers
```

Check `test/helpers/` before writing any mock/fixture code — helpers likely already exist.

## HTTP Mocking (nock)

```typescript
import nock from 'nock';
nock('https://api.github.com').persist().get('/repos/owner/repo/releases').reply(200, data);
// Always call nock.cleanAll() in teardown
```

Use `.persist()` for mocks called multiple times. Include query strings in the path directly, not via `.query()`.

## Mocha Template

```typescript
import * as assert from 'node:assert';
import * as sinon from 'sinon';

suite('ComponentName', () => {
  let sandbox: sinon.SinonSandbox;
  setup(() => { sandbox = sinon.createSandbox(); });
  teardown(() => { sandbox.restore(); });

  suite('methodName()', () => {
    test('handles success case', async () => {
      // Arrange → Act → Assert
      assert.strictEqual(actual, expected);
    });
  });
});
```

## Known Gotchas

- `AwesomeCopilotAdapter` caches bundles for 5 minutes — clear `adapter.collectionsCache` in tests that simulate content changes
- Errors like `Failed to create Copilot file: ...` are expected in test environments; they don't affect results
- BundleId format differs: Awesome Copilot = `collection-name` (no version), GitHub = `owner-repo-v1.0.0`
- Red flag that you need real VS Code (`test/suite/`): mock setup > 50 lines or mocking 5+ VS Code APIs
