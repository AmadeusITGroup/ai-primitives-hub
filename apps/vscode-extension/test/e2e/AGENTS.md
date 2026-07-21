# Extension E2E Tests

E2E tests in this folder run through the Node test harness with a mocked VS Code API. They verify multi-component, user-visible workflows; real extension-host integration tests belong in `test/suite/`.

## Essential Rule

Exercise production entry points. Call a command handler directly when the extension host is unnecessary, or use `vscode.commands.executeCommand()` in `test/suite/`. Never reproduce service or command logic inside a test.

```typescript
await bundleScopeCommands.moveToUser(bundleId);
const userBundles = await storage.getInstalledBundles('user');
assert.ok(userBundles.some(bundle => bundle.bundleId === bundleId));
```

## Setup Pattern

Use `createE2ETestContext()` and `generateTestId()` from `test/helpers/e2e-test-helpers.ts`; clean the context and HTTP mocks in teardown.

```typescript
setup(async () => {
  testContext = await createE2ETestContext();
});

teardown(async () => {
  await testContext.cleanup();
  cleanupReleaseMocks();
});
```

Use `setupReleaseMocks()` and `createMockGitHubSource()` from `repository-fixture-helpers.ts` for source fixtures. Disable real networking, clear nock between state phases, and use `.persist()` only for intentionally repeated calls.

## Source-Specific Behavior

- Clear adapter caches through their public `clearCache()` or `clearManifestCache()` methods when simulating changed remote content.
- Awesome Copilot bundle IDs are collection names; GitHub IDs include the owner, repository, and version tag. Pass an explicit `version` to `installBundle()` when testing a non-latest GitHub release.
- Copilot-sync file-creation errors can be expected when the test environment lacks a Copilot directory; assert the workflow result rather than that environment artifact.

## Commands

Run from `apps/vscode-extension/`:

```bash
pnpm run test:one -- test/e2e/complete-workflow.test.ts
pnpm run test:integration
LOG_LEVEL=DEBUG pnpm run test:one -- test/e2e/complete-workflow.test.ts
```

## Failure Triage

- Use `nock.pendingMocks()` and `nock.isDone()` to diagnose HTTP setup.
- When an assertion returns a transformed input, trace `RegistryManager`, version consolidation, and command paths before changing fixtures.
- Set Mocha timeouts with `this.timeout(ms)` only for the affected setup or test.
