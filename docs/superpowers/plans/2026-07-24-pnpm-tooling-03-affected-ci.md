# Affected Validation and CI Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `check:affected` and `check:all`, then make CI invoke the same root validation contract used locally.

**Architecture:** pnpm's `...[<merge-base>]` selector owns changed package and dependent expansion. A small router handles merge-base validation and repository-wide escalation; specialized packaging, integration, security, docs, and OS jobs remain separate.

**Tech Stack:** Node.js 22, pnpm changed-since filters, GitHub Actions.

## Global Constraints

- Depend on PRs 1 and 2.
- `check:affected` includes dependent packages and fails on invalid or unexpectedly empty selection.
- Root metadata, lockfile, workspace, shared config, tooling, and workflow changes escalate to `check:all`.
- CI installs with `pnpm install --frozen-lockfile` and calls root scripts.
- Existing specialized merge gates remain intact.

---

## File Structure

- `scripts/affected-selection.mjs`: resolves base branch/merge base and escalation.
- `scripts/affected-selection.test.mjs`: verifies routing and invalid selections.
- `scripts/check-affected.mjs`: executes filtered typecheck, lint, and test stages.
- `package.json`: exposes stable `check:affected` and `check:all` APIs.
- `.github/workflows/validation.yml`: early affected and complete contract jobs.

### Task 1: Implement merge-base and escalation routing

**Files:**
- Create: `scripts/affected-selection.mjs`
- Create: `scripts/affected-selection.test.mjs`

**Interfaces:**
- Produces: `selectValidation({ cwd, baseRef }): Promise<{ mode: 'affected'|'all', mergeBase: string, files: string[] }>`.

- [ ] **Step 1: Write escalation tests**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { requiresFullValidation } from './affected-selection.mjs';

test('root configuration escalates to full validation', () => {
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'eslint.shared.mjs']) {
    assert.equal(requiresFullValidation([file]), true);
  }
});

test('package source remains affected-only', () => {
  assert.equal(requiresFullValidation(['packages/core/src/index.ts']), false);
});
```

- [ ] **Step 2: Run the tests and verify failure**

Run: `node --test scripts/affected-selection.test.mjs`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement deterministic routing**

Treat these prefixes/files as full escalation: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.shared.mjs`, `eslint.config.mjs`, `scripts/`, `.github/workflows/`, and `eslint-suppressions.json`. Resolve the base from `VALIDATION_BASE_REF`, then `origin/${GITHUB_BASE_REF}`, then `origin/main`; verify it using `git rev-parse --verify`, and compute `git merge-base HEAD <base>`. Return a specific nonzero message when either operation fails.

- [ ] **Step 4: Run routing tests**

Run: `node --test scripts/affected-selection.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit routing**

```bash
git add scripts/affected-selection.mjs scripts/affected-selection.test.mjs
git commit -m "test: define affected validation routing"
```

### Task 2: Add root affected and full checks

**Files:**
- Create: `scripts/check-affected.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `selectValidation()` and package scripts.
- Produces: `pnpm check:affected` and `pnpm check:all`.

- [ ] **Step 1: Implement the affected runner**

For mode `all`, spawn `pnpm check:all`. Otherwise use the exact selector `...[${mergeBase}]` and sequentially spawn:

```text
pnpm --filter ...[<mergeBase>] --fail-if-no-match typecheck
pnpm --filter ...[<mergeBase>] --fail-if-no-match lint -- --cache --cache-location .cache/eslint/
pnpm --filter ...[<mergeBase>] --fail-if-no-match test
```

Use `spawn('pnpm', args, { stdio: 'inherit', shell: false })`; stop on the first nonzero exit.

- [ ] **Step 2: Add stable root commands**

```json
"check:affected": "node scripts/check-affected.mjs",
"check:all": "pnpm run check:workspace && pnpm run format:check && pnpm run typecheck && pnpm run lint -- --cache --cache-location .cache/eslint/ && pnpm run test"
```

- [ ] **Step 3: Test source-only selection**

