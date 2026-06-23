# Test Writing Guide

Detailed patterns for tests in `apps/vscode-extension/test/`. See the parent [`../AGENTS.md`](../AGENTS.md) for the full overview (commands, test layout, helpers, nock, Mocha template, gotchas).

---

## 🚨 MANDATORY: Test Behavior, Not Implementation 🚨

**Tests MUST verify expected behavior through public entry points, NEVER implementation details.**

| ✅ DO | ❌ DON'T |
|-------|----------|
| Test public methods and their observable outcomes | Test private methods or internal state |
| Assert on return values, side effects, and thrown errors | Assert on how internal code paths execute |
| Mock external boundaries (HTTP, file system, VS Code API) | Mock internal collaborators within the same module |
| Write tests that survive refactoring | Write tests that break when internals change |

**Red flags (test is coupled to implementation):**
- Spying on private methods (`_methodName`)
- Asserting on call counts of internal methods
- Testing the order of internal operations
- Mocking classes that are internal to the module under test
- Test breaks when you refactor without changing behavior

---

## Discovery First (CRITICAL)

**Check existing patterns BEFORE writing tests.**

```bash
ls test/services/   # or adapters/, commands/, ui/
cat test/helpers/bundle-test-helpers.ts
cat test/helpers/property-test-helpers.ts
grep -r "behavior you want to test" test/ --include="*.test.ts" | head -10
```

If a helper exists, **USE IT**. Don't recreate. If tests exist, **add to that file** — don't create new files.

---

## Helper APIs (`test/helpers/`)

### `bundle-test-helpers.ts`

```typescript
import {
  BundleBuilder,                // Fluent builder for Bundle
  createMockInstalledBundle,    // Factory for InstalledBundle
  createMockUpdateCheckResult,
} from '../helpers/bundle-test-helpers';

const bundle = BundleBuilder.github('owner', 'repo').withVersion('1.0.0').build();
const installed = createMockInstalledBundle('bundle-id', '1.0.0');
```

### `lockfile-test-helpers.ts`

```typescript
import {
  LockfileBuilder,
  createMockLockfile,
  LockfileGenerators,
} from '../helpers/lockfile-test-helpers';
```

### `repository-fixture-helpers.ts`

```typescript
import {
  setupReleaseMocks,
  createBundleZip,
  createDeploymentManifest,
  createMockGitHubSource,
  cleanupReleaseMocks,
  RepositoryTestConfig,
  ReleaseConfig,
} from '../helpers/repository-fixture-helpers';

setupReleaseMocks(
  { owner: 'test-owner', repo: 'test-repo', manifestId: 'test-bundle' },
  [{ tag: 'v1.0.0', version: '1.0.0', content: 'initial' }]
);
```

### `property-test-helpers.ts`

```typescript
import { BundleGenerators, PropertyTestConfig, ErrorCheckers } from '../helpers/property-test-helpers';
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

## Anti-Patterns

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

### Mocking Anti-Patterns

❌ Over-mocking: `sandbox.createStubInstance(MyService)` for the class under test  
✅ Real instances: `new MyService(mockContext)` + stub external boundaries only

❌ Duplicating utilities when helpers exist in `test/helpers/`  
✅ Import from `test/helpers/`

❌ Repeatedly modifying test fixtures when tests fail  
✅ First read the error message carefully — if output shows data transformation, the bug is in production code

---

## Debugging Test Failures

### Determine Fault Location First

1. **Parse the error**: `expected X, got Y` — where does `Y` come from?
2. **If `Y` is a transformation of input** (e.g., `v1.0.0` → `1.0.0`), the bug is likely in production code
3. **Add debug logging**: `LOG_LEVEL=DEBUG` + temporary logs to trace data flow
4. **Check multiple code paths**: different methods may handle the same data differently

```bash
LOG_LEVEL=DEBUG npm run test:one -- test/path/to/test.ts 2>&1 | grep -E "(keyword1|keyword2)" | head -30
LOG_LEVEL=DEBUG npm run test:one -- test/path/to/test.ts 2>&1 | tee debug.log | tail -50
```

| Symptom | Likely Cause |
|---------|--------------|
| ID mismatch errors | Inconsistent ID construction across code paths |
| "Not found" after successful creation | Version consolidation hiding older versions |
| Different behavior in similar operations | Multiple code paths with different logic |

---

## Naming

- **Files**: `component.test.ts`, `component.property.test.ts`
- **Never**: `.fix.test.ts`, `.bugfix.test.ts`
- **Suite descriptions**: `'finds bundle via identity matching'`
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

## Test Completion Criteria

Before marking any test task complete:

1. **Compilation**: `npm run compile-tests` — no TypeScript errors
2. **Mock setup**: No `Property 'X' is private` errors, no type mismatches
3. **Execution**: Tests are runnable (assertion failures acceptable in RED phase)
4. **RED phase (TDD)**: Tests fail for the right reason (missing impl), not broken mocks or imports

**Your responsibility**: mock setup, type errors, compilation, import errors from your changes.  
**Not your responsibility**: pre-existing failures, flaky tests, infrastructure issues.

---

## Checklist

- [ ] Tests verify behavior through public entry points, NOT implementation details
- [ ] Checked `test/helpers/` for existing utilities
- [ ] Searched for existing tests covering this behavior
- [ ] Test file count for this class ≤ 2 (unit + property only)
- [ ] Unit and property tests cover DIFFERENT concerns
- [ ] E2E tests use command handler classes or actual entry points (see `test/e2e/AGENTS.md`)
- [ ] Integration tests in `test/suite/` use real VS Code commands
- [ ] Mocha TDD style (`suite`, `test`, `assert`) throughout
- [ ] Mocking only external boundaries (HTTP, file system, VS Code API)
