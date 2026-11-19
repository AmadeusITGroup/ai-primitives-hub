# Fast Changed-File Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic `pnpm check:fast` that uses ESLint as the sole formatter and reports only new violations in changed files.

**Architecture:** ESLint's existing o3r/@stylistic configuration owns code formatting; Prettier is removed. ESLint native bulk suppressions hold existing debt, `lint-staged` supplies staged paths to the hook, and a thin Node runner supplies working-tree paths for direct invocation.

**Tech Stack:** ESLint 9 flat config and bulk suppressions, @stylistic/eslint-plugin, @eslint/markdown, eslint-plugin-jsonc, eslint-plugin-yml, lint-staged, simple-git-hooks, Node.js 22.

## Global Constraints

- Depend on PR 1's package scripts and `check:workspace` contract.
- ESLint is the only formatting authority; remove Prettier and do not add `eslint-config-prettier`.
- `check:fast` must never modify files, access the network, or run package-wide tests.
- A single-package changed file should complete in the single-digit-second range.
- Existing warnings are recorded once in `eslint-suppressions.json`; new warnings fail with `--max-warnings 0`.
- Multi-package changes print a warning recommending `pnpm check:affected`.

---

## File Structure

- `scripts/changed-files.mjs`: resolves staged or working-tree paths and groups lintable paths by package.
- `scripts/changed-files.test.mjs`: verifies changed-file parsing, deletion handling, and package fan-out.
- `scripts/check-fast.mjs`: invokes ESLint and lightweight structured-file checks without shell interpolation.
- `eslint.shared.mjs`: uses one TypeScript project service and includes shared structured-file style rules.
- `eslint-suppressions.json`: ESLint-native baseline for existing violations.
- `lint-staged.config.mjs` and root `simple-git-hooks`: wire staged paths into the same fast runner.

### Task 1: Collapse type-aware ESLint onto one project service

**Files:**
- Modify: `eslint.shared.mjs`
- Modify: `packages/core/eslint.config.mjs`
- Modify: `packages/infra/eslint.config.mjs`
- Modify: `packages/app/eslint.config.mjs`
- Modify: `packages/cli/eslint.config.mjs`
- Modify: `lib/eslint.config.mjs`
- Modify: `apps/vscode-extension/eslint.config.mjs`

**Interfaces:**
- Consumes: each package's nearest `tsconfig.json` and `tsconfig.test.json` through typescript-eslint project discovery.
- Produces: `createSharedConfig({ name, tsconfigRootDir, nodeGlobFiles? })` without a `tsProjects` argument.

- [ ] **Step 1: Capture the current warning**

Run: `pnpm -C packages/core exec eslint src/index.ts 2>&1 | grep "Multiple projects found"`

Expected: output contains the multiple-project performance warning.

- [ ] **Step 2: Switch the parser to project service**

Change `createSharedConfig` to set:

```js
parserOptions: {
  projectService: {
    allowDefaultProject: ['*.config.{js,mjs}', 'scripts/*.{js,mjs}']
  },
  tsconfigRootDir
}
```

Change the TypeScript import resolver to:

```js
typescript: { project: path.join(tsconfigRootDir, 'tsconfig.json') }
```

Import `path` from `node:path`, remove `tsProjects` from the JSDoc and function signature, then remove `tsProjects` from all six callers.

- [ ] **Step 3: Verify behavior and timing**

Run: `time pnpm -C packages/core exec eslint src/index.ts`

Expected: no `Multiple projects found` warning; lint findings remain equivalent to the pre-change run.

- [ ] **Step 4: Commit project-service adoption**

```bash
git add eslint.shared.mjs packages/*/eslint.config.mjs lib/eslint.config.mjs apps/vscode-extension/eslint.config.mjs
git commit -m "perf: use eslint project service"
```

