# Package Manager Decision

## Decision

Keep `npm` as the baseline package manager for the first migration slices.

## Rationale

- Current `main` uses the root npm package with a nested npm workspace for `lib/`.
- The VS Code extension build, test, and packaging scripts are already documented around npm commands.
- The diverged branch's pnpm workspace and monorepo layout are valuable, but they combine package-manager, source-layout, TypeScript, CI, and publishing changes.
- Deferring pnpm avoids mixing behavior migration with repository-wide tooling churn.

## Deferred Option

The pnpm monorepo can be accepted later as a dedicated migration slice if shared libraries and CLI boundaries prove the package split is required.

## Acceptance Criteria For A Future Package-Manager Slice

- It has a rollback point before lockfile and workspace metadata changes.
- It updates contributor setup, CI, package, publish, lint, and test documentation in the same slice.
- It proves VS Code extension compile, lint, unit, integration, and VSIX packaging still pass.
- It does not hide unrelated source behavior changes inside file moves.