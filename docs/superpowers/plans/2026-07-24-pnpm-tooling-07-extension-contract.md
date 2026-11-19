# VS Code Extension Artifact Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate extension compatibility, manifest/runtime registration, webview security, VSIX contents, and the installed artifact users receive.

**Architecture:** Focused Node validators compare package metadata with runtime registrations and inspect the generated ZIP-format VSIX. Existing Extension Development Host tests gain isolated Stable/Insiders and trust-sensitive configurations; packaging remains a specialized CI gate.

**Tech Stack:** VS Code Extension API 1.99.3, @vscode/test-electron, @vscode/vsce, adm-zip, Mocha.

## Global Constraints

- Depend on PR 6.
- `engines.vscode` and `@types/vscode` must remain aligned at `^1.99.3` unless deliberately upgraded together.
- Webviews use `default-src 'none'`, `webview.cspSource`, nonced/external scripts, restrictive `localResourceRoots`, validated messages, and sanitized rendered data.
- Reject source, tests, development configuration, and unneeded `node_modules` from VSIX contents.
- Install and smoke-test the generated VSIX in isolated user-data and extensions directories.
- Split webview hardening and artifact validation into separate PRs if production source fixes exceed 500 lines.

---

## File Structure

- `apps/vscode-extension/scripts/check-manifest-contract.mjs`: compares compatibility and contributed IDs to runtime registration.
- `apps/vscode-extension/test/manifest-contract.test.mjs`: fixture-level contract tests.
- `apps/vscode-extension/test/webview-security.test.ts`: observable CSP, message validation, lifecycle, accessibility, and state tests.
- `apps/vscode-extension/scripts/check-vsix.mjs`: content allowlist and size ratchet.
- `apps/vscode-extension/config/vsix-baseline.json`: maximum archive and bundle sizes.
- Extension integration runner/workflows: isolated Stable, Insiders, trust, and installed-VSIX smoke tests.

### Task 1: Validate compatibility and manifest registrations

**Files:**
- Create: `apps/vscode-extension/scripts/check-manifest-contract.mjs`
- Create: `apps/vscode-extension/test/manifest-contract.test.mjs`
- Modify: `apps/vscode-extension/package.json`
- Modify: `package.json`

**Interfaces:**
- Produces: `validateManifest({ manifest, registrations, resources }): string[]` and package script `check:manifest`, including capability consistency for virtual workspaces, untrusted workspaces, and remote extension hosts.

- [ ] **Step 1: Test compatibility mismatch and missing registration**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateManifest } from '../scripts/check-manifest-contract.mjs';

test('reports vscode version and command drift', () => {
  const failures = validateManifest({
    manifest: { engines: { vscode: '^1.99.3' }, devDependencies: { '@types/vscode': '^1.98.0' }, contributes: { commands: [{ command: 'x.run' }] } },
    registrations: new Set(), resources: new Set()
  });
  assert(failures.includes('package.json: @types/vscode ^1.98.0 must match engines.vscode ^1.99.3'));
  assert(failures.includes('package.json: contributed command x.run is not registered at runtime'));
});
```

- [ ] **Step 2: Implement manifest and capability extraction**

Parse package JSON structurally. Extract command IDs from `vscode.commands.registerCommand` and view providers from runtime source using the TypeScript compiler API, not regex. Check contributed resource paths with filesystem access. Require explicit, tested `capabilities.virtualWorkspaces`, `capabilities.untrustedWorkspaces`, and `extensionKind` declarations that match filesystem and workspace-trust behavior. Return sorted `path: message` failures.

- [ ] **Step 3: Expose the validator**

Add `"check:manifest": "node scripts/check-manifest-contract.mjs"` in the extension and `"check:extension": "pnpm -C apps/vscode-extension run check:manifest"` at root.

- [ ] **Step 4: Reconcile current drift**

Run: `pnpm -C apps/vscode-extension run check:manifest`

Expected: PASS after fixing only real manifest/runtime mismatches and preserving deliberate legacy command casing documented by ADR-0004.

- [ ] **Step 5: Commit manifest validation**

```bash
git add apps/vscode-extension/scripts/check-manifest-contract.mjs apps/vscode-extension/test/manifest-contract.test.mjs apps/vscode-extension/package.json package.json
git commit -m "test: validate extension manifest contract"
```

### Task 2: Harden and test webview contracts

**Files:**
- Modify: webview owners under `apps/vscode-extension/src/ui/`
- Create: `apps/vscode-extension/test/unit/webview-security.test.ts`
- Modify: `apps/vscode-extension/package.json`

**Interfaces:**
- Consumes: existing webview factories and message handlers.
- Produces: webviews with restrictive options, validated inbound message unions, sanitized rendering, and disposable cleanup.

- [ ] **Step 1: Write observable security tests**

Test each webview HTML result for `default-src 'none'`, `webview.cspSource`, a per-render nonce, no inline executable script, and escaped user/workspace data. Test unknown message types and malformed payloads are rejected without invoking commands.

- [ ] **Step 2: Test lifecycle and state behavior**

Verify disposal removes event listeners and timers, state uses `getState`/`setState`, `retainContextWhenHidden` is absent unless justified by a measurement, high-contrast classes are respected, controls have accessible names, and reduced-motion CSS disables nonessential transitions.

- [ ] **Step 3: Implement minimal production hardening**

Set `enableScripts` only where needed, set minimal `localResourceRoots`, generate a cryptographic nonce, construct CSP from `webview.cspSource`, validate message discriminants and payload types before dispatch, and sanitize all dynamic HTML.

- [ ] **Step 4: Run focused extension tests**

Run: `pnpm -C apps/vscode-extension run test:one -- test/unit/webview-security.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit webview contracts**