### Task 2: Make ESLint the repository formatter

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `eslint.shared.mjs`
- Create: `eslint.config.mjs`
- Modify: `apps/vscode-extension/package.json`
- Create: `.editorconfig`

**Interfaces:**
- Consumes: o3r and @stylistic's existing fixable style rules.
- Produces: `pnpm format` for explicit fixes and `pnpm format:check` for non-mutating checks across code and repository files.

- [ ] **Step 1: Add structured-file ESLint plugins and remove Prettier**

Run: `pnpm add -Dw @eslint/markdown eslint-plugin-jsonc eslint-plugin-yml yaml-eslint-parser && pnpm -C apps/vscode-extension remove prettier`

Expected: root dependencies and `pnpm-lock.yaml` update; the extension no longer declares Prettier.

- [ ] **Step 2: Add root flat-config coverage**

Create `eslint.config.mjs` that composes `createSharedConfig` for root JavaScript, then adds:

```js
import markdown from '@eslint/markdown';
import jsonc from 'eslint-plugin-jsonc';
import yml from 'eslint-plugin-yml';

export default [
  ...createSharedConfig({ name: 'root', tsconfigRootDir: import.meta.dirname, nodeGlobFiles: ['**/*.{js,mjs}'] }),
  ...jsonc.configs['flat/recommended-with-json'],
  ...yml.configs['flat/standard'],
  ...markdown.configs.recommended,
  {
    name: 'root/structured-style',
    files: ['**/*.{json,jsonc,yml,yaml,md}'],
    rules: { 'eol-last': ['error', 'always'], 'no-trailing-spaces': 'error' }
  }
];
```

Resolve JSON/YAML style conflicts explicitly in `root/structured-style`; do not add Prettier compatibility presets or integrations.

- [ ] **Step 3: Replace formatting scripts**

At the root add:

```json
"format": "eslint . --fix --fix-type layout",
"format:check": "eslint . --max-warnings 0"
```

In the extension replace its `format` and `format:check` scripts with:

```json
"format": "eslint src test --fix --fix-type layout",
"format:check": "eslint src test --max-warnings 0"
```

- [ ] **Step 4: Add editor defaults**

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
```

- [ ] **Step 5: Verify check mode does not mutate files**

Run: `git diff --exit-code && pnpm run format:check; git diff --exit-code`

Expected: the first and second diff checks both pass; style findings, if any, are reported without writes.

- [ ] **Step 6: Commit formatter ownership**

```bash
git add .editorconfig eslint.config.mjs eslint.shared.mjs package.json pnpm-lock.yaml apps/vscode-extension/package.json
git commit -m "chore: standardize formatting on eslint"
```

### Task 3: Add changed-file routing and fast validation

**Files:**
- Create: `scripts/changed-files.mjs`
- Create: `scripts/changed-files.test.mjs`
- Create: `scripts/check-fast.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `getChangedFiles({ cwd, staged }): Promise<string[]>`, `groupByPackage(files): Map<string, string[]>`, and CLI `node scripts/check-fast.mjs [--staged] [files...]`.

- [ ] **Step 1: Write routing tests**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNameStatus, groupByPackage } from './changed-files.mjs';

test('drops deleted files and preserves renamed destinations', () => {
  const output = 'M\tpackages/core/src/a.ts\0D\told.ts\0R100\told.ts\0packages/app/src/new.ts\0';
  assert.deepEqual(parseNameStatus(output), ['packages/core/src/a.ts', 'packages/app/src/new.ts']);
});

test('warns through package fan-out data', () => {
  const groups = groupByPackage(['packages/core/src/a.ts', 'apps/vscode-extension/src/b.ts']);
  assert.deepEqual([...groups.keys()], ['apps/vscode-extension', 'packages/core']);
});
```

- [ ] **Step 2: Run tests and verify the module is missing**

Run: `node --test scripts/changed-files.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement NUL-safe Git routing**

