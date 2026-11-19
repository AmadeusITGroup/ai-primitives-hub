# Dead-Code and Coverage Ratchets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent new dead code and package-level coverage regressions without forcing an up-front cleanup.

**Architecture:** Knip uses explicit workspace entry points and a committed baseline for current findings. Coverage producers normalize runner-specific output to `coverage-summary.json`; a small comparator enforces nondecreasing thresholds per package.

**Tech Stack:** Knip, Vitest V8 coverage, c8, Mocha, JSON coverage summaries.

## Global Constraints

- Depend on PR 5.
- Keep Knip and coverage outside `check:fast` and `check:affected`; run them in `check:all`.
- Baselines contain findings or numeric thresholds, never blanket source ignores.
- Coverage remains package-scoped.
- Extension integration coverage is informational; unit coverage is the deterministic gate.
- Split Knip and coverage into separate PRs if initial baseline review exceeds 500 lines.

---

## File Structure

- `knip.config.ts`: declares real entry points, projects, and generated outputs.
- `tooling-baselines/knip.json`: normalized current findings.
- `scripts/check-knip.mjs`: compares normalized Knip JSON against baseline.
- `tooling-baselines/coverage.json`: per-package line/function/branch/statement floors.
- `scripts/check-coverage.mjs`: normalizes summaries and compares floors.

### Task 1: Configure and baseline Knip

**Files:**
- Create: `knip.config.ts`
- Create: `scripts/check-knip.mjs`
- Create: `scripts/check-knip.test.mjs`
- Create: `tooling-baselines/knip.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `pnpm check:dead-code`; normalized finding keys `<workspace>:<type>:<file>:<symbol>`.

- [ ] **Step 1: Install Knip and configure real entry points**

Run: `pnpm add -Dw knip`

Configure package source indexes, CLI bins, extension `src/extension.ts`, webpack config, Docusaurus config, GitHub Action `src/index.js`, tests, and validation scripts. Exclude generated `dist`, `test-dist`, `website/build`, coverage, and VSIX output only.

- [ ] **Step 2: Test baseline comparison**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { newFindings } from './check-knip.mjs';

test('returns only findings absent from baseline', () => {
  assert.deepEqual(newFindings(['core:exports:a.ts:x', 'app:files:b.ts'], ['core:exports:a.ts:x']), ['app:files:b.ts']);
});
```

- [ ] **Step 3: Implement normalized comparison**

Run `knip --reporter json`, normalize and sort files, exports, types, dependencies, devDependencies, and binaries. Fail on additions and stale baseline entries; support `--write-baseline` only as an explicit maintenance command.

- [ ] **Step 4: Generate and review the baseline**

Run: `node scripts/check-knip.mjs --write-baseline && pnpm check:dead-code`

Expected: baseline contains each current finding individually; second command passes.

- [ ] **Step 5: Commit dead-code ratchet**

```bash
git add knip.config.ts scripts/check-knip.mjs scripts/check-knip.test.mjs tooling-baselines/knip.json package.json pnpm-lock.yaml
git commit -m "chore: ratchet workspace dead code"
```

### Task 2: Normalize package coverage outputs

**Files:**
- Modify: `packages/*/package.json`
- Modify: `lib/package.json`
- Modify: `apps/vscode-extension/package.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `<workspace>/coverage/coverage-summary.json` for deterministic unit suites.

- [ ] **Step 1: Configure Vitest summaries**

Set each package's coverage reporters to `text` and `json-summary`, preserving current provider `v8` and package-local output directories.

- [ ] **Step 2: Add c8 to lib and normalize Mocha**

Run: `pnpm -C lib add -D c8`

Set `test:coverage` to compile tests then run `c8 --reporter=text --reporter=json-summary mocha 'dist-test/test/**/*.test.js'`.

- [ ] **Step 3: Keep extension coverage deterministic**

Make `test:coverage:unit` emit `json-summary`; leave `test:coverage:integration` outside the threshold command.

- [ ] **Step 4: Generate every summary**

Run: `pnpm -r --if-present test:coverage`

Expected: every deterministic test workspace writes `coverage/coverage-summary.json`.

- [ ] **Step 5: Commit normalized coverage production**

```bash
git add packages/*/package.json lib/package.json apps/vscode-extension/package.json package.json pnpm-lock.yaml
git commit -m "test: normalize package coverage reports"
```

### Task 3: Enforce nondecreasing package coverage

**Files:**
- Create: `scripts/check-coverage.mjs`
- Create: `scripts/check-coverage.test.mjs`
- Create: `tooling-baselines/coverage.json`
- Modify: `package.json`

**Interfaces:**
- Produces: `compareCoverage(actual, baseline): string[]` and `pnpm check:coverage`.

- [ ] **Step 1: Test package-scoped regression detection**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { compareCoverage } from './check-coverage.mjs';

test('does not let another package hide a regression', () => {
  const failures = compareCoverage({ core: { lines: 79 }, app: { lines: 99 } }, { core: { lines: 80 }, app: { lines: 90 } });
  assert.deepEqual(failures, ['core lines coverage 79 is below baseline 80']);
});
```

- [ ] **Step 2: Implement threshold comparison**

Read each summary's `total` percentages for `lines`, `functions`, `branches`, and `statements`; compare to `tooling-baselines/coverage.json`. Fail on missing reports, lower values, missing packages, and a baseline lower than the committed value. Provide `--write-increases` that updates only increased values.

- [ ] **Step 3: Record observed floors**

Run all coverage producers, then `node scripts/check-coverage.mjs --write-increases`. Review that each package has four numeric percentages and no integration-only measurement.

- [ ] **Step 4: Add deep checks to full validation**

Add `check:dead-code` and `check:coverage` to `check:all` after unit tests. Keep their CI job advisory (`continue-on-error: true`) for the first 14 days while baselines are reviewed; remove that flag on the recorded enforcement date without changing the commands or thresholds.

- [ ] **Step 5: Run complete validation**

Run: `node --test scripts/check-knip.test.mjs scripts/check-coverage.test.mjs && pnpm check:all`

Expected: PASS.

- [ ] **Step 6: Commit coverage ratchet**

```bash
git add scripts/check-coverage.mjs scripts/check-coverage.test.mjs tooling-baselines/coverage.json package.json
git commit -m "test: ratchet package coverage"
```

## PR Exit Criteria

- New Knip findings fail and stale baseline entries fail.
- Every deterministic package emits the same coverage summary format.
- Coverage regressions fail per package and metric.
- Extension integration coverage is not used as a hard threshold.
