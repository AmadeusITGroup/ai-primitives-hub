# Extension Tests

Use Mocha TDD style (`suite`, `test`, `assert`) for every extension test. Tests compile to `test-dist/` before execution.

## Locations

| Type | Location | Runtime |
|---|---|---|
| Unit | `test/{services,adapters,commands,ui,utils,storage}/` | Node with mocked VS Code |
| Property | `test/**/*.property.test.ts` | Node with `fast-check` |
| E2E | `test/e2e/` | Node with mocked VS Code |
| Integration | `test/suite/` | Real VS Code extension host |

Run these commands from `apps/vscode-extension/`:

```bash
pnpm run compile-tests
LOG_LEVEL=ERROR pnpm run test:unit
pnpm run test:integration
pnpm run test:one -- test/services/telemetry-service.test.ts
pnpm run test:coverage:unit
```

## Test Design

- Test public behavior: return values, visible side effects, and errors. Do not test private methods, operation order, or internal call counts.
- Mock only external boundaries: HTTP with `nock`, file system, and VS Code APIs. Use real instances of the class under test.
- Search the relevant test directory and `test/helpers/` first; extend an existing test file when it covers the same behavior.
- A class can have one example test file and one property test file. Keep specific cases and invariants non-overlapping.
- Use `*.test.ts` and `*.property.test.ts`; do not create `.fix.test.ts` or `.bugfix.test.ts` files.

## Fixtures and Mocks

- `test/mocha.setup.js` loads `test/vscode-mock.js`. Add a missing VS Code API there, then stub the loaded mock with Sinon per test.
- Use `test/helpers/bundle-test-helpers.ts`, `repository-fixture-helpers.ts`, `lockfile-test-helpers.ts`, and `property-test-helpers.ts` before creating a helper.
- Clean nock state in teardown with `nock.cleanAll()` and assert `nock.isDone()` when requests are part of the behavior.
- Keep reusable data in `test/fixtures/`; do not construct a fixture format already present there.

## Choose the Right Layer

- Put pure business logic and data transformations in unit tests.
- Use property tests for broad invariants such as format, idempotence, or ordering guarantees.
- Put command wiring, activation, TreeView, WebView, or QuickPick behavior in `test/suite/` when a mocked setup would be substantial.
- E2E tests must exercise a command handler or actual VS Code command; see [E2E guidance](e2e/AGENTS.md).

## Completion

For a behavior change: create a focused failing test, run it, implement the smallest fix, rerun it, then compile and run related tests. When failures transform supplied input, trace the production path before changing fixtures.
