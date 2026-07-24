# Workspace Validation Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every workspace package expose an explicit, enforceable validation contract without changing product behavior.

**Architecture:** pnpm remains the workspace orchestrator. A small Node script validates package categories and invariants that pnpm cannot express, while pnpm's native `requiredScripts`, `failIfNoMatch`, and cycle settings prevent silent recursive skips.

**Tech Stack:** Node.js 22, pnpm 11.5.0, TypeScript 5.9, Vitest, Mocha, ESLint 9.

## Global Constraints

- Use Node.js `>=22.0.0` and pnpm `11.5.0` throughout the workspace and CI.
- Preserve the standard script vocabulary: `build`, `typecheck`, `lint`, `test`, `format:check`.
- Keep one root `pnpm-lock.yaml`; remove `lib/package-lock.json` and `website/package-lock.json`.
- Validation commands must not auto-fix files or access the network.
- Preserve existing packaging, integration, security, and multi-platform gates.
- This is PR 1 of 7 and has no dependency on later plans.

---

## File Structure

- `scripts/workspace-contract.mjs`: discovers workspace manifests and validates category scripts, engines, internal dependency protocols, and lockfile ownership.
- `scripts/workspace-contract.test.mjs`: tests the validator through temporary fixture workspaces.
- `package.json`: exposes `check:workspace` and normalizes root commands.
- `pnpm-workspace.yaml`: enables pnpm-native safety settings.
- Workspace `package.json` files: expose the scripts applicable to each package category.
- `.nvmrc`: records Node 22 as the local runtime source of truth.
- `AGENTS.md` and `docs/contributor-guide/validation.md`: document the pnpm-only validation contract.

### Task 1: Build the workspace contract validator

**Files:**
- Create: `scripts/workspace-contract.mjs`
- Create: `scripts/workspace-contract.test.mjs`

**Interfaces:**
- Consumes: a repository root path and workspace manifests selected from `packages/*`, `apps/*`, `github-actions/*`, `lib`, and `website`.
- Produces: `validateWorkspace(rootDir): Promise<string[]>`, returning deterministic `path: message` failures.

- [ ] **Step 1: Write fixture tests for package discovery and missing scripts**

```js
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateWorkspace } from './workspace-contract.mjs';

async function writeJson(root, relativePath, value) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
}

test('names the package and missing category script', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'workspace-contract-'));
  await writeJson(root, 'package.json', { packageManager: 'pnpm@11.5.0', engines: { node: '>=22.0.0' } });
  await writeJson(root, 'packages/core/package.json', {
    name: '@ai-primitives-hub/core', engines: { node: '>=22.0.0' }, scripts: { build: 'tsc' }
  });
  const failures = await validateWorkspace(root);
  assert(failures.includes('packages/core/package.json: missing script "typecheck"'));
});

test('rejects non-workspace internal dependency ranges', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'workspace-contract-'));
  await writeJson(root, 'package.json', { packageManager: 'pnpm@11.5.0', engines: { node: '>=22.0.0' } });
  await writeJson(root, 'packages/core/package.json', {
    name: '@ai-primitives-hub/core', engines: { node: '>=22.0.0' },
    scripts: { build: 'tsc', typecheck: 'tsc --noEmit', lint: 'eslint src', test: 'vitest run', 'format:check': 'eslint src' }
  });
  await writeJson(root, 'packages/app/package.json', {
    name: '@ai-primitives-hub/app', engines: { node: '>=22.0.0' },
    scripts: { build: 'tsc', typecheck: 'tsc --noEmit', lint: 'eslint src', test: 'vitest run', 'format:check': 'eslint src' },
    dependencies: { '@ai-primitives-hub/core': '^1.0.0' }
  });
  const failures = await validateWorkspace(root);
  assert(failures.some((failure) => failure.includes('@ai-primitives-hub/core must use workspace:')));
});
```

- [ ] **Step 2: Run the tests and verify the module is missing**

Run: `node --test scripts/workspace-contract.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/workspace-contract.mjs`.

- [ ] **Step 3: Implement discovery and category validation**

