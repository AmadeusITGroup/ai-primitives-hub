# Architecture and TypeScript Ratchets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mechanically enforce `core <- infra <- app <- delivery`, complete the TypeScript build graph, and introduce stricter compiler options without a bulk source rewrite.

**Architecture:** ESLint import restrictions reject forbidden source edges with package-specific messages; pnpm rejects manifest cycles. TypeScript project references retain ordered package builds, while bundled applications typecheck independently.

**Tech Stack:** ESLint import rules, TypeScript project references, `tsc -b`, pnpm workspace graph.

## Global Constraints

- Depend on PR 4.
- Core cannot import infra, app, CLI, or VS Code delivery code.
- Infra can import core only; app can import core and infra; delivery can import inward.
- Modernize module resolution separately from strictness flags.
- Each strictness flag is a separate follow-up commit and may be split into its own PR if source fixes exceed 300 changed lines.
- Never lower an enabled strict option in a leaf configuration without a documented exception.

---

## File Structure

- `eslint.shared.mjs`: exports layer boundary configurations.
- Package ESLint configs: select their allowed inward dependencies.
- Root `tsconfig.json`: solution graph entry point.
- Package `tsconfig*.json`: source/test references and build info ownership.
- `scripts/check-tsconfig-policy.mjs`: rejects local disabling of ratcheted options.

### Task 1: Enforce Clean Architecture import boundaries

**Files:**
- Modify: `eslint.shared.mjs`
- Modify: `packages/core/eslint.config.mjs`
- Modify: `packages/infra/eslint.config.mjs`
- Modify: `packages/app/eslint.config.mjs`
- Modify: `packages/cli/eslint.config.mjs`
- Modify: `apps/vscode-extension/eslint.config.mjs`
- Create: `scripts/architecture-fixtures/core-forbidden.ts`

**Interfaces:**
- Produces: `createLayerBoundaryConfig({ name, forbiddenPackages })` returning a flat-config block.

- [ ] **Step 1: Add a failing core fixture**

```ts
import type { RegistryManager } from '@ai-primitives-hub/app';
export type ForbiddenCoreDependency = RegistryManager;
```

- [ ] **Step 2: Implement shared restrictions**

Use `no-restricted-imports` with package patterns and messages. Core forbids `@ai-primitives-hub/{infra,app,cli}` and extension-relative paths; infra forbids app/cli/extension; app forbids cli/extension. Apply the helper in each package config.

- [ ] **Step 3: Verify the fixture fails clearly**

Run: `pnpm -C packages/core exec eslint ../../scripts/architecture-fixtures/core-forbidden.ts --no-ignore`

Expected: FAIL naming the forbidden `core -> app` edge.

- [ ] **Step 4: Delete the fixture and verify real sources**

Run: `pnpm -r lint`

Expected: PASS against suppressed existing findings with no forbidden production edge.

- [ ] **Step 5: Commit boundary enforcement**

```bash
git add eslint.shared.mjs packages/*/eslint.config.mjs apps/vscode-extension/eslint.config.mjs scripts/architecture-fixtures/core-forbidden.ts
git commit -m "chore: enforce clean architecture imports"
```

### Task 2: Complete and verify the TypeScript solution graph

**Files:**
- Create: `tsconfig.json`
- Modify: `packages/tsconfig.json`
- Modify: `packages/*/tsconfig.json`
- Modify: `packages/*/tsconfig.test.json`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Produces: root `tsc -b packages`, ordered `core -> infra -> app -> cli`; extension, lib, website, and Action remain independent typechecks.

- [ ] **Step 1: Add the root solution config**

```json
{
  "files": [],
  "references": [{ "path": "./packages" }]
}
```

- [ ] **Step 2: Make build info paths explicit**

Set each composite package's `tsBuildInfoFile` to `../../.cache/tsbuild/<package>.tsbuildinfo`. Keep declarations and maps enabled for published packages. Ensure source references remain core first, then infra, app, and CLI.

- [ ] **Step 3: Separate build and typecheck scripts**

Set root `build:packages` to `tsc -b packages`, keep delivery builds separate, and retain extension `typecheck: tsc --noEmit`. Add `tsc -b packages --watch --preserveWatchOutput` as `watch:types` so incremental local/agent loops reuse build info. Add `.cache/` to `.gitignore`.

