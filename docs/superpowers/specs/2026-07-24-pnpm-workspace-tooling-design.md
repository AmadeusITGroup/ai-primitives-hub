# pnpm Workspace Tooling and Agent Feedback Design

## Summary

The repository has a sound pnpm workspace foundation, but its validation contract is fragmented. CI performs broad build, lint, test, packaging, integration, documentation, and security checks, while local tooling lacks a single fast command that gives an AI agent deterministic feedback after an edit.

This design introduces three root validation tiers, standardizes package scripts, prevents recursive pnpm commands from silently skipping packages, and ratchets existing lint debt without requiring an up-front cleanup. The first tier must complete in under 15 seconds for a typical small change.

## Current State

The workspace already provides:

- pnpm 11.5.0 and Node.js requirements at the root;
- frozen-lockfile installs in CI;
- explicit workspace package globs and restricted dependency build scripts;
- internal dependencies declared with the `workspace:` protocol;
- type-aware ESLint for the extension, library, and shared packages;
- workspace build, lint, and test commands;
- multi-platform extension validation, integration tests, packaging, documentation builds, dependency review, vulnerability scans, SBOM generation, and release provenance.

The audit found these immediate feedback gaps:

- `pnpm run lint` takes about 56 seconds and succeeds with 1,207 warnings;
- the website and GitHub Action package have no `lint` script and are silently skipped by `pnpm -r lint`;
- the GitHub Action package has no test script and is silently skipped by `pnpm -r test`;
- there is no workspace-wide `typecheck`, `format:check`, or canonical `check` contract;
- npm lockfiles remain under `lib` and `website` alongside the root pnpm lockfile;
- formatting, coverage, dead-code, workflow, ownership, and package-consistency checks are not enforced consistently across the workspace;
- several GitHub Actions and dynamically downloaded CI tools are referenced by mutable versions;
- documented Clean Architecture dependency boundaries are not enforced mechanically.

## Goals

- Give humans and AI agents concise, deterministic feedback after each meaningful edit.
- Keep the default edit-loop check below 15 seconds for a representative small change.
- Make local and CI validation use the same root commands.
- Fail when a workspace package is omitted from an expected validation task.
- Prevent new lint warnings while allowing existing warnings to be removed incrementally.
- Enforce workspace metadata, dependency, architecture, formatting, test, and CI configuration invariants.
- Preserve the existing slower packaging, integration, security, and multi-platform merge gates.

## Non-Goals

- Eliminate all 1,207 existing lint warnings in the initial tooling change.
- Replace pnpm with a monorepo orchestration framework.
- Move integration, packaging, security, or multi-platform checks into the edit loop.
- Add remote build caching.
- Refactor product code unrelated to making a validation rule pass.

## Validation Contract

The root `package.json` is the public interface for repository validation.

### `pnpm check:fast`

This command validates staged files when invoked by the pre-commit hook and uncommitted files relative to `HEAD` when invoked directly. It runs:

- Prettier in check mode for supported changed files;
- ESLint for changed JavaScript and TypeScript files, compared with the committed warning baseline so new warnings fail;
- lightweight repository-file checks selected by file type.

It does not modify files, access the network, build every package, or run broad test suites. A normal small change must complete in under 15 seconds.

### `pnpm check:affected`

This command computes changes from the merge base with the configured base branch, maps them to workspace packages, includes dependent packages, and runs their required build or typecheck, lint, and unit-test tasks. Repository-wide configuration changes escalate to `check:all`.

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

Changed files permit zero new ESLint warnings. The baseline records warning counts by file and rule, while full-workspace lint also compares aggregate counts by package and rule.

- A new warning or an increased count fails validation.
- A reduced count updates the expected baseline in the same change.
- A removed rule or package must remove its stale baseline entry.
- Baseline data records file-and-rule counts, not source-line suppressions.

This makes every touched area stricter immediately without requiring an unrelated bulk cleanup. Dedicated cleanup changes can progressively promote temporary warning rules to errors.

## Tooling

### Code and Repository Files

- Retain the existing type-aware ESLint configuration.
- Add one repository-wide Prettier check covering supported source, JSON, YAML, and Markdown files.
- Add shell and GitHub Actions checks where those files change.
- Use check-mode commands in validation; formatting fixes remain explicit developer commands.

### Workspace Integrity

- Use `@manypkg/cli check` for package metadata and dependency-range consistency.
- Add a focused repository script for expected package discovery, mandatory scripts, internal `workspace:` dependencies, and root escalation rules.
- Keep one root `pnpm-lock.yaml` and remove residual npm `package-lock.json` files; publishing continues from the pnpm workspace install.
- Use pnpm catalogs for external dependencies shared across several packages when centralizing them reduces real version drift.

### Architecture

Encode the documented dependency direction `core <- infra <- app <- delivery` in ESLint import restrictions. Add dependency-cycle analysis to affected and full validation. Failures name the forbidden edge or cycle rather than only the files involved.

### Dead Code and Coverage

Run Knip and coverage checks outside `check:fast`. Record initial findings as committed baselines or configure narrowly justified entry points. New unused exports, files, or dependencies fail validation.

Coverage thresholds begin at observed package baselines. Thresholds may increase but may not decrease without an explicit tooling-policy change. Coverage remains package-scoped so a well-tested package cannot hide regression in another package.

### CI and Supply Chain

- Run Actionlint for workflow syntax and expression errors.
- Pin third-party GitHub Actions to immutable commit SHAs and let dependency automation update them.
- Install validation tools through the frozen workspace lockfile instead of unpinned `pnpm dlx` or global installs.
- Configure Dependabot for pnpm and GitHub Actions.
- Add `CODEOWNERS` for package, extension, documentation, workflow, and release-sensitive paths.

## Changed-File Routing

The same routing logic serves all validation tiers:

- pre-commit receives the staged file list;
- direct fast checks inspect working-tree changes;
- affected checks compare `HEAD` with the merge base;
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
- concise nonzero failure output.

CI exercises `check:fast`, `check:affected`, and `check:all` from a clean frozen-lockfile install. Representative timing tests verify the fast loop remains below 15 seconds without turning timing variance into a flaky unit test.

## Rollout

Each phase is delivered through a separate implementation plan and pull request. A phase must leave the repository with a usable, documented validation contract and must not depend on uncommitted work from a later phase.

### Phase 1: Contract

Normalize package scripts, align runtime requirements, remove residual npm lockfiles, add workspace integrity checks, and expose current silent skips.

### Phase 2: Fast Loop

Add changed-file formatting and linting, the warning baseline framework and ratchet logic, `check:fast`, and the pre-commit hook.

### Phase 3: CI Convergence

Add affected routing and make CI invoke the root validation contract. Preserve slower specialized merge gates.

### Phase 4: Governance

Add architecture and cycle checks, Manypkg, Actionlint, Knip, package-scoped coverage ratchets, dependency automation, immutable Action pins, and ownership rules. Knip and coverage findings receive explicit baselines or separate cleanup work, never blanket ignores.

## Success Criteria

- `check:fast` completes in under 15 seconds for representative small changes.
- Every workspace package is either validated or rejected with an explicit reason.
- Changed files introduce zero ESLint warnings.
- Full-workspace warning, dead-code, and coverage baselines cannot regress.
- Local and CI validation invoke the same root commands.
- Validation tools are installed from the frozen workspace lockfile.
- Architecture violations and package dependency drift fail before merge.
- Existing packaging, integration, documentation, security, and multi-platform assurance remains intact.
