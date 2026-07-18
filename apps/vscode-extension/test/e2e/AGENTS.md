# E2E Test Writing Guide

Patterns for End-to-End tests in `test/e2e/`. See `test/AGENTS.md` for the base test stack (Mocha TDD style).

---

## 🚨 CRITICAL: NEVER Reimplement Production Code 🚨

**E2E tests must invoke the actual code path, NOT duplicate it.**

### ❌ WRONG: Duplicating Production Logic

```typescript
// Not an E2E test — this reimplements BundleScopeCommands.moveToUser()
test('migrates bundle from repository to user scope', async () => {
  const scopeConflictResolver = new ScopeConflictResolver(storage);

  const result = await scopeConflictResolver.migrateBundle(
    bundleId,
    'repository',
    'user',
    async () => { await registryManager.uninstallBundle(bundleId, 'repository'); },
    async (bundle, scope) => { await registryManager.installBundle(bundleId, { scope, version: bundle.version }); }
  );

  assert.ok(result.success);
});
```

**Why this is wrong:**
1. If production has a bug (e.g., wrong scope param), the test has the same bug
2. If production changes, the test doesn't catch regressions
3. The test doesn't verify command wiring in `extension.ts`
4. You're testing your test code, not production code

### ✅ CORRECT: Test Through Actual Entry Points

**Option 1: Real VS Code extension host (`test/suite/*.test.ts`, run via `npm run test:integration`)**

```typescript
test('migrates bundle via moveToUser command', async () => {
  // Setup: Install at repository scope
  await vscode.commands.executeCommand('promptRegistry.installBundle', bundleId, {
    scope: 'repository', version: '1.0.0',
  });

  // Act: execute the actual VS Code command
  await vscode.commands.executeCommand('promptRegistry.moveToUser', bundleId);

  // Assert: verify end state
  const userBundles = await storage.getInstalledBundles('user');
  assert.ok(userBundles.some(b => b.bundleId === bundleId));
});
```