Use `execFile('git', staged ? ['diff', '--cached', '--name-status', '-z'] : ['diff', 'HEAD', '--name-status', '-z'])`; parse status records without invoking a shell. Classify `*.{js,mjs,cjs,ts,tsx,json,jsonc,yml,yaml,md}` as ESLint inputs and return sorted relative paths. Exit zero with `No changed files to validate.` only when both tracked and untracked working-tree selections are genuinely empty.

- [ ] **Step 4: Implement the fast runner**

Use `spawn(process.execPath, [eslintBin, ...files, '--max-warnings', '0', '--no-warn-ignored'], { stdio: 'inherit' })`, resolving `eslint/bin/eslint.js` with `createRequire`. When more than two package groups are touched, print `Fast check spans N packages; run pnpm check:affected for dependent validation.` Do not add `--cache`.

- [ ] **Step 5: Expose and test the command**

Add `"check:fast": "node scripts/check-fast.mjs"`, then run:

Run: `node --test scripts/changed-files.test.mjs && pnpm check:fast`

Expected: tests pass; only current changed files are inspected.

- [ ] **Step 6: Commit fast routing**

```bash
git add scripts/changed-files.mjs scripts/changed-files.test.mjs scripts/check-fast.mjs package.json
git commit -m "feat: add changed-file fast check"
```

### Task 4: Establish the warning ratchet and pre-commit hook

**Files:**
- Create: `eslint-suppressions.json`
- Create: `lint-staged.config.mjs`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `AGENTS.md`
- Modify: `docs/contributor-guide/validation.md`

**Interfaces:**
- Consumes: ESLint's default root `eslint-suppressions.json` and explicit staged paths.
- Produces: pre-commit `pnpm exec lint-staged`; stale suppressions fail until explicitly pruned.

- [ ] **Step 1: Generate the native baseline**

Run: `pnpm exec eslint . --suppress-all`

Expected: `eslint-suppressions.json` records the existing violations by file/rule/count.

- [ ] **Step 2: Verify new warnings fail**

Temporarily add one `console.log('ratchet probe')` to a linted source file, run `pnpm exec eslint <file> --max-warnings 0`, verify nonzero, then remove the probe.

- [ ] **Step 3: Install and configure the hook**

Run: `pnpm add -Dw lint-staged simple-git-hooks`

Add to root `package.json`:

```json
"simple-git-hooks": { "pre-commit": "pnpm exec lint-staged" },
"scripts": { "prepare": "simple-git-hooks", "lint:prune": "eslint . --prune-suppressions" }
```

Create `lint-staged.config.mjs`:

```js
const quote = (file) => JSON.stringify(file);
export default {
  '*.{js,mjs,cjs,ts,tsx,json,jsonc,yml,yaml,md}': (files) =>
    `node scripts/check-fast.mjs --staged ${files.map(quote).join(' ')}`
};
```

- [ ] **Step 4: Document non-mutating checks and pruning**

Document `pnpm check:fast`, explicit `pnpm format`, and `pnpm lint:prune`. State that a warning fix must include the pruned suppression file in the same change.

- [ ] **Step 5: Run the complete PR validation**

Run: `pnpm run check:workspace && pnpm run test:tooling && pnpm check:fast && pnpm exec lint-staged --allow-empty`

Expected: PASS; no command modifies tracked files.

- [ ] **Step 6: Commit the ratchet and hook**

```bash
git add eslint-suppressions.json lint-staged.config.mjs package.json pnpm-lock.yaml AGENTS.md docs/contributor-guide/validation.md
git commit -m "feat: ratchet lint warnings in pre-commit"
```

## PR Exit Criteria

- Prettier is absent from manifests and the lockfile.
- The multiple-project ESLint warning is gone.
- `check:fast` scopes to changed paths and introduces no cache or writes.
- A new warning fails while existing suppressed warnings pass.
- Stale suppressions fail until `pnpm lint:prune` updates the baseline.
