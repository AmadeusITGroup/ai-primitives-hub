# Implementation Plan: Extension and CLI Migration

**Branch**: `feat/extension-cli-migration` | **Date**: 2026-07-04 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-extension-cli-migration/spec.md`

## Summary

Start from current `main`, keep the VS Code extension behavior stable, and migrate toward a shared TypeScript application engine that supports both the VS Code extension and a first-class CLI. Treat `feat/cli-backup` as a source branch for selective porting in dependency clusters; avoid direct merge because previous analysis found heavy divergence, extension layout conflicts, and package-manager churn.

## Technical Context

**Language/Version**: TypeScript on Node.js; current `main` targets VS Code `^1.99.3`; exact Node version for migrated packages to be fixed during the package-manager slice.

**Primary Dependencies**: VS Code extension API, webpack, ESLint flat config, Mocha, current npm workspace `lib/`; candidate future packages from `feat/cli-backup` include `@prompt-registry/core`, `@prompt-registry/infra`, `@prompt-registry/app`, `@prompt-registry/cli`, and `@prompt-registry/sdk`.

**Storage**: VS Code `globalStorageUri`, repository files, `prompt-registry.lock.json`, target-specific user directories, local cache/temp extraction directories.

**Testing**: Current baseline uses `npm run compile`, `npm run lint`, `npm run test:unit`, `npm run test:integration`, and `npm run test:all`. Future package slices may add per-package tests, CLI command tests, and golden output tests.

**Target Platform**: VS Code extension first; CLI for macOS/Linux/Windows; target layouts for VS Code, VS Code Insiders, Copilot CLI, Kiro, Windsurf, and Claude Code.

**Project Type**: VS Code extension plus shared TypeScript libraries and CLI adapter.

**Performance Goals**: Preserve current extension responsiveness; install/update operations should not add duplicate download/extract/validate passes; CLI commands should complete with one pipeline execution per requested operation.

**Constraints**: Do not break current extension workflows, package output, or lockfile compatibility. Do not make IDE extensions depend on shelling out to the CLI for normal operation. Keep package-manager migration isolated and validated.

**Scale/Scope**: Multi-interface support for one extension, one CLI, and multiple installation targets; initial golden coverage for VS Code and Kiro before expanding.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Preserve User Behavior**: PASS. VS Code behavior is the P1 story and validation baseline.
- **Shared Engine, Native Interfaces**: PASS. Plan keeps CLI first-class while requiring IDE adapters to call shared use cases directly.
- **Target-Driven Installation**: PASS. Requirements mandate layouts, capabilities, scopes, and transformers.
- **Evidence Before Porting**: PASS. Cherry-pick clusters are documented before implementation.
- **Testable Migration Slices**: PASS. Each phase has focused validation.

## Project Structure

### Documentation (this feature)

```text
specs/001-extension-cli-migration/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
└── quickstart.md
```

### Current Source Code Baseline

```text
src/
├── adapters/
├── commands/
├── services/
├── storage/
├── types/
├── ui/
├── utils/
└── extension.ts

lib/
├── src/
└── test/

test/
├── e2e/
├── helpers/
└── services/
```

### Target Source Code Shape

```text
packages/
├── core/        # domain types, schemas, ports, target/capability model
├── infra/       # filesystem, GitHub/HTTP, archive, layout loading, writers
├── app/         # install/update/uninstall/validate/scaffold use cases
├── cli/         # terminal adapter over app/core/infra
└── sdk/         # public programmatic API if still justified

