# Test Writing Guide for AI Agents

Efficient test writing patterns for this repository.

---

## 🚨 MANDATORY: Test Behavior, Not Implementation 🚨

**Tests MUST verify expected behavior through public entry points, NEVER implementation details.**

| ✅ DO | ❌ DON'T |
|-------|----------|
| Test public methods and their observable outcomes | Test private methods or internal state |
| Assert on return values, side effects, and thrown errors | Assert on how internal code paths execute |
| Mock external boundaries (HTTP, file system, VS Code API) | Mock internal collaborators within the same module |
| Write tests that survive refactoring | Write tests that break when internals change |

### Red Flags (test is coupled to implementation)

- Spying on private methods (`_methodName`)
- Asserting on call counts of internal methods
- Testing the order of internal operations
- Mocking classes that are internal to the module under test
- Test breaks when you refactor without changing behavior

---

## Test Stack

This repo uses **Mocha TDD style** (`suite` / `test` / `assert`) for **all** tests — unit, property, e2e, and suite. There is no Vitest, no Playwright suite.

| Test Type | Location | Runs In | Purpose |
|-----------|----------|---------|---------|
| Unit | `test/{services,adapters,commands,ui,utils,storage}/*.test.ts` | Node with `test/mocha.setup.js` mocking `vscode` | Individual classes/methods |
| Property | `test/**/*.property.test.ts` | Same as unit | Invariants via `fast-check` |
| E2E (mocked VS Code) | `test/e2e/*.test.ts` | Same as unit | Multi-component workflows |
| Integration (real VS Code) | `test/suite/*.test.ts` | Electron via `test/runExtensionTests.js` | Commands, activation, UI wiring |

Tests compile to `test-dist/` first (`npm run compile-tests`), then Mocha runs the compiled JS.

## Commands

```bash
# Compile + run all unit/property/e2e (excludes test/suite/)
LOG_LEVEL=ERROR npm run test:unit

# Compile + run everything (unit + integration in real VS Code)
LOG_LEVEL=ERROR npm test

# Integration tests only (real VS Code instance)
npm run test:integration

# Single file by path (auto-compiles)
npm run test:one -- test/services/bundle-installer.test.ts

# Coverage
npm run test:coverage          # all tests with c8
npm run test:coverage:unit     # unit only, c8 + html report

# Capture output once, analyze many times
LOG_LEVEL=ERROR npm run test:unit 2>&1 | tee test.log | tail -20
grep -E "passing|failing" test.log
```

---

## Discovery First (CRITICAL)

**Check existing patterns BEFORE writing tests.**

```bash
ls test/services/   # or adapters/, commands/, ui/
cat test/helpers/bundle-test-helpers.ts
cat test/helpers/property-test-helpers.ts
```

If a helper exists, **USE IT**. Don't recreate.

---

## 🚨 CRITICAL: Test Deduplication Rules 🚨

### One Class = Maximum Two Test Files

For any class `MyService`:
- `my-service.test.ts` — Unit tests (specific examples, edge cases)
- `my-service.property.test.ts` — Property tests (invariants across inputs)

**That's it. No more files.**

❌ **NEVER create:** `MyServiceBehaviorA.test.ts`, `MyServiceIntegration.test.ts`, `ExtensionMyServiceUsage.test.ts`

### Unit vs Property: No Overlap

| Unit Tests Cover | Property Tests Cover |
|------------------|---------------------|
| Specific input → specific output | Invariant holds for ALL inputs |
| Edge cases (null, empty, boundary) | Format/structure guarantees |
| Error messages and exceptions | Idempotence, commutativity |
| One example of each behavior | Statistical confidence across inputs |

**If you wrote a unit test for it, DON'T write a property test for the same thing.**

### E2E: Commands Only, Not Methods

E2E tests verify **user-facing commands**, not internal methods. See `test/e2e/AGENTS.md`.

### Before Writing Tests: Search First

```bash
grep -r "behavior you want to test" test/ --include="*.test.ts" | head -10
```

