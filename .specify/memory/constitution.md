# AI Primitives Hub Constitution

## Core Principles

### I. Preserve User Behavior
Existing VS Code extension workflows are the compatibility baseline. Marketplace browsing, source and hub management, profile activation, bundle install/update/uninstall, repository lockfile behavior, WSL-aware user installs, and validation must keep their current observable behavior unless a spec explicitly calls out a change and a migration path.

### II. Shared Engine, Native Interfaces
Business rules belong in shared TypeScript libraries with explicit ports. The VS Code extension, CLI, and future IDE adapters are first-class interfaces over that engine. IDE extensions must not depend on shelling out to the CLI for normal operation; the CLI must remain scriptable and stable for users who prefer terminal workflows.

### III. Target-Driven Installation
Installation behavior must be expressed through target types, scopes, layouts, capabilities, and resource transformers rather than hardcoded IDE path branches. Repository and user scopes must use the same target contract so new IDE support can be added without duplicating installation pipelines.

### IV. Evidence Before Porting
Commits from diverged branches are source material, not automatic truth. Each cherry-pick cluster must have a stated purpose, dependency order, conflict expectation, and focused validation command before being applied. Large layout or package-manager commits require an explicit migration step and rollback point.

### V. Testable Migration Slices
Every implementation slice must be independently testable. Shared libraries need unit and contract tests; CLI flows need command-level tests; VS Code integration needs existing unit/integration coverage to remain green. Golden output tests are required for target file placement and transformations.

## Constraints

- The repository starts from the current `main` branch and uses the existing npm-based VS Code extension layout as the baseline.
- A package-manager or monorepo transition is allowed only as a planned migration slice with CI, packaging, and developer setup updated in the same slice.
- Public schemas, bundle formats, lockfiles, and installed file layouts are compatibility surfaces.
- Security-sensitive agent, prompt, and skill installation must avoid writing secrets into tracked folders.

## Development Workflow

1. Keep Spec Kit artifacts in `specs/` as the source of truth for the migration plan.
2. Port from `feat/cli-backup` in dependency clusters, not by direct merge.
3. Prefer tests before implementation for each cluster.
4. Run the narrowest relevant validation after each cluster, then broaden to compile/lint/test before handoff.
5. Update contributor and user documentation when workflows, commands, targets, or package-management instructions change.

## Governance

This constitution guides all specs and implementation plans in this repository. A change that violates a principle must be documented in the plan's Complexity Tracking table with the rejected simpler alternative. Amendments require updating this file and reviewing active specs for drift.

**Version**: 1.0.0 | **Ratified**: 2026-07-04 | **Last Amended**: 2026-07-04