```js
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const packagePaths = [
  'packages/core', 'packages/infra', 'packages/app', 'packages/cli',
  'apps/vscode-extension', 'github-actions/validate-collections', 'lib', 'website'
];
const typedScripts = ['build', 'typecheck', 'lint', 'test', 'format:check'];
const buildOnlyScripts = ['build', 'typecheck', 'lint', 'format:check'];

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

export async function validateWorkspace(rootDir) {
  const failures = [];
  const rootManifest = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'));
  const manifests = [];
  for (const packagePath of packagePaths) {
    const manifestPath = path.join(rootDir, packagePath, 'package.json');
    if (!await exists(manifestPath)) {
      failures.push(`${packagePath}/package.json: expected workspace package is missing`);
      continue;
    }
    manifests.push([packagePath, JSON.parse(await readFile(manifestPath, 'utf8'))]);
  }
  const names = new Set(manifests.map(([, manifest]) => manifest.name));
  for (const [packagePath, manifest] of manifests) {
    const required = packagePath === 'github-actions/validate-collections' ? buildOnlyScripts : typedScripts;
    for (const script of required) {
      if (!manifest.scripts?.[script]) failures.push(`${packagePath}/package.json: missing script "${script}"`);
    }
    if (packagePath !== 'apps/vscode-extension' && manifest.engines?.node !== rootManifest.engines.node) {
      failures.push(`${packagePath}/package.json: engines.node must equal ${rootManifest.engines.node}`);
    }
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const [name, range] of Object.entries(manifest[section] ?? {})) {
        if (names.has(name) && !String(range).startsWith('workspace:')) {
          failures.push(`${packagePath}/package.json: ${section}.${name} must use workspace:`);
        }
      }
    }
  }
  for (const lockfile of ['lib/package-lock.json', 'website/package-lock.json']) {
    if (await exists(path.join(rootDir, lockfile))) failures.push(`${lockfile}: remove secondary lockfile`);
  }
  return failures.sort();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const failures = await validateWorkspace(process.cwd());
  if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
  else console.log('Workspace contract is valid.');
}
```

- [ ] **Step 4: Run the validator tests**