If tests exist, **add to that file** — don't create new files.

---

## Template (Mocha TDD — used for all tests)

```typescript
import * as assert from 'node:assert';
import * as sinon from 'sinon';
import {
  BundleBuilder,
  createMockInstalledBundle,
} from '../helpers/bundle-test-helpers';

suite('ComponentName', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('methodName()', () => {
    test('handles success case', async () => {
      // Arrange → Act → Assert
      assert.strictEqual(actual, expected);
    });
  });
});
```

> Integration tests in `test/suite/` use the **same** Mocha TDD style but run in a real VS Code extension host — inside them you can call `vscode.commands.executeCommand(...)` and activate the extension.

---

## Key Helpers (real exports, see each file for full API)

### `test/helpers/bundle-test-helpers.ts`
```typescript
import {
  BundleBuilder,                // Fluent builder for Bundle
  createMockInstalledBundle,    // Factory for InstalledBundle
  createMockUpdateCheckResult,
} from '../helpers/bundle-test-helpers';

const bundle = BundleBuilder.github('owner', 'repo').withVersion('1.0.0').build();
const installed = createMockInstalledBundle('bundle-id', '1.0.0');
```

### `test/helpers/lockfile-test-helpers.ts`
```typescript
import {
  LockfileBuilder,
  createMockLockfile,
  LockfileGenerators,
} from '../helpers/lockfile-test-helpers';
```

### `test/helpers/repository-fixture-helpers.ts`
```typescript
import {
  setupReleaseMocks,
  createBundleZip,
  createDeploymentManifest,
  createMockGitHubSource,
  cleanupReleaseMocks,
} from '../helpers/repository-fixture-helpers';

setupReleaseMocks(
  { owner: 'test-owner', repo: 'test-repo', manifestId: 'test-bundle' },
  [{ tag: 'v1.0.0', version: '1.0.0', content: 'initial' }]
);
```

### `test/helpers/property-test-helpers.ts`
```typescript
import {
  BundleGenerators,
  PropertyTestConfig,
  ErrorCheckers,
} from '../helpers/property-test-helpers';

import * as fc from 'fast-check';

await fc.assert(
  fc.asyncProperty(BundleGenerators.bundleId(), async (id) => true),
  { ...PropertyTestConfig.FAST_CHECK_OPTIONS, numRuns: PropertyTestConfig.RUNS.QUICK }
);
```

See also: `e2e-test-helpers.ts`, `auto-update-test-helpers.ts`, `marketplace-test-helpers.ts`, `ui-test-helpers.ts`, `process-test-helpers.ts`, `setup-state-test-helpers.ts`.

---

## VS Code Mocking

`test/mocha.setup.js` intercepts `require('vscode')` and loads `test/vscode-mock.js`. If you see `Cannot read properties of undefined` for a `vscode.*` API:

1. Check `test/vscode-mock.js` — add missing APIs there first
2. For per-test stubs, use sinon against the already-loaded mock

```typescript
const mockContext: any = {
  globalState: {
    get: (key: string, def: any) => globalStateData.get(key) ?? def,
    update: async (key: string, val: any) => { globalStateData.set(key, val); },
    keys: () => Array.from(globalStateData.keys()),
    setKeysForSync: sandbox.stub(),
  },
  globalStorageUri: { fsPath: '/mock/storage' },
};
```

---

## HTTP Mocking (nock)

```typescript
import nock from 'nock';

nock('https://api.github.com')
  .get('/repos/owner/repo/releases')
  .reply(200, mockData);

teardown(() => { nock.cleanAll(); });
```

---

## Anti-Patterns

### E2E: Never Reimplement Production Code
See `test/e2e/AGENTS.md` for details. E2E tests must invoke actual code paths through VS Code commands or command handler classes, never duplicate production logic.

### When to Prefer `test/suite/` (Real VS Code)

**Before writing complex mock setups, ask: would this be simpler in a real VS Code instance?**

