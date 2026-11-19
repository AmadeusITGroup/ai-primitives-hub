# Workspace Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add low-noise metadata, workflow, ownership, and supply-chain checks to the full validation contract.

**Architecture:** Manypkg validates manifest consistency; Actionlint validates workflows; all tools execute from the frozen workspace dependency graph. Dependabot updates pnpm and immutable Action SHAs, while CODEOWNERS assigns sensitive paths.

**Tech Stack:** @manypkg/cli, actionlint, GitHub Actions, Dependabot, pnpm.

## Global Constraints

- Depend on PR 3's `check:all`.
- No `pnpm dlx`, global npm installs, mutable Action tags, or moving branches in CI.
- Pin every third-party Action to a full commit SHA with the release tag in a comment.
- Keep `@vscode/vsce`, SBOM, and license tools in the root frozen lockfile.
- This PR must not add architecture, Knip, coverage, or extension artifact checks.

---

## File Structure

- `.manypkg.json`: explicit package metadata policy.
- `scripts/check-action-pins.mjs`: rejects non-SHA third-party Action references.
- `.github/dependabot.yml`: pnpm and Actions updates.
- `.github/CODEOWNERS`: ownership by repository boundary.
- Existing workflows: invoke lockfile-installed tools and immutable Actions.

### Task 1: Add Manypkg metadata consistency