Run: `node --test scripts/workspace-contract.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit the validator**

```bash
git add scripts/workspace-contract.mjs scripts/workspace-contract.test.mjs
git commit -m "test: define workspace validation contract"
```

### Task 2: Normalize package scripts and runtime requirements

**Files:**
- Modify: `package.json`
- Modify: `packages/core/package.json`
- Modify: `packages/infra/package.json`
- Modify: `packages/app/package.json`
- Modify: `packages/cli/package.json`
- Modify: `lib/package.json`
- Modify: `website/package.json`
- Modify: `github-actions/validate-collections/package.json`
- Modify: `apps/vscode-extension/package.json`
- Create: `.nvmrc`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: the vocabulary enforced by `validateWorkspace()`.
- Produces: package-local `build`, `typecheck`, `lint`, `test`, and `format:check` entry points; the GitHub Action omits only `test`.

- [ ] **Step 1: Run the contract against the current workspace**

Run: `node scripts/workspace-contract.mjs`

Expected: FAIL listing missing scripts, Node engine drift, and both npm lockfiles.

- [ ] **Step 2: Add the root contract scripts**

Add these entries to root `scripts`:

```json
"typecheck": "pnpm -r typecheck",
"format:check": "pnpm -r format:check",
"check:workspace": "node scripts/workspace-contract.mjs",
"test:tooling": "node --test scripts/*.test.mjs"
```

- [ ] **Step 3: Normalize typed package scripts**

For `packages/core`, `packages/infra`, `packages/app`, and `packages/cli`, add:

```json
"typecheck": "tsc --noEmit",
"format:check": "eslint src test"
```

For `lib`, add `"typecheck": "tsc --noEmit"` and `"format:check": "eslint src test"`. For the extension add `"typecheck": "tsc --noEmit"`; leave its temporary Prettier removal to PR 2. For `website`, add `"typecheck": "tsc --noEmit"`, `"lint": "eslint src docusaurus.config.ts sidebars.ts"`, and `"format:check": "pnpm run lint"`. For the GitHub Action add `"typecheck": "node --check src/index.js"`, `"lint": "eslint src rollup.config.js"`, and `"format:check": "pnpm run lint"`.

- [ ] **Step 4: Align Node engines and install metadata**

Set every Node package's `engines.node` to `">=22.0.0"`, add `.nvmrc` containing `22`, and run:

Run: `pnpm install --lockfile-only`

Expected: `pnpm-lock.yaml` updates without adding package-local lockfiles.

- [ ] **Step 5: Verify focused scripts**

Run: `pnpm run typecheck && pnpm run test:tooling`

Expected: typechecks pass; tooling tests pass.

- [ ] **Step 6: Commit script normalization**

```bash
git add .nvmrc package.json pnpm-lock.yaml packages/*/package.json lib/package.json website/package.json github-actions/validate-collections/package.json apps/vscode-extension/package.json
git commit -m "chore: normalize workspace validation scripts"
```

### Task 3: Enable pnpm-native integrity failures

**Files:**
- Modify: `pnpm-workspace.yaml`

**Interfaces:**
- Consumes: normalized package scripts from Task 2.
- Produces: recursive command failures for missing scripts, empty filters, stale dependencies, version mismatch, and workspace cycles.

- [ ] **Step 1: Add pnpm safety settings**

```yaml
requiredScripts:
  - build
  - typecheck
  - lint
  - format:check
failIfNoMatch: true
disallowWorkspaceCycles: true
pmOnFail: error
verifyDepsBeforeRun: error
engineStrict: true
```

- [ ] **Step 2: Verify recursive scripts no longer skip packages**

Run: `pnpm -r typecheck && pnpm -r lint -- --no-warn-ignored`

Expected: every expected workspace package is named in pnpm's scope; no package is silently skipped for a missing script.

- [ ] **Step 3: Verify empty filters fail**

Run: `pnpm --filter definitely-not-a-package typecheck`

Expected: nonzero exit with no projects matched.

- [ ] **Step 4: Commit pnpm integrity settings**

```bash
git add pnpm-workspace.yaml
git commit -m "chore: fail on incomplete workspace validation"
```

### Task 4: Remove secondary lockfiles and update contributor contracts

**Files:**
- Delete: `lib/package-lock.json`
- Delete: `website/package-lock.json`
- Modify: `.github/workflows/dependency-review.yml`
- Modify: `AGENTS.md`
- Modify: `docs/contributor-guide/validation.md`

**Interfaces:**
- Consumes: the root pnpm install and package-local scripts.
- Produces: one documented install and validation path.

- [ ] **Step 1: Delete the npm lockfiles and update dependency-review routing**

Delete both package lockfiles and make the workflow paths:

```yaml
paths:
  - '**/package.json'
  - 'pnpm-lock.yaml'
  - 'pnpm-workspace.yaml'
```

- [ ] **Step 2: Update contributor commands**

Replace `cd lib && npm test` with `pnpm -C lib run test`. Add this validation contract to both contributor documents:

```markdown
After a substantive edit, run the narrowest focused test immediately. Before handing work back, run the repository's affected validation command; until `check:affected` lands, run `pnpm run check:workspace` plus the touched package's `typecheck`, `lint`, and `test` scripts.
```

- [ ] **Step 3: Run the complete PR validation**

Run: `pnpm install --frozen-lockfile && pnpm run check:workspace && pnpm run typecheck && pnpm run test`

Expected: PASS from a single root lockfile.

- [ ] **Step 4: Commit lockfile and documentation cleanup**

```bash
git add AGENTS.md docs/contributor-guide/validation.md .github/workflows/dependency-review.yml lib/package-lock.json website/package-lock.json
git commit -m "docs: standardize on root pnpm workflow"
```

## PR Exit Criteria

- `node --test scripts/workspace-contract.test.mjs` passes.
- `pnpm run check:workspace` passes and names exact files on fixture failures.
- `pnpm -r typecheck` reaches every typed workspace package.
- Only root `pnpm-lock.yaml` remains.
- PR 2 can add fast feedback without changing this contract.