| Scenario | Recommendation |
|----------|----------------|
| Testing `vscode.commands.executeCommand` | ✅ `test/suite/` |
| Testing TreeView, WebView, QuickPick interactions | ✅ `test/suite/` |
| Testing activation lifecycle | ✅ `test/suite/` |
| Pure business logic, no VS Code | ✅ Unit test with mock |
| HTTP / data transform | ✅ Unit test with nock |

**Red flags that you need real VS Code:** mock setup > 50 lines, mocking 5+ VS Code APIs, test duplicates production logic to simulate VS Code behavior.

### Other Anti-Patterns

❌ Over-mocking: `sandbox.createStubInstance(MyService)` for the class under test
✅ Real instances: `new MyService(mockContext)` + stub external boundaries only

❌ Duplicating utilities when helpers exist in `test/helpers/`
✅ Import from `test/helpers/`

❌ Repeatedly modifying test fixtures when tests fail
✅ First read the error message carefully — if output shows data transformation, the bug is in production code

---

## Debugging Test Failures

### Determine Fault Location First

Before iterating on fixes, decide: bug in **test code** or **production code**?

1. **Parse the error**: `expected X, got Y` — where does `Y` come from?
2. **If `Y` is a transformation of input** (e.g., `v1.0.0` → `1.0.0`), the bug is likely in production code
3. **Add debug logging to production code**: `LOG_LEVEL=DEBUG` + temporary logs to trace data flow
4. **Check multiple code paths**: different methods may handle the same data differently

### Debug Logging Strategy

```bash
LOG_LEVEL=DEBUG npm run test:one -- test/path/to/test.ts 2>&1 | grep -E "(keyword1|keyword2)" | head -30
LOG_LEVEL=DEBUG npm run test:one -- test/path/to/test.ts 2>&1 | tee debug.log | tail -50
```

### Common Root Causes

| Symptom | Likely Cause |
|---------|--------------|
| ID mismatch errors | Inconsistent ID construction across code paths |
| "Not found" after successful creation | Version consolidation hiding older versions |
| Different behavior in similar operations | Multiple code paths with different logic |

---

## Naming

- **Files**: `component.test.ts`, `component.property.test.ts`
- **Never**: `.fix.test.ts`, `.bugfix.test.ts`
- **Descriptions**: `'finds bundle via identity matching'`
- **Never**: `'should fix the bug'`

---

## Fixtures

```
test/fixtures/
├── local-library/      # Local bundles
├── github/             # GitHub API mocks
└── apm/                # APM registry mocks
```

```typescript
const response = require('../fixtures/github/releases-response.json');
```

---

## Checklist

- [ ] Tests verify behavior through public entry points, NOT implementation details
- [ ] Checked `test/helpers/` for existing utilities
- [ ] Searched for existing tests covering this behavior (`grep -r "behavior" test/`)
- [ ] Test file count for this class ≤ 2 (unit + property only)
- [ ] Unit and property tests cover DIFFERENT concerns
- [ ] E2E tests in `test/e2e/` use command handler classes or actual entry points
- [ ] Integration tests in `test/suite/` use real VS Code commands
- [ ] Mocha TDD style (`suite`, `test`, `assert`) throughout
- [ ] Mocking only external boundaries (HTTP, file system, VS Code API)

---

## Test Completion Criteria

Before marking any test-related task as complete, verify:

1. **Compilation**: Test files compile (`npm run compile-tests`) with no TS errors
2. **Mock setup**: No `Property 'X' is private` errors, no type mismatches
3. **Execution**: Tests are runnable (assertion failures are acceptable in RED phase)
4. **RED phase (for TDD)**: Tests fail for the RIGHT reason (missing impl), not broken mocks or imports

**If tests won't run due to setup issues YOU introduced, the task is incomplete.**

- **Your responsibility**: mock setup, type errors, compilation, import errors from your changes
- **Not your responsibility**: pre-existing failures, flaky tests, infrastructure issues
