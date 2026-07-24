# pnpm Workspace Tooling and Agent Feedback Design

## Summary

The repository has a sound pnpm workspace foundation, but its validation contract is fragmented. CI performs broad build, lint, test, packaging, integration, documentation, and security checks, while local tooling lacks a single fast command that gives an AI agent deterministic feedback after an edit.

This design introduces three root validation tiers, standardizes package scripts, prevents recursive pnpm commands from silently skipping packages, and ratchets existing lint debt without requiring an up-front cleanup. The first tier targets single-digit-second feedback for a single-file change; measurements (see [Validation Evidence](#validation-evidence)) show a ~2.7–4.2s per-invocation floor from the type-aware program build, so the tier must scope to changed files and the multi-project TypeScript setup must be collapsed to references to keep cross-package fan-out within budget.

## Current State

The workspace already provides:

- pnpm 11.5.0 and Node.js requirements at the root;
- frozen-lockfile installs in CI;
- explicit workspace package globs and restricted dependency build scripts;
- internal dependencies declared with the `workspace:` protocol;
- type-aware ESLint for the extension, library, and shared packages;
- workspace build, lint, and test commands;
- multi-platform extension validation, integration tests, packaging, documentation builds, dependency review, vulnerability scans, SBOM generation, and release provenance.

The audit found these immediate feedback gaps (measurements validated 2026-07-24; see [Validation Evidence](#validation-evidence)):

- `pnpm -r lint` takes about 50 seconds and succeeds with ~1,174 warnings (0 errors);
- type-aware ESLint emits `Multiple projects found, consider using a single tsconfig with references to speed up` on every run, because the shared config passes two projects (`tsconfig.json` and `tsconfig.test.json`); the toolchain itself flags the current setup as slow;
- the website and GitHub Action package have no `lint` script and are silently skipped by `pnpm -r lint`;
- the GitHub Action package has no test script and is silently skipped by `pnpm -r test`;
- there is no workspace-wide `typecheck`, `format:check`, or canonical `check` contract;
- npm lockfiles remain under `lib` and `website` alongside the root pnpm lockfile;
- formatting, coverage, dead-code, workflow, ownership, and package-consistency checks are not enforced consistently across the workspace;
- several GitHub Actions and dynamically downloaded CI tools are referenced by mutable versions;
- documented Clean Architecture dependency boundaries are not enforced mechanically;
- the TypeScript project graph, stricter compiler options, extension manifest, webview security, and packaged VSIX contents are not validated as repository contracts.

## Validation Evidence

The following measurements (single developer machine, cold runs unless noted) were taken on 2026-07-24 to validate the feedback-latency assumptions before committing to the fast-loop SLA.

| Scenario | Wall time |
|---|---|
| Full workspace `pnpm -r lint` | 50.7s |
| Extension package, whole (`eslint src test`) | 22.6s |
| Extension package, single file (cold) | 4.2s |
| Extension package, single file (`--cache`, unchanged) | 1.8s (cache hit, no work) |
| `core` package, whole | 5.0s |
| `core` package, single file (cold) | 2.7s |

Warnings by package: `core` 15, `infra` 94, `app` 437, `cli` 5, `lib` 4, extension 619 — total ~1,174, all warnings, zero errors.

Conclusions that shape this design:

- **Changed-file scoping is effective.** One extension file lints in ~4.2s versus 22.6s for the whole package (~5x). Per-file type checking is real work, not fully swamped by program startup, so scoping to changed files pays off.
- **A fixed ~2.7–4.2s floor exists per ESLint invocation** (Node startup plus the typescript-eslint program build). Sub-second feedback is not attainable while type-aware rules run; the realistic fast-loop target is single-digit seconds, not instant.
- **Cross-package fan-out is the real risk to the SLA.** Because `check:affected` includes dependents, editing `packages/core` re-lints `infra`, `app`, `cli`, and the extension, each in its own process rebuilding its own program. Summed, this can approach or exceed 15 seconds even for a one-line change.
- **`--cache` only skips *unchanged* files.** The just-edited file always pays full cost, so `--cache` accelerates whole-package and `check:all` runs, not the already-scoped changed-file path.
- **The `Multiple projects` warning is the concrete speed lever.** Collapsing to a single `tsconfig` with project references (or `projectService`) is what reduces the per-run floor, tying the [TypeScript project graph](#typescript-project-graph-and-strictness) work directly to fast-loop latency.

## Goals

- Give humans and AI agents concise, deterministic feedback after each meaningful edit.
- Keep the default edit-loop check in the single-digit-second range for a single-file change, and define explicit behavior (an escalation cap or a warning) when a change fans out across many packages so latency stays predictable.
- Make local and CI validation use the same root commands.
- Fail when a workspace package is omitted from an expected validation task.
- Prevent new lint warnings while allowing existing warnings to be removed incrementally.
- Enforce workspace metadata, dependency, architecture, formatting, test, and CI configuration invariants.
- Preserve the existing slower packaging, integration, security, and multi-platform merge gates.

## Non-Goals

- Eliminate all ~1,174 existing lint warnings in the initial tooling change.
- Replace pnpm with a monorepo orchestration framework.
- Move integration, packaging, security, or multi-platform checks into the edit loop.
- Add remote build caching.
- Refactor product code unrelated to making a validation rule pass.

## Validation Contract

The root `package.json` is the public interface for repository validation.

### `pnpm check:fast`

This command validates staged files when invoked by the pre-commit hook and uncommitted files relative to `HEAD` when invoked directly. It runs:

- Prettier in check mode for supported changed files;
- ESLint for changed JavaScript and TypeScript files, using the ESLint bulk-suppressions file so new warnings fail while existing suppressed ones do not;
- lightweight repository-file checks selected by file type.

It does not modify files, access the network, build every package, or run broad test suites. It always scopes ESLint to the changed files (never a whole package), since measurements show single-file linting is roughly 5x faster than a full package pass. A single-file change is expected to complete in a few seconds; the type-aware program build imposes a ~2.7–4.2s floor per package touched, so the realistic budget is single-digit seconds for a one-package change rather than a flat sub-15s guarantee. When a change touches files in several packages, `check:fast` still lints only those changed files, but the per-package program-build cost accumulates; the pre-commit invocation warns (and suggests `check:affected`) rather than silently running long.

Because ESLint `--cache` only skips *unchanged* files, it does not speed the just-edited file and is therefore reserved for the whole-package and `check:all` tiers, not this changed-file path.

### `pnpm check:affected`

This command uses pnpm's changed-since filters from the merge base with the configured base branch, includes dependent packages, and runs their required build or typecheck, lint, and unit-test tasks. Repository-wide configuration changes escalate to `check:all`.

This is the required pre-handoff command for an AI agent and the early pull-request validation command.

### `pnpm check:all`

This command validates the complete repository from installed dependencies. It runs workspace integrity, package consistency, formatting, type checking, linting, unit tests, architecture checks, workflow checks, dead-code checks, and coverage ratchets. CI invokes it after a frozen-lockfile install.

Packaging, integration tests, documentation builds, security scans, and operating-system matrices remain separate CI jobs because they have different latency and environment requirements.

## Uniform Package Scripts

Every workspace package declares the scripts applicable to its source type from this standard vocabulary:

- `build`
- `typecheck`
- `lint`
- `test`
- `format:check`

A repository integrity script defines which scripts are mandatory for each package category and fails with the exact package and missing script. This prevents `pnpm -r` from reporting success when packages were silently skipped.

The root commands remain stable even if task orchestration changes later. Package-local commands remain directly runnable for focused diagnosis.

## Warning Ratchet

Changed files permit zero new ESLint warnings. Rather than a custom count-by-file baseline, the ratchet uses ESLint's built-in **bulk suppressions** (`eslint --suppress-all` writing `eslint-suppressions.json`, with `--prune-suppressions` to drop entries that are no longer needed). This is a first-class, maintained mechanism that avoids a bespoke router and the per-file merge conflicts a hand-rolled baseline would generate.

- A new warning, or one exceeding its suppressed count, fails validation.
- Fixing warnings and running `--prune-suppressions` shrinks the file in the same change.
- A removed rule or package drops its stale suppression entries automatically on prune.
- The suppressions file records rule-and-count metadata, not source-line disable comments, so the source stays clean.

As an alternative for rules already staged for removal, the temporary `warn`-level rules in `eslint.shared.mjs` (`temporaryWarnRulesTs`, `temporaryWarnRules`) can be promoted to `error` on changed files via a fast-loop overlay, forcing every touched file to meet the stricter bar without a bulk cleanup.

Whichever mechanism is chosen, it must be a single source of truth shared by `check:fast`, `check:affected`, and `check:all`; the ~1,174 existing warnings are recorded once and only ratcheted downward. Dedicated cleanup changes progressively promote temporary warning rules to errors.

## Tooling

### Code and Repository Files

- Retain the existing type-aware ESLint configuration for correctness rules.
- Establish a single formatting authority. The extension already depends on Prettier `^3.8.0` with `format`/`format:check` scripts (scoped to `.ts`), while `@o3r/eslint-config` and `@stylistic/eslint-plugin` also enforce style. Running both invites conflicting fixers and format ping-pong. Choose one:
  - **Prettier as the formatter** (recommended for the repo-wide check): add `eslint-config-prettier` last in the flat config to disable all stylistic ESLint rules, promote the extension's existing Prettier setup to the workspace, and widen coverage to source, JSON, YAML, and Markdown; or
  - **Keep `@stylistic`/o3r as the formatter** and do not add a second repo-wide Prettier check.
- The decision is a prerequisite for the repo-wide format check; do not layer Prettier on top of active stylistic ESLint rules.
- Add shell and GitHub Actions checks where those files change.
- Add an `.editorconfig` as the editor-level source of truth for indentation, end-of-line, and final-newline, aligned with the chosen formatter.
- Use check-mode commands in validation; formatting fixes remain explicit developer commands.

### TypeScript Project Graph and Strictness

- Treat the project graph as a **lint-speed lever, not only a build concern**. The `Multiple projects found ... consider using a single tsconfig with references to speed up` warning is emitted on every type-aware lint today and is the concrete cause of the per-invocation floor measured in [Validation Evidence](#validation-evidence). A partial solution graph already exists (`packages/tsconfig.json` has `files: []` with references to `core`, `infra`, `app`, `cli`, and each package sets `composite: true`); extend and adopt it rather than starting from scratch.
- Point type-aware ESLint at a single project (via project references or typescript-eslint `projectService`) instead of the current two-project array (`tsconfig.json` + `tsconfig.test.json`) so each lint run builds one program, and clear the warning.
- Use `tsc -b` as the ordered incremental build entry point for referenced packages. Keep declaration and declaration-map output for packages consumed across project boundaries.
- Give bundled applications, including the VS Code extension (webpack + ts-loader), an independent `typecheck` command based on `tsc --noEmit`; the extension bundles outside the `tsc -b` graph, so bundling and type checking must report failures independently.
- Keep common compiler options in `tsconfig.base.json` and keep source, test, and bundled-output concerns in explicit leaf configurations.
- Modernize `moduleResolution`, which is currently the legacy `"node"` in `tsconfig.base.json` and the extension config, to `"bundler"` or `"node16"`/`"nodenext"` as appropriate per package. This is higher-value than several of the strictness flags below and is a prerequisite for accurate module and export diagnostics.
- Ratchet `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `noUncheckedSideEffectImports`, `noUnusedLocals`, and `noUnusedParameters` package by package. Each enabled option becomes part of the shared baseline for packages that pass it and cannot be disabled locally without an explicit exception.
- Keep generated build information outside source directories and remove it through the owning clean task.

### Workspace Integrity

- Use `@manypkg/cli check` for package metadata and dependency-range consistency.
- Use pnpm's `requiredScripts` for universal package contracts, `failIfNoMatch` for filtered commands, and `disallowWorkspaceCycles` for dependency-cycle failures.
- Add a focused repository script only for package-category requirements that pnpm cannot express, expected package discovery, internal `workspace:` dependencies, and root escalation rules.
- Keep one root `pnpm-lock.yaml` and remove residual npm `package-lock.json` files under `lib` and `website`; publishing continues from the pnpm workspace install. Two interactions must be handled in the same change:
  - `AGENTS.md` documents `cd lib && npm test` as lib's own cycle; update that contract to the pnpm workflow (CI already runs `pnpm -C lib`) so removing the lockfile does not break the documented path.
  - `dependency-review.yml` triggers only on `**/package.json` and `**/package-lock.json` and does **not** include `pnpm-lock.yaml`. Removing the npm lockfiles narrows that gate further, and resolved-dependency changes in `pnpm-lock.yaml` already never trigger review. Add `pnpm-lock.yaml` to the dependency-review path filter as part of this cleanup.
- Establish a single source of truth for the Node version and remove the current drift (root `engines.node >=22`, every workspace package `>=18`, docs CI Node 22, extension/lib CI Node 24). Pin one version (for example `.nvmrc` or `packageManager`/Volta) that root `engines`, package `engines`, and every workflow reference, and enforce consistency with a Manypkg engines rule. With `engineStrict: true` already set, the mismatched package floors are a latent failure source.
- Use pnpm catalogs for external dependencies shared across several packages when centralizing them reduces real version drift.
- Enable strict peer-dependency validation unless a narrow documented compatibility exception is required.
- Make package-manager version mismatch and stale installed dependencies fail through `pmOnFail: error` and `verifyDepsBeforeRun: error`.
- Evaluate pnpm supply-chain controls such as minimum release age and trust-policy checks against the repository's release cadence before enforcement. Keep explicit dependency build allowlists and lockfile verification enabled.

### Architecture

Encode the documented dependency direction `core <- infra <- app <- delivery` in ESLint import restrictions. Add dependency-cycle analysis to affected and full validation. Failures name the forbidden edge or cycle rather than only the files involved.

### Dead Code and Coverage

Run Knip and coverage checks outside `check:fast`. Record initial findings as committed baselines or configure narrowly justified entry points. New unused exports, files, or dependencies fail validation.

Coverage thresholds begin at observed package baselines. Thresholds may increase but may not decrease without an explicit tooling-policy change. Coverage remains package-scoped so a well-tested package cannot hide regression in another package.

Because the workspace uses three test runners with different coverage tooling — Vitest (`@vitest/coverage-v8`) in `packages/*`, Mocha in `lib`, and `c8`/`nyc` around Mocha plus Playwright in the extension — the ratchet must normalize to one report format (for example lcov or a summary JSON) per package and treat the extension's integration coverage as best-effort, since Extension Development Host runs are less deterministic. The per-runner extraction strategy is defined before enabling the ratchet.

### CI and Supply Chain

- Run Actionlint for workflow syntax and expression errors.
- Pin third-party GitHub Actions to immutable commit SHAs and let dependency automation update them. The worst current offender is `aquasecurity/trivy-action@master` (a moving branch, not even a tag) used in both `vscode-extension-secure-ci.yml` and `lib-collection-scripts-ci.yml`; pin it first. Tag-pinned actions (`@v4`, `@v2`) should also move to SHAs.
- Install validation tools through the frozen workspace lockfile instead of unpinned `pnpm dlx` or global installs. Concretely: `@vscode/vsce` is already a devDependency (`^3.9.2`) yet CI runs `npm install -g @vscode/vsce` — invoke the local pinned binary instead. The SBOM/license steps use `pnpm dlx @cyclonedx/cyclonedx-npm` and `pnpm dlx license-checker`; add these as pinned devDependencies and call them from the lockfile.
- Configure Dependabot for pnpm and GitHub Actions.
- Add `CODEOWNERS` for package, extension, documentation, workflow, and release-sensitive paths.

### VS Code Extension Contract

- Validate that `engines.vscode`, `@types/vscode`, and the APIs used by the extension describe the same minimum supported VS Code release.
- Check that manifest commands, views, settings, menus, activation events, entry points, and other contributed identifiers correspond to runtime registrations and existing packaged resources.
- Run extension integration tests through an Extension Development Host with unrelated extensions disabled and isolated user-data directories. Cover Stable and Insiders, and add a minimum-supported-version job when an API or manifest change could affect compatibility.
- Declare Workspace Trust and virtual-workspace capabilities explicitly when behavior depends on workspace access. Run separate trusted and untrusted integration configurations for trust-sensitive behavior.
- Require webviews to use the minimum capabilities, restrictive `localResourceRoots`, `default-src 'none'`, `webview.cspSource`, and nonced or external scripts. Validate inbound messages and sanitize user, file, workspace, and settings data before rendering.
- Test webview disposal cleanup, persisted state, high-contrast rendering, screen-reader semantics, and reduced-motion behavior where applicable. Prefer `getState` and `setState` over `retainContextWhenHidden` unless measured behavior requires retention.
- Install `@vscode/vsce` from the workspace lockfile and run a deterministic `vscode:prepublish` command. Do not install packaging tools globally or fetch them dynamically in CI.
- Inspect every generated VSIX against a runtime-file allowlist. Reject source files, tests, development configuration, and unneeded `node_modules`; ratchet bundle and VSIX size to catch accidental growth.
- Install and smoke-test the generated VSIX so CI validates the artifact users receive rather than only the development tree.

## Changed-File Routing

To avoid three overlapping change-detection mechanisms drifting apart, lean on the built-in tools and keep bespoke code thin: `lint-staged` owns the staged-file set at pre-commit, and pnpm `--filter ...[<ref>]` owns package-level affected selection. A custom router is added only for the gaps those cannot express (repository-wide escalation rules and expected-package discovery), not as a parallel file-diff implementation.

The same routing intent serves all validation tiers:

- pre-commit receives the staged file list (via `lint-staged`);
- direct fast checks inspect working-tree changes;
- affected checks compare `HEAD` with the merge base (via pnpm filters);
- full checks select every workspace and repository-level rule.

For `check:affected` and CI, a change to root package metadata, the lockfile, workspace configuration, shared TypeScript or ESLint configuration, validation scripts, or CI workflow definitions escalates to full validation. `check:fast` validates the changed configuration files and workspace metadata with lightweight checks but does not start the full suite. An empty or invalid selection is an error unless the repository is genuinely unchanged.

Generated files are checked through their owning generator or build command and are not formatted independently when doing so would conflict with generation.

## Local Enforcement

`lint-staged` and `simple-git-hooks` run `check:fast` during pre-commit. Standard Git bypass controls remain available for emergencies, but CI enforces the same findings and cannot be bypassed by a local commit option.

`AGENTS.md` documents two mandatory actions:

1. Run the narrowest focused test immediately after a substantive edit.
2. Run `pnpm check:affected` before handing work back.

The commands print concise diagnostics with clickable relative file paths, the failed rule, and a remediation command where one is safe. Validation never auto-fixes files.

## CI Flow

Pull-request validation prioritizes feedback latency:

1. Frozen-lockfile installation and workspace integrity run first.
2. `check:affected` runs early and in parallel with independent security metadata checks.
3. `check:all` verifies the canonical repository contract.
4. Packaging, integration, documentation, security, and multi-platform jobs run as their existing path filters require.

CI workflow steps call root scripts instead of reproducing task lists. This prevents local and remote validation from diverging. Full validation also runs on the default branch to detect path-filter mistakes.

## Failure Handling

Validation distinguishes source findings from tooling failures. It exits nonzero with a specific message for:

- unsupported Node.js or pnpm versions;
- missing installed tools or configuration;
- missing mandatory package scripts;
- an invalid merge base or changed-file selection;
- stale warning, dead-code, or coverage baselines;
- a package that was expected but not selected;
- a check that unexpectedly attempts network access.

Checks do not silently downgrade errors, continue after an invalid setup, or pass because no package matched.

## Verification

Focused tests cover the validation infrastructure itself:

- workspace package discovery and package-category rules;
- missing-script detection;
- staged and merge-base changed-file routing;
- dependent-package inclusion;
- repository-wide escalation;
- empty and invalid selections;
- warning-ratchet increases, decreases, and stale entries;
- architecture boundary violations;
- TypeScript project-reference ordering and stricter-option ratchets;
- extension manifest and runtime-registration mismatches;
- webview security and lifecycle invariants;
- VSIX content allowlist and size-ratchet failures;
- concise nonzero failure output.

CI exercises `check:fast`, `check:affected`, and `check:all` from a clean frozen-lockfile install. Fast-loop latency is tracked as an advisory local benchmark (single-file and representative multi-package cases), not asserted as a hard threshold in a unit test, because wall-clock timing is environment-dependent and would be flaky as a gate.

## Rollout

Each phase is delivered through a separate implementation plan and pull request. A phase must leave the repository with a usable, documented validation contract and must not depend on uncommitted work from a later phase.

### Phase 1: Contract

Normalize package scripts, align runtime requirements, remove residual npm lockfiles, add pnpm-native workspace integrity settings, and expose current silent skips.

### Phase 2: Fast Loop

First resolve the formatting authority (Prettier vs `@stylistic`/o3r) and collapse type-aware ESLint onto a single project (references or `projectService`) so the `Multiple projects` warning is gone and the per-run floor is minimized — this is a prerequisite for a usable fast loop, per [Validation Evidence](#validation-evidence). Then add changed-file formatting and linting, the ESLint native bulk-suppressions ratchet, `check:fast`, and the pre-commit hook wired through `lint-staged`.

### Phase 3: CI Convergence

Add affected routing and make CI invoke the root validation contract. Preserve slower specialized merge gates.

### Phase 4: Governance

Phase 4 is large and is sequenced by value-to-noise so each pull request stays reviewable and low-risk. Prefer the low-false-positive checks first; treat the noisiest ratchets as opt-in until they have proven stable.

**Phase 4a — high-value, low-noise (do first):** Manypkg metadata/consistency and the Node engines rule, Actionlint, SHA-pinning of Actions (starting with `trivy-action@master`), using the local `@vscode/vsce` and pinned SBOM/license tools, Dependabot, `CODEOWNERS`, and `.editorconfig`.

**Phase 4b — architecture and types:** ESLint import boundaries for `core <- infra <- app <- delivery` with dependency-cycle analysis, then the `moduleResolution` modernization, then the strictness-flag ratchets applied package by package (each flag a separate change with its own baseline).

**Phase 4c — deeper, noisier ratchets (opt-in, advisory until stable):** Knip dead-code, package-scoped coverage ratchets (after the per-runner extraction strategy is defined), and the full VS Code extension contract suite (manifest/runtime cross-validation, webview CSP and lifecycle tests, VSIX allowlist and size ratchet, trusted/untrusted integration configs).

Knip, compiler-option, and coverage findings receive explicit baselines or separate cleanup work, never blanket ignores. Items already partly present (the `packages/tsconfig.json` reference graph, the extension's Prettier and `@vscode/vsce` dev dependencies) are adopted and extended rather than reintroduced.

## Success Criteria

- `check:fast` gives single-digit-second feedback for a single-file change (a measured ~2.7–4.2s floor per package), scopes ESLint to changed files, and warns instead of running unbounded when a change fans out across packages.
- Every workspace package is either validated or rejected with an explicit reason.
- Changed files introduce zero ESLint warnings.
- Full-workspace warning, dead-code, and coverage baselines cannot regress.
- Local and CI validation invoke the same root commands.
- Validation tools are installed from the frozen workspace lockfile.
- Architecture violations and package dependency drift fail before merge.
- TypeScript project references build in dependency order and bundled applications typecheck independently.
- Manifest drift, unsafe webview configuration, and unexpected VSIX contents fail before publishing.
- The generated VSIX is installed and smoke-tested in an isolated Extension Development Host.
- Existing packaging, integration, documentation, security, and multi-platform assurance remains intact.