```bash
git add apps/vscode-extension/src/ui apps/vscode-extension/test/unit/webview-security.test.ts apps/vscode-extension/package.json
git commit -m "test: enforce webview security contracts"
```

### Task 3: Validate deterministic VSIX contents and size

**Files:**
- Create: `apps/vscode-extension/scripts/check-vsix.mjs`
- Create: `apps/vscode-extension/test/vsix-contract.test.mjs`
- Create: `apps/vscode-extension/config/vsix-baseline.json`
- Modify: `apps/vscode-extension/package.json`
- Modify: `apps/vscode-extension/.vscodeignore.production`

**Interfaces:**
- Produces: `validateVsix(entries, sizes, baseline): string[]` and deterministic `package:verify`.

- [ ] **Step 1: Test forbidden entries and growth**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateVsix } from '../scripts/check-vsix.mjs';

test('rejects source, tests, and oversized archives', () => {
  const failures = validateVsix(['extension/src/a.ts', 'extension/test/a.test.js'], { archiveBytes: 120 }, { maxArchiveBytes: 100 });
  assert.deepEqual(failures, [
    'VSIX contains forbidden path extension/src/a.ts',
    'VSIX contains forbidden path extension/test/a.test.js',
    'VSIX archive size 120 exceeds baseline 100'
  ]);
});
```

- [ ] **Step 2: Implement ZIP inspection**

Use the existing `adm-zip` dependency to list entries. Require extension manifest, `dist/extension.js`, icon, schemas, skill resources, and webview runtime assets. Reject `/src/`, `/test/`, source maps unless explicitly required, repo configs, and arbitrary `node_modules`. Compare archive bytes and `dist/extension.js` bytes with baseline maxima.

- [ ] **Step 3: Add deterministic packaging**

Define `package:verify` as production preparation, local lockfile `vsce package --no-dependencies --out dist/prompt-registry.vsix`, inspection, and guaranteed ignore restoration through an existing helper's `try/finally` path rather than shell copies.

- [ ] **Step 4: Record reviewed size maxima**

Set both maxima to current measured values plus 5%, rounded to whole KiB; document the exact measured and allowed values in the baseline JSON.

- [ ] **Step 5: Verify and commit artifact inspection**

Run: `node --test apps/vscode-extension/test/vsix-contract.test.mjs && pnpm -C apps/vscode-extension run package:verify`

Expected: PASS and a validated VSIX under `apps/vscode-extension/dist/`.

```bash
git add apps/vscode-extension/scripts/check-vsix.mjs apps/vscode-extension/test/vsix-contract.test.mjs apps/vscode-extension/config/vsix-baseline.json apps/vscode-extension/package.json apps/vscode-extension/.vscodeignore.production
git commit -m "test: validate packaged extension contents"
```

### Task 4: Smoke-test installed artifacts in isolated hosts

**Files:**
- Modify: `apps/vscode-extension/test/runExtensionTests.js`
- Create: `apps/vscode-extension/test/suite/installed-vsix.test.ts`
- Modify: `.github/workflows/vscode-extension-secure-ci.yml`
- Modify: `.github/workflows/vscode-extension-secure-publish.yml`

**Interfaces:**
- Produces: isolated Stable/Insiders execution, trusted/untrusted configurations, and installed-VSIX activation smoke test.

- [ ] **Step 1: Add isolated runner directories**

Pass unique temporary `--user-data-dir`, `--extensions-dir`, and `--disable-extensions` arguments to development-host runs. Add `VSCODE_CHANNEL=stable|insiders` selection and clean directories in `finally`.

- [ ] **Step 2: Add trust-sensitive configurations**

Run trust-sensitive tests once with a trusted temporary workspace and once with VS Code's `--disable-workspace-trust` launch argument. Add a virtual-workspace URI fixture and a remote extension-host CI entry consistent with `extensionKind`. Assert restricted commands do not access workspace files while untrusted and unsupported capabilities fail with actionable messages.

- [ ] **Step 3: Add installed-VSIX smoke test**

Use the VS Code CLI from `@vscode/test-electron` to install `dist/prompt-registry.vsix` into an empty extensions directory, launch with unrelated extensions disabled, and assert the extension activates and one registered read-only command is available.

- [ ] **Step 4: Extend CI matrices**

Keep the existing OS matrix for packaging/unit assurance. Add Linux Stable and Insiders integration entries; add minimum VS Code `1.99.3` when manifest/API changes touch compatibility-sensitive paths. Publish workflow must run `package:verify` and installed smoke before release.

- [ ] **Step 5: Run focused integration verification**

Run: `VSCODE_CHANNEL=stable pnpm -C apps/vscode-extension run test:integration && VSCODE_CHANNEL=insiders pnpm -C apps/vscode-extension run test:integration`

Expected: both isolated hosts pass; installed artifact activates.

- [ ] **Step 6: Add extension contract to full validation and commit**

Add deterministic manifest and VSIX validator unit tests to `check:all`; leave host integration and packaging in specialized workflows.

```bash
git add apps/vscode-extension/test/runExtensionTests.js apps/vscode-extension/test/suite/installed-vsix.test.ts .github/workflows/vscode-extension-secure-ci.yml .github/workflows/vscode-extension-secure-publish.yml package.json
git commit -m "ci: smoke test the installed extension artifact"
```

## PR Exit Criteria

- Manifest/API compatibility and runtime registrations are checked.
- Webviews satisfy CSP, input validation, sanitization, lifecycle, state, accessibility, and reduced-motion tests.
- VSIX contents and size cannot regress silently.
- Stable, Insiders, trusted, untrusted, and installed-artifact paths are exercised in the integration and packaging gates defined above.