**Files:**
- Create: `.manypkg.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `pnpm check:packages` invoking `manypkg check` and explicit peer-dependency policy checks in `workspace-contract.mjs`.

- [ ] **Step 1: Install and expose Manypkg**

Run: `pnpm add -Dw @manypkg/cli`

Add `"check:packages": "manypkg check"` and insert it after `check:workspace` in `check:all`.

- [ ] **Step 2: Configure intentional package differences**

Create `.manypkg.json` with `defaultBranch: "main"` and ignored rules only for verified intentional differences such as private delivery packages. Do not ignore dependency-range or engines checks.

- [ ] **Step 3: Run and fix metadata findings**

Run: `pnpm check:packages`

Expected: PASS after aligning repository fields, internal `workspace:` ranges, and Node engines; no product source changes.

- [ ] **Step 4: Enforce peer ranges in the workspace contract**

Extend `scripts/workspace-contract.test.mjs` with failing fixtures for an internal peer without `workspace:` and for a peer range that does not include the internal package version. Update `validateWorkspace()` to reject both cases, while leaving external peer ranges unchanged.

- [ ] **Step 5: Commit Manypkg governance**

```bash
git add .manypkg.json package.json pnpm-lock.yaml packages/*/package.json lib/package.json website/package.json github-actions/validate-collections/package.json
git commit -m "chore: enforce package metadata consistency"
```

### Task 2: Add workflow syntax and immutable Action checks

**Files:**
- Create: `scripts/check-action-pins.mjs`
- Create: `scripts/check-action-pins.test.mjs`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `.github/workflows/*.yml`

**Interfaces:**
- Produces: `pnpm check:workflows`, combining Actionlint and immutable reference validation.

- [ ] **Step 1: Test Action reference parsing**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { findMutableActions } from './check-action-pins.mjs';

test('rejects tags and moving branches but permits local actions', () => {
  const yaml = 'uses: actions/checkout@v4\nuses: aquasecurity/trivy-action@master\nuses: ./.github/actions/local\n';
  assert.deepEqual(findMutableActions('ci.yml', yaml), [
    'ci.yml:1 actions/checkout@v4', 'ci.yml:2 aquasecurity/trivy-action@master'
  ]);
});
```

- [ ] **Step 2: Implement full-SHA validation**

Match `uses:` values, skip `./` and `docker://`, and require `/^[^@]+@[0-9a-f]{40}$/`. Print one clickable `path:line reference` per failure.

- [ ] **Step 3: Install Actionlint from the lockfile-supported tool package**

Run: `pnpm add -Dw -E actionlint@2.0.6`

Create `scripts/check-workflows.mjs`. Import `createLinter` from `actionlint`, create its WASM linter once, read every tracked `.github/workflows/*.{yml,yaml}` file, print each result as `file:line:column: message [kind]`, and exit nonzero when any result exists. Then define:

```json
"check:workflows": "node scripts/check-workflows.mjs && node scripts/check-action-pins.mjs"
```

This package runs Actionlint as WASM through its Node API, so the same lockfile dependency works on Linux, macOS, and Windows without an install-time binary download.

- [ ] **Step 4: Pin every third-party Action**

Resolve current tag SHAs with GitHub's release pages, replace each `@vN`/`@master` with the 40-character SHA, and retain comments such as `# v4.2.2`. Start with both `aquasecurity/trivy-action@master` references.

- [ ] **Step 5: Verify and commit workflow governance**

Run: `node --test scripts/check-action-pins.test.mjs && pnpm check:workflows`

Expected: PASS.

```bash
git add scripts/check-action-pins.mjs scripts/check-action-pins.test.mjs package.json pnpm-lock.yaml .github/workflows
git commit -m "ci: enforce immutable workflow dependencies"
```

### Task 3: Remove dynamically installed CI tools

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `.github/workflows/vscode-extension-secure-ci.yml`
- Modify: `.github/workflows/vscode-extension-secure-publish.yml`

**Interfaces:**
- Produces: local `vsce`, CycloneDX, and license commands resolved from `node_modules/.bin`.

- [ ] **Step 1: Install exact root tools**

Run: `pnpm add -Dw -E @vscode/vsce @cyclonedx/cyclonedx-npm license-checker`

- [ ] **Step 2: Replace dynamic workflow commands**

Replace `npm install -g @vscode/vsce` plus `vsce` with `pnpm -C apps/vscode-extension exec vsce`. Replace `pnpm dlx @cyclonedx/cyclonedx-npm` with `pnpm exec cyclonedx-npm`, and `pnpm dlx license-checker` with `pnpm exec license-checker`.

- [ ] **Step 3: Verify no dynamic installs remain**

Run: `rg "pnpm dlx|npm install -g|@master" .github/workflows`

Expected: no matches.

- [ ] **Step 4: Commit lockfile tool execution**

```bash
git add package.json pnpm-lock.yaml .github/workflows/vscode-extension-secure-ci.yml .github/workflows/vscode-extension-secure-publish.yml
git commit -m "ci: use lockfile-installed validation tools"
```

### Task 4: Add shell and container checks

**Files:**
- Modify: `.github/workflows/validation.yml`

**Interfaces:**
- Produces: pinned-SHA Linux CI checks covering repository shell files with ShellCheck and Dockerfiles with Hadolint.

- [ ] **Step 1: Add pinned validator Actions**

Add `ludeeus/action-shellcheck` and `hadolint/hadolint-action` steps to the Ubuntu complete-validation job. Resolve each current release tag to a 40-character commit SHA and retain the release tag as an inline comment, matching the immutable-reference policy from Task 2.

- [ ] **Step 2: Scope checks to tracked repository files**

Configure ShellCheck for tracked `*.sh` files and Hadolint for tracked `Dockerfile*` files, including `Dockerfile.ssh-test`. Do not ignore whole files; add a line-level suppression only when the rule and repository constraint are documented beside it.

- [ ] **Step 3: Validate the workflow contract**

Run: `pnpm check:workflows`

Expected: Actionlint and immutable-reference validation pass with both new Action references pinned to full SHAs.

- [ ] **Step 4: Commit shell and container checks**

```bash
git add .github/workflows/validation.yml
git commit -m "ci: validate shell and container files"
```

### Task 5: Add dependency automation and ownership

**Files:**
- Create: `.github/dependabot.yml`
- Create: `.github/CODEOWNERS`
- Modify: `package.json`

**Interfaces:**
- Produces: weekly pnpm and Actions updates plus review ownership for sensitive paths.

- [ ] **Step 1: Configure Dependabot**

Create weekly updates for `package-ecosystem: npm` at `/` and `package-ecosystem: github-actions` at `/`, each targeting `main`, with groups for development tooling and GitHub Actions respectively.

- [ ] **Step 2: Add ownership boundaries**

Run `gh api repos/AmadeusITGroup/ai-primitives-hub/collaborators --paginate --jq '.[].login'` and verify the maintainers responsible for each boundary before writing the file. Map `packages/`, `apps/vscode-extension/`, `lib/`, `docs/ website/`, `.github/workflows/`, and release-sensitive package/lock files only to logins returned by that command. Stop this task and request repository-owner input when no collaborator can be verified for a boundary; do not invent handles.

- [ ] **Step 3: Extend full validation**

Append `pnpm check:packages && pnpm check:workflows` to `check:all` before source checks.

- [ ] **Step 4: Run complete validation**

Run: `pnpm check:all`

Expected: PASS with package and workflow checks visible before source checks.

- [ ] **Step 5: Commit automation and ownership**

```bash
git add .github/dependabot.yml .github/CODEOWNERS package.json
git commit -m "chore: add dependency automation and ownership"
```

## PR Exit Criteria

- Manypkg, Actionlint, and pin validation run in `check:all`.
- No workflow uses a mutable third-party Action reference.
- No workflow dynamically installs validation or packaging tools.
- Dependabot covers pnpm and GitHub Actions.
- CODEOWNERS contains only verified owners.
