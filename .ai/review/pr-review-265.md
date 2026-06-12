# PR Review: #265 — perf: improve test speed and add IDE tsconfig

**PR**: https://github.com/AmadeusITGroup/prompt-registry/pull/265  
**Author**: gblanc-1a  
**Base**: main ← fix/test-improvements  
**Stats**: +311/−689 across 7 files (5 test files, 2 config files)  
**Review Date**: 2026-05-21

---

## Executive Summary

Clean performance-focused PR that improves test execution speed through three strategies: (1) hoisting expensive operations to suite-level, (2) replacing real timers with fake timers, and (3) eliminating implicit network dependencies. No production code is modified.

**No blocking issues found.** 5 minor findings and 4 suggestions, most relating to pattern consistency and documentation gaps. 2 pre-existing issues surfaced during review.

| Criticality | Count |
|-------------|-------|
| 🔴 Critical | 0 |
| 🟠 Major | 0 |
| 🟡 Minor | 5 |
| 🟢 Suggestion | 4 |
| Pre-existing | 2 |

---

## Blocking Issues

None. This PR is safe to merge.

---

## Risk Assessment & Manual Testing Guidance

### Blast Radius

🔵 **Isolated** — All changes confined to test files and IDE config files. Zero production code modified. No shared test helpers modified (only consumed).

### High-Risk Areas

| Area | Risk | Why | Files |
|------|------|-----|-------|
| Property test stub isolation | 🟡 Low | Shared sandbox approach works due to fresh adapter instances per iteration and `stubHttpsWithResponse` reuse logic | `github-adapter.property.test.ts` |
| E2E shared project state | 🟡 Low | Scripts are read-only except build (outputs to cleaned `dist/`). Git state is stable | `github-scaffold-integration.test.ts` |
| Fake timers coverage | 🟡 Low | `simulateDebouncedRefresh` uses only `setTimeout` — fully covered | `ui-source-sync-refresh.test.ts` |

### Manual Testing Recommendations

- **Automated coverage sufficient**: Yes
- **Manual testing required**: No
- **Non-regression scope**: None

| # | Scenario | Priority | Why |
|---|----------|----------|-----|
| 1 | Run full property test suite | 🟠 Should-test | Verify no stub leakage across iterations |
| 2 | Confirm IDE resolution in test files (open in VS Code, check no red squiggles) | 🟡 Nice-to-test | Validate tsconfig additions work as intended |

---

## Non-Blocking Findings

### 🟡 Minor

#### 1. Inconsistent per-iteration isolation strategy across property test files
**Category**: Architecture  
**File(s)**: `test/services/repository-activation-service.property.test.ts`, `test/adapters/github-adapter.property.test.ts`  
**Description**: Two different iteration-reset strategies introduced in the same PR: explicit `resetStubs()` helper (repository-activation) vs overwrite-style stubs on shared sandbox (github-adapter). Future contributors won't know which pattern to follow.  
**Recommendation**: Add a brief note in `property-test-helpers.ts` documenting the recommended pattern. The `resetStubs()` approach is more explicit and safer.

#### 2. E2E shared directory — no guard against cross-test file leaks outside `dist/`
**Category**: QA / Functional  
**File(s)**: `test/e2e/github-scaffold-integration.test.ts` (lines 398–414)  
**Description**: `setup()` only cleans `dist/`. If a future test writes outside `dist/` (cache files, lock files), the next test may see stale state. Also, `compute-collection-version` depends on stable git state — safe now but implicit.  
**Recommendation**: Add a comment noting the invariant: "Tests in this suite must only write to dist/ — add cleanup here if that changes."

#### 3. APM "should not execute arbitrary code from manifest" — assertion proves parsing, not non-execution
**Category**: Functional  
**File(s)**: `test/adapters/apm-adapter.test.ts` (lines 356–375)  
**Description**: Test name promises "should not execute arbitrary code" but assertions only verify `bundles.length === 1` and `bundles[0].name === 'malicious'`. This proves YAML was parsed as data — not that scripts weren't executed.  
**Recommendation**: Add `const execSpy = sandbox.spy(childProcess, 'execSync')` and assert it was never called. Low priority since the adapter has no script-execution code path.