Run: `VALIDATION_BASE_REF=origin/main pnpm check:affected`

Expected: changed packages and their dependents run; output names the merge base and selected mode.

- [ ] **Step 4: Test escalation**

Temporarily touch `pnpm-workspace.yaml`, run `VALIDATION_BASE_REF=origin/main node scripts/check-affected.mjs --dry-run`, verify it prints `mode=all`, then restore the timestamp without changing content.

- [ ] **Step 5: Commit root validation tiers**

```bash
git add scripts/check-affected.mjs package.json
git commit -m "feat: add affected and full validation tiers"
```

### Task 3: Add canonical CI validation jobs

**Files:**
- Create: `.github/workflows/validation.yml`
- Modify: `.github/workflows/vscode-extension-secure-ci.yml`
- Modify: `.github/workflows/lib-collection-scripts-ci.yml`
- Modify: `.github/workflows/docs.yml`

**Interfaces:**
- Produces: early `affected` and canonical `all` jobs while specialized workflows retain artifact-specific work.

- [ ] **Step 1: Create the validation workflow**

Use `pull_request`, pushes to `main`, and `workflow_dispatch`. Both jobs check out with `fetch-depth: 0`, install pnpm 11.5.0 and Node 22, run a frozen install, then execute:

```yaml
- name: Validate affected workspaces
  if: github.event_name == 'pull_request'
  run: pnpm check:affected
  env:
    VALIDATION_BASE_REF: origin/${{ github.base_ref }}
- name: Validate complete workspace
  run: pnpm check:all
```

Place affected and all in separate jobs so their status and latency remain visible.

- [ ] **Step 2: Remove duplicate broad validation from specialized jobs**

In extension CI remove root workspace build/lint duplication already covered by `validation.yml`, but retain extension compilation, unit tests, OS matrix, VSIX packaging, and security. In lib CI retain publish prerequisites and security, replacing build/lint/test in the validation job with `pnpm check:affected`. In docs CI keep the Docusaurus build because it is an artifact check.

- [ ] **Step 3: Validate workflow syntax structurally**

Run: `node -e "const fs=require('fs');const yaml=require('js-yaml');for(const f of fs.readdirSync('.github/workflows').filter(f=>f.endsWith('.yml')))yaml.load(fs.readFileSync('.github/workflows/'+f,'utf8'))"`

Expected: exits zero for every workflow.

- [ ] **Step 4: Run local equivalents**

Run: `VALIDATION_BASE_REF=origin/main pnpm check:affected && pnpm check:all`

Expected: PASS.

- [ ] **Step 5: Commit CI convergence**

```bash
git add .github/workflows/validation.yml .github/workflows/vscode-extension-secure-ci.yml .github/workflows/lib-collection-scripts-ci.yml .github/workflows/docs.yml
git commit -m "ci: converge on root validation commands"
```

### Task 4: Document the handoff contract

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/contributor-guide/validation.md`

**Interfaces:**
- Produces: one local/agent/CI command contract.

- [ ] **Step 1: Replace the temporary PR 1 guidance**

Document exactly:

```markdown
1. After a substantive edit, run the narrowest focused test immediately.
2. Before handing work back, run `pnpm check:affected`.
3. Run `pnpm check:all` for root configuration or validation-tool changes.
```

- [ ] **Step 2: Document failure modes**

Include invalid merge base, empty selection, full escalation paths, and `VALIDATION_BASE_REF=<ref>` remediation.

- [ ] **Step 3: Build documentation**

Run: `pnpm -C website run build`

Expected: PASS.

- [ ] **Step 4: Commit documentation**

```bash
git add AGENTS.md docs/contributor-guide/validation.md
git commit -m "docs: define affected validation handoff"
```

## PR Exit Criteria

- `check:affected` includes dependents and fails on bad selection.
- Root/tool/workflow changes escalate to `check:all`.
- CI and local validation call the same root commands.
- Specialized artifact, integration, security, and OS jobs remain present.