apps/
└── vscode-extension/ or src/  # final location decided by package-manager slice
```

**Structure Decision**: Migrate in two layers. First extract shared contracts and use cases behind the existing `src/` extension to reduce behavior risk. Then decide whether to adopt the full `packages/` and `apps/` monorepo layout from `feat/cli-backup` as a dedicated slice. Do not start with the canonical monorepo commit because it mixes many file moves with package-manager and CI changes.

## Phased Plan

The plan uses architecture phases, while `tasks.md` uses execution phases. Plan Phase 0 maps to Tasks Phase 1 and the golden-baseline parts of Tasks Phase 2. Plan Phase 1 maps to the remaining foundational Tasks Phase 2. Plan Phases 2-4 map to Tasks Phases 3-7.

### Phase 0 - Confirm Baseline and Porting Boundaries

1. Capture clean `main` validation status with `npm install`, `npm run compile`, `npm run lint`, and focused tests.
2. Compare `main` services with `feat/cli-backup` package APIs and identify equivalent behavior.
3. Freeze target behavior with golden output fixtures for current VS Code user and repository installs before shared writer source changes begin.
4. Define the repository-scope secret-safety policy for prompts, instructions, agents, and skills before writer implementation begins.
5. Decide package-manager timing: stay npm for initial extraction or introduce pnpm only in the monorepo slice.

### Phase 1 - Shared Target and Install Contracts

1. Port or reimplement core domain types for bundles, resources, targets, layouts, capabilities, and transformers.
2. Add tests for target validation, layout resolution, and repository-scope secret-safe writes before wiring production code.
3. Introduce explicit shared application use-case ports and implementations for install, update, uninstall, and validate.
4. Introduce a shared writer interface that supports both user and repository scopes through layout definitions.
5. Add Kiro target golden tests as the first non-VS Code target.

### Phase 2 - Application Use Cases

1. Extract install/update/uninstall/validate orchestration into shared application use cases.
2. Adapt existing VS Code services to call shared use cases while retaining VS Code UX, storage, auth, and progress reporting.
3. Ensure repository lockfile behavior remains compatible with current extension expectations.
4. Run existing extension tests plus new golden output tests.

### Phase 3 - CLI Adapter

1. Port the CLI package in a dependency-safe order after shared use cases exist.
2. Keep CLI command behavior scriptable with stable output modes and exit codes.
3. Ensure CLI local, lockfile, and remote install paths all use the same application use cases and writer factory.
4. Add command tests for install, uninstall, validate, list/inspect, errors, and JSON output.

### Phase 4 - Monorepo and CI, If Accepted

1. Move source into `packages/` and `apps/` only after shared behavior is passing.
2. Apply package-manager changes, TypeScript project references, CI, publishing, and documentation together.
3. Re-run compile/lint/test for extension, libraries, CLI, and packaging.

## Cherry-Pick Strategy From `feat/cli-backup`

| Cluster | Candidate Commits | Recommendation | Validation |
|---------|-------------------|----------------|------------|
| Workspace foundation | `d121584`, `b7e3a56` | Defer until package-manager slice; these introduce pnpm workspace assumptions. | Package install, extension compile, CI dry run. |
| Core contracts | `25e713f`, `d8a1f1d`, `3900886`, `fef8fd4` | High-value first port, but prefer reimplementation or selective cherry-pick if paths conflict with `main`. | Core unit tests and target/domain type tests. |
| Infra adapters/writers | `8030749`, `3039306`, `cd2ce23`, `1ff77b8`, `59434aa`, `a0709e8` | Port after core contracts; inspect for hardcoded paths and existing extension service parity. | Writer golden tests and filesystem tests. |
| App use cases | `cc83571`, `17e4d26`, `eb7cb8b`, `14bf71f` | Port after infra; use as source for shared pipeline but reconcile with current `RegistryManager` and `BundleInstaller`. | Extension install/update/uninstall tests plus app use-case tests. |
| CLI and SDK creation | `aa2e318`, `5d726d2`, `c1f9383`, `6df3376` | Port CLI after app use cases; SDK only if public API need remains. | CLI command tests and package build. |
| Canonical monorepo | `3b5c1c9`, `0a228be`, `ec15a5d`, `5e9a2f8`, `8359b59` | Treat `ec15a5d` as high-risk; schedule as dedicated migration or replace with smaller moves. | Full compile/lint/test and packaging. |
| CLI maturation | `c67b5ea`, `b4ab90c`, `77f64a3`, `7309165`, `e6759d8`, `86a4904`, `2948149`, `dc96a01`, `44c5678`, `3c61682`, `665c69a`, `7dcf722`, `2b31fe0`, `e1c841a`, `4ca3e36`, `446dda3` | Port after CLI baseline works; split command framework, UX, scaffolding, plugin/hook, and E2E changes. | CLI unit/E2E tests and fixture output checks. |
| Architecture, transformers, Kiro | `93bb4dc`, `e356efd`, `08d6638`, `10ccdc2`, `9d6a20e`, `11bf009`, `97ab644`, `bf6a499`, `eeba72d`, `3a6a755` | High-value after shared writer exists; prioritize transformation and layout registry, review YAML serialization and remote install path. | VS Code/Kiro golden output tests. |
| Diagnostics and environment hardening | `2ac2773`, `12a44d1`, `8a2f199`, `a4ad600`, `5299597`, `d96ec32`, `76ca45e` | Port near the end after CLI architecture stabilizes. | CLI diagnostics tests, proxy/TLS configuration tests, lint. |

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Temporary dual backend during migration | The existing extension services may coexist with shared app use cases while flows are migrated slice by slice. | Big-bang replacement would combine behavior risk with package layout conflicts. |
| Potential monorepo package split | Required if CLI, shared app, and extension need independent build/test/publish boundaries. | Keeping all code under `src/` and `lib/` may block CLI reuse and target expansion. |

## Open Questions

1. Should the first implementation slice stay on npm to minimize risk, or should pnpm be introduced before package extraction?
2. Is SDK a committed public surface, or should the migration defer it until CLI and VS Code share app use cases?
3. Which target after Kiro is the next priority: Windsurf, Claude Code, or Copilot CLI?