- [ ] **Step 4: Verify clean ordered builds**

Run: `rm -rf .cache/tsbuild packages/*/dist && pnpm run build:packages && pnpm run typecheck`

Expected: declarations build in dependency order; bundled apps typecheck without emitting.

- [ ] **Step 5: Commit the project graph**

```bash
git add tsconfig.json packages/tsconfig.json packages/*/tsconfig*.json package.json .gitignore
git commit -m "build: complete typescript project graph"
```

### Task 3: Modernize module resolution

**Files:**
- Modify: `tsconfig.base.json`
- Modify: `packages/*/tsconfig.json`
- Modify: `lib/tsconfig.json`
- Modify: `apps/vscode-extension/tsconfig.json`

**Interfaces:**
- Produces: NodeNext resolution for CommonJS/published Node packages and bundler resolution for webpack/Docusaurus apps.

- [ ] **Step 1: Capture current module diagnostics**

Run: `pnpm run typecheck`

Expected: PASS baseline.

- [ ] **Step 2: Apply resolution by package type**

Use matching `module: NodeNext` and `moduleResolution: NodeNext` for published Node packages. Keep `moduleResolution: bundler` for website and extension bundling configs, paired with their existing ES module output. Do not mix `module: commonjs` with `moduleResolution: NodeNext`.

- [ ] **Step 3: Resolve only real export/extension diagnostics**

Run: `pnpm run typecheck && pnpm run build`

Expected: PASS. Any source fix must address an actual package export or import extension; do not add path aliases to hide invalid package boundaries.

- [ ] **Step 4: Commit module resolution**

```bash
git add tsconfig.base.json packages/*/tsconfig.json lib/tsconfig.json apps/vscode-extension/tsconfig.json
git commit -m "build: modernize typescript module resolution"
```

### Task 4: Add compiler-option policy and package ratchets

**Files:**
- Create: `scripts/check-tsconfig-policy.mjs`
- Create: `scripts/check-tsconfig-policy.test.mjs`
- Modify: `tsconfig.base.json`
- Modify: package `tsconfig*.json` files that pass each option
- Modify: `package.json`

**Interfaces:**
- Produces: `check:tsconfig-policy`; shared enabled options cannot be disabled in leaves.

- [ ] **Step 1: Test local-disable rejection**

Write a fixture assertion that `{ compilerOptions: { noImplicitOverride: false } }` produces `tsconfig.json: noImplicitOverride cannot be disabled locally` when the shared option is true.

- [ ] **Step 2: Implement policy validation**

Parse JSON with `jsonc-eslint-parser` or the TypeScript API, inspect these exact keys, and reject a leaf `false` when the base is `true`: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `noUncheckedSideEffectImports`, `noUnusedLocals`, `noUnusedParameters`.

- [ ] **Step 3: Enable flags one at a time**

For each flag, run `pnpm run typecheck`; enable it in the narrowest package that already passes, fix only direct diagnostics, rerun focused package tests, and commit separately. Split to a new PR when any flag requires more than 300 changed source lines.

- [ ] **Step 4: Add policy to full validation**

Add `"check:tsconfig-policy": "node scripts/check-tsconfig-policy.mjs"` and invoke it in `check:all` before typechecking.

- [ ] **Step 5: Run complete validation**

Run: `node --test scripts/check-tsconfig-policy.test.mjs && pnpm check:all`

Expected: PASS.

- [ ] **Step 6: Commit policy enforcement**

```bash
git add scripts/check-tsconfig-policy.mjs scripts/check-tsconfig-policy.test.mjs tsconfig.base.json packages/*/tsconfig*.json lib/tsconfig*.json apps/vscode-extension/tsconfig*.json package.json
git commit -m "chore: ratchet typescript strictness"
```

## PR Exit Criteria

- Forbidden layer imports fail with the edge in the diagnostic.
- `tsc -b packages` builds in dependency order.
- Delivery applications typecheck independently.
- Module resolution is modern and internally consistent.
- Strictness growth is package-scoped and cannot be silently disabled.