**Option 2: Call the command handler class directly (when VS Code host isn't available)**

```typescript
const bundleScopeCommands = new BundleScopeCommands(
  registryManager,
  scopeConflictResolver,
  repositoryScopeService
);

await bundleScopeCommands.moveToUser(bundleId);

const userBundles = await storage.getInstalledBundles('user');
assert.ok(userBundles.some(b => b.bundleId === bundleId));
```

---

## Test Structure

```
test/e2e/
├── AGENTS.md                              # This guide
├── complete-workflow.test.ts              # General workflow tests
├── bundle-update-awesome-copilot.test.ts  # Awesome Copilot update workflow
└── bundle-update-github.test.ts           # GitHub bundle update workflow
```

Tests use Mocha TDD (`suite` / `test` / `assert`) — same as unit tests. VS Code is mocked via `test/mocha.setup.js`.

## Test Context Setup

```typescript
import * as assert from 'node:assert';
import { createE2ETestContext, E2ETestContext, generateTestId } from '../helpers/e2e-test-helpers';
import {
  setupReleaseMocks,
  createMockGitHubSource,
  cleanupReleaseMocks,
  RepositoryTestConfig,
} from '../helpers/repository-fixture-helpers';

suite('E2E: My Feature Tests', () => {
  let testContext: E2ETestContext;
  let testId: string;

  setup(async function () {
    this.timeout(30_000);
    testId = generateTestId('my-feature');
    testContext = await createE2ETestContext();
  });

  teardown(async function () {
    this.timeout(10_000);
    await testContext.cleanup();
    cleanupReleaseMocks();
  });
});
```

## Shared Repository Fixtures

```typescript
import {
  setupReleaseMocks,
  createMockGitHubSource,
  cleanupReleaseMocks,
  RepositoryTestConfig,
  ReleaseConfig,
} from '../helpers/repository-fixture-helpers';

const config: RepositoryTestConfig = {
  owner: 'test-owner',
  repo: 'test-repo',
  manifestId: 'test-bundle',
};

const releases: ReleaseConfig[] = [
  { tag: 'v1.0.0', version: '1.0.0', content: 'initial' },
  { tag: 'v2.0.0', version: '2.0.0', content: 'updated' },
];

setupReleaseMocks(config, releases);
const source = createMockGitHubSource('test-source', config);
```

## HTTP Mocking with nock

```typescript
import nock from 'nock';

// Use persist() for mocks called multiple times
nock('https://api.github.com')
  .persist()
  .get('/repos/owner/repo/contents/collections?ref=main')
  .reply(200, [{ name: 'file.yml', type: 'file' }]);

// Include query strings directly in the path (not .query())
nock('https://raw.githubusercontent.com')
  .persist()
  .get('/owner/repo/main/path/to/file.yml')
  .reply(200, fileContent);
```

### Clear Mocks Between Phases

```typescript
// Phase 1: initial state
nock('https://api.github.com').persist()
  .get('/repos/owner/repo/contents?ref=main')
  .reply(200, initialContent);

// ... initial operations ...

// Phase 2: updated state
nock.cleanAll();
nock.disableNetConnect();

nock('https://api.github.com').persist()
  .get('/repos/owner/repo/contents?ref=main')
  .reply(200, updatedContent);
```

## Authentication Handling

Stub VS Code auth so no real tokens are used:

```typescript
import * as sinon from 'sinon';
import * as vscode from 'vscode';

let sandbox: sinon.SinonSandbox;

setup(async () => {
  sandbox = sinon.createSandbox();

  if (vscode.authentication && typeof vscode.authentication.getSession === 'function') {
    sandbox.stub(vscode.authentication, 'getSession').resolves(undefined);
  }

  const childProcess = require('child_process');
  sandbox.stub(childProcess, 'exec').callsFake((...args: unknown[]) => {
    const cmd = args[0] as string;
    const callback = args[args.length - 1] as Function;
    if (cmd === 'gh auth token') {
      callback(new Error('gh not available'), '', '');
    } else {
      callback(null, '', '');
    }
  });
});

teardown(() => { sandbox.restore(); });
```

## Adapter Cache Handling

`AwesomeCopilotAdapter` caches bundles for 5 minutes. Clear it when simulating content changes:

```typescript
const adapters = (testContext.registryManager as any).adapters;
for (const [, adapter] of adapters) {
  if (adapter.collectionsCache) {
    adapter.collectionsCache.clear();
  }
}
```

## Common Patterns

### Awesome Copilot Updates (auto-update on source sync)

```typescript
await testContext.registryManager.addSource(source);
await testContext.registryManager.syncSource(sourceId);

const bundles = await testContext.registryManager.searchBundles({ sourceId });
await testContext.registryManager.installBundle(bundles[0].id, { scope: 'user' });

nock.cleanAll();
clearAdapterCache();
setupUpdatedMocks();

await testContext.registryManager.syncSource(sourceId); // triggers auto-update

const installed = await testContext.registryManager.listInstalledBundles();
assert.strictEqual(installed[0].version, updatedVersion);
```

### GitHub Bundle Updates (explicit version management)

```typescript
await testContext.registryManager.installBundle(bundleId, {
  scope: 'user',
  version: '1.0.0',
});

const updates = await testContext.registryManager.checkUpdates();
await testContext.registryManager.updateBundle(bundleId);

const installed = await testContext.registryManager.listInstalledBundles();
assert.strictEqual(installed[0].version, '2.0.0');
```

## Known Issues and Workarounds

### Copilot Sync Errors

Errors like `Failed to create Copilot file: /path/to/prompts/file.md` are expected in test environments where the Copilot directory doesn't exist. They don't affect test results.

### BundleId Differences

- **Awesome Copilot**: `bundleId = collection-name` (no version)
- **GitHub**: `bundleId = owner-repo-version` (includes version)

This affects how installation records are managed during updates.

## Timeouts

Mocha timeouts are set via `this.timeout(ms)` inside the test/setup:

```typescript
test('my long test', async function () {
  this.timeout(60_000);
  // ... network operations ...
});
```

## Debugging

```bash
LOG_LEVEL=DEBUG npm run test:one -- test/e2e/my-test.ts
```

- Check `nock.pendingMocks()` to spot missing mocks
- Assert `nock.isDone()` to verify mocks were called
- Use `tee` + `grep` for targeted analysis:
  `LOG_LEVEL=DEBUG npm run test:one -- test/e2e/my-test.ts 2>&1 | tee debug.log | grep methodName`

---

## Debugging E2E Failures

### Fault Isolation

1. Parse the error first: `expected X, got Y` — does `Y` show a transformation?
2. Transformations (e.g., `v1.0.0` → `1.0.0`) usually indicate production-code bugs, not test fixtures
3. Trace data flow with `LOG_LEVEL=DEBUG`

### Common Pitfalls

| Symptom | Likely Cause | Solution |
|---------|--------------|----------|
| Bundle ID mismatch | Inconsistent ID construction in `RegistryManager` | Check `applyVersionOverride` and `updateBundle` paths |
| "Bundle not found" | Version consolidation returns only latest | Use `version` option in `installBundle` |
| Update fails after install | Install/update use different ID formats | Verify both paths use same ID format |

### Version-Specific Installation

```typescript
// ❌ May install latest due to version consolidation
await registryManager.installBundle('owner-repo-v1.0.0', { scope: 'user' });

// ✅ Explicitly request specific version
await registryManager.installBundle('owner-repo-v1.0.0', {
  scope: 'user',
  version: '1.0.0',
});
```

### Bundle ID Format

GitHub bundle IDs follow `owner-repo-tag` with `v`-prefixed tag (e.g., `owner-repo-v1.0.0`). If you see mismatches:
1. `VersionConsolidator.toBundleVersion()` — stores `bundleId` per version
2. `RegistryManager.applyVersionOverride()` — must use stored `bundleId`, not reconstruct
3. Verify adapter creates IDs consistent with manifest format

### Adding Debug Logging

```typescript
this.logger.debug(`[methodName] Input: ${JSON.stringify(input)}`);
this.logger.debug(`[methodName] Output: ${JSON.stringify(output)}`);
```

Run: `LOG_LEVEL=DEBUG npm run test:one -- test/e2e/my-test.ts 2>&1 | grep methodName`