#### 4. IDE tsconfig `types` restriction more restrictive than build config
**Category**: Architecture  
**File(s)**: `lib/test/tsconfig.json`  
**Description**: Adds `"types": ["node", "mocha"]` which restricts available type declarations. If lib test files use other `@types/*` packages, the IDE will show squiggles that don't match the build.  
**Recommendation**: Verify these are the only type packages lib tests actually use. If so, the restriction is correct and explicit.

#### 5. Property 15 hoists auth stubs outside `fc.assert()` — different pattern from siblings
**Category**: Functional / Architecture  
**File(s)**: `test/adapters/github-adapter.property.test.ts` (lines ~544–555)  
**Description**: `vscode.authentication.getSession` and `childProcess.exec` stubs are set once before `fc.assert()`, unlike other properties that set stubs per-iteration. Correct for this test (all iterations need auth to fail) but inconsistent.  
**Recommendation**: Add a comment: `// Shared across all iterations — these never vary per property input`

### 🟢 Suggestion

#### 6. Skipped Property 1 retains old `iterationSandbox` pattern
**Category**: QA / Tech Debt  
**File(s)**: `test/adapters/github-adapter.property.test.ts` (lines ~111–203)  
**Description**: Skipped test still uses `iterationSandbox = sinon.createSandbox()` per-iteration. Inconsistent with the migrated tests in the same file.  
**Recommendation**: Migrate to new pattern or add `// TODO: migrate to suite-level sandbox pattern when unblocked`.

#### 7. Caching test asserts on private method call count
**Category**: QA  
**File(s)**: `test/adapters/apm-adapter.test.ts` (line 244)  
**Description**: `assert.strictEqual(httpsGetStub.callCount, 1, ...)` asserts on internal call count. Valuable for verifying cache semantics but will break if caching implementation changes.  
**Recommendation**: Acceptable trade-off. Keep as-is.

#### 8. `resetStubs()` clearing behavior silently
**Category**: QA  
**File(s)**: `test/services/repository-activation-service.property.test.ts` (line 72)  
**Description**: `.reset()` clears both history and configured behavior. Safe because all iterations re-configure stubs, but not obvious to future maintainers.  
**Recommendation**: Add comment: `// Resets call history AND configured behavior — each iteration must re-configure stubs`

#### 9. Tautological debounce delay test
**Category**: Tech Debt (pre-existing)  
**File(s)**: `test/ui/ui-source-sync-refresh.test.ts` (line ~83)  
**Description**: `assert.strictEqual(EXPECTED_DEBOUNCE_MS, 500)` compares a constant to itself. Zero regression coverage.  
**Recommendation**: Make it read the debounce value from production code, or remove it.

---

## Pre-existing Issues

| # | Finding | Category | File(s) |
|---|---------|----------|---------|
| 1 | Private method stubbing via `(adapter as any).httpsGet` couples tests to implementation. If method is renamed, tests break silently at runtime. | QA/Tech Debt | `test/adapters/apm-adapter.test.ts` |
| 2 | Hardcoded `{ numRuns: 100 }` in 5+ other property test files not migrated to `PropertyTestConfig` | Tech Debt | Various property test files |

---

## Positive Highlights

- **Fake timers conversion** is textbook — `simulateDebouncedRefresh` uses only `setTimeout`/`clearTimeout`, making `clock.tick()` a perfect fit. Eliminates flakiness.
- **ApmAdapter tests now deterministic** — explicit stubs replacing implicit network failure dependency. Tests document intent clearly.
- **E2E `suiteSetup()`** is the correct call — scaffolding and `npm install` are constant operations, no reason to repeat per-test. The `--prefer-offline` flag is a nice touch.
- **`resetStubs()` pattern** is clean and well-documented with JSDoc comments explaining scope.
- **Stronger assertions added** — security test now verifies parsed data, error handling asserts on array length, cache test asserts on call count. All net coverage improvements.
- **Net -378 lines** — less code, same or better coverage intent.

---

## Testing Verdict

| Criterion | Assessment |
|-----------|-----------|
| Automated coverage sufficient | ✅ Yes |
| Manual testing required | ❌ No |
| Non-regression scope | None |
