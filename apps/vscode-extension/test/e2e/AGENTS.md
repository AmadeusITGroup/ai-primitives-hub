# E2E Test Writing Guide

Patterns for End-to-End tests in `test/e2e/`. See [`../AGENTS.md`](../AGENTS.md) for the base test stack (Mocha TDD style, commands, helpers).

---

## 🚨 CRITICAL: NEVER Reimplement Production Code 🚨

**E2E tests must invoke the actual code path, NOT duplicate it.**

### ❌ WRONG: Duplicating Production Logic

```typescript
// Not an E2E test — this reimplements BundleScopeCommands.moveToUser()
test('migrates bundle from repository to user scope', async () => {
  const scopeConflictResolver = new ScopeConflictResolver(storage);
  const result = await scopeConflictResolver.migrateBundle(
    bundleId, 'repository', 'user',
    async () => { await registryManager.uninstallBundle(bundleId, 'repository'); },
    async (bundle, scope) => { await registryManager.installBundle(bundleId, { scope, version: bundle.version }); }
  );
  assert.ok(result.success);
});
```

This tests the test, not the extension. If production has a bug, the test has the same bug.

### ✅ CORRECT: Test Through Actual Entry Points

**Option 1: Real VS Code extension host (`test/suite/*.test.ts`)**

```typescript
test('migrates bundle via moveToUser command', async () => {
  await vscode.commands.executeCommand('promptRegistry.installBundle', bundleId, {
    scope: 'repository', version: '1.0.0',
  });
  await vscode.commands.executeCommand('promptRegistry.moveToUser', bundleId);
  const userBundles = await storage.getInstalledBundles('user');
  assert.ok(userBundles.some(b => b.bundleId === bundleId));
});
```

**Option 2: Command handler class directly (preferred for `test/e2e/`)**

```typescript
const bundleScopeCommands = new BundleScopeCommands(
  registryManager, scopeConflictResolver, repositoryScopeService
);
await bundleScopeCommands.moveToUser(bundleId);
const userBundles = await storage.getInstalledBundles('user');
assert.ok(userBundles.some(b => b.bundleId === bundleId));
```

---

## Test Context Setup

```typescript
import * as assert from 'node:assert';
import { createE2ETestContext, E2ETestContext, generateTestId } from '../helpers/e2e-test-helpers';
import {
  setupReleaseMocks, createMockGitHubSource, cleanupReleaseMocks,
  RepositoryTestConfig, ReleaseConfig,
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

---

## Shared Repository Fixtures

```typescript
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

---

## HTTP Mocking (nock)

```typescript
import nock from 'nock';

// Use persist() for mocks called multiple times
nock('https://api.github.com')
  .persist()
  .get('/repos/owner/repo/releases')
  .reply(200, mockData);

// Include query strings in the path directly (not via .query())
nock('https://raw.githubusercontent.com')
  .persist()
  .get('/owner/repo/main/path/to/file.yml')
  .reply(200, fileContent);
```

### Clear Mocks Between Phases

```typescript
// Phase 1: initial state
nock('https://api.github.com').persist().get('/repos/owner/repo/contents?ref=main').reply(200, initialContent);
// ... initial operations ...

// Phase 2: updated state — clear all first
nock.cleanAll();
nock.disableNetConnect();
nock('https://api.github.com').persist().get('/repos/owner/repo/contents?ref=main').reply(200, updatedContent);
```

Always `nock.cleanAll()` in `teardown`.

---

## Authentication Handling

Stub VS Code auth so no real tokens are used:

```typescript
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

---

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

---

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
// ✅ Always pass version explicitly — version consolidation may return only latest
await testContext.registryManager.installBundle(bundleId, { scope: 'user', version: '1.0.0' });

const updates = await testContext.registryManager.checkUpdates();
await testContext.registryManager.updateBundle(bundleId);

const installed = await testContext.registryManager.listInstalledBundles();
assert.strictEqual(installed[0].version, '2.0.0');
```

---

## Timeouts

```typescript
test('my long test', async function () {
  this.timeout(60_000);
  // ... network operations ...
});
```

---

## Debugging E2E Failures

```bash
LOG_LEVEL=DEBUG npm run test:one -- test/e2e/my-test.ts
LOG_LEVEL=DEBUG npm run test:one -- test/e2e/my-test.ts 2>&1 | tee debug.log | grep methodName
```

- Check `nock.pendingMocks()` to spot missing mocks; assert `nock.isDone()` to verify mocks were called
- Errors like `Failed to create Copilot file: ...` are expected in test environments — they don't affect results

### Common Pitfalls

| Symptom | Likely Cause | Solution |
|---------|--------------|----------|
| Bundle ID mismatch | Inconsistent ID construction in `RegistryManager` | Check `applyVersionOverride` and `updateBundle` paths |
| "Bundle not found" | Version consolidation returns only latest | Use `version` option in `installBundle` |
| Update fails after install | Install/update use different ID formats | Verify both paths use same ID format |

### Bundle ID Format

GitHub bundle IDs follow `owner-repo-tag` with `v`-prefixed tag (e.g., `owner-repo-v1.0.0`):
- `VersionConsolidator.toBundleVersion()` — stores `bundleId` per version
- `RegistryManager.applyVersionOverride()` — must use stored `bundleId`, not reconstruct
- Awesome Copilot: `bundleId = collection-name` (no version)
