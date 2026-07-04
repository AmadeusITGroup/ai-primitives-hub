# Tasks: Extension and CLI Migration

**Input**: Design documents from `specs/001-extension-cli-migration/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `quickstart.md`, `.specify/memory/constitution.md`

**Tests**: Required by the feature specification. Tests must be added before implementation for each migration slice and must fail for missing behavior before the corresponding implementation task is completed.

**Organization**: Tasks are grouped by user story to keep VS Code behavior preservation, CLI delivery, target-driven installation, repository-scope safety, and cherry-pick governance independently testable.

## Phase 1: Setup (Baseline and Migration Controls)

**Purpose**: Confirm the migration starts from current `main`, create evidence logs, and prepare decision records before source changes.

- [x] T001 Record current branch, `main` commit, and `feat/extension-cli-migration` branch base in `specs/001-extension-cli-migration/validation-log.md`
- [x] T002 Run baseline `npm install`, `npm run compile`, `npm run lint`, and `npm run test:unit`, then record command output summaries in `specs/001-extension-cli-migration/validation-log.md`
- [x] T003 [P] Create the cherry-pick cluster ledger with columns for purpose, commits, prerequisites, conflict expectation, decision, rollback point, and validation in `specs/001-extension-cli-migration/cherry-pick-clusters.md`
- [x] T004 [P] Create the package-manager decision record stating npm remains baseline until an accepted package-manager slice in `specs/001-extension-cli-migration/package-manager-decision.md`
- [x] T005 [P] Document the VS Code extension behavior baseline flows and fixture references in `specs/001-extension-cli-migration/vscode-behavior-baseline.md`
- [x] T006 [P] Document the CLI acceptance baseline for install, update, uninstall, validate, list, inspect, stderr errors, JSON output, and exit codes in `specs/001-extension-cli-migration/cli-acceptance.md`
- [x] T007 [P] Define the repository-scope secret-safe install policy for prompts, instructions, agents, and skills, including reject, redact, or route decisions and user-facing diagnostics, in `specs/001-extension-cli-migration/repository-secret-safety-policy.md`
- [x] T008 [P] Document source-port ordering gates requiring Phase 2 before any source port, core before infra, infra before app, app before CLI, and writer/target contracts before target architecture in `specs/001-extension-cli-migration/cherry-pick-clusters.md`

---

## Phase 2: Foundational (Shared Contracts, Golden Baseline, and Application Use Cases)

**Purpose**: Establish golden fixtures, shared target/writer contracts, repository-scope safety policy, and application use cases that block all source-code story work.

**CRITICAL**: No user story implementation or `feat/cli-backup` source port may begin until this phase is complete. T011 and T012 capture the VS Code golden baseline before T017 or any other source-changing foundational implementation.

- [x] T009 [P] Add failing unit tests for target type, scope, capability, layout, and unsupported-resource validation in `test/services/target-model.test.ts`
- [x] T010 [P] Add failing golden output harness helpers for deterministic user and repository target filesystem assertions in `test/helpers/target-golden.ts`
- [x] T011 [P] Capture current VS Code user-scope golden output fixtures for prompts, instructions, agents, and skills before source changes in `test/fixtures/golden/vscode-user/`
- [x] T012 [P] Capture current VS Code repository-scope golden output fixtures and `prompt-registry.lock.json` expectations before source changes in `test/fixtures/golden/vscode-repository/`
- [ ] T013 [P] Add failing migration parity tests for current VS Code install, update, uninstall, move-scope, and lockfile behavior in `test/services/vscode-install-parity.test.ts`
- [ ] T014 [P] Add failing transformer contract tests for idempotent, deterministic, and fail-safe resource transformations in `test/services/resource-transformer.test.ts`
- [ ] T015 [P] Add failing repository-scope secret-safe install tests for prompts, instructions, agents, and skills using secret-like and local-only fixture content in `test/services/repository-install-policy.test.ts`
- [ ] T016 [P] Add failing application use-case contract tests for shared install, update, uninstall, and validate operations in `test/services/application-use-cases.test.ts`
- [x] T017 Define shared Target, TargetScope, TargetLayout, TargetCapability, Resource, ResourceTransformer, and InstallOperation types in `src/types/target.ts`
- [ ] T018 Define shared application use-case interfaces and request/result models for install, update, uninstall, and validate in `src/services/application-use-cases.ts`
- [ ] T019 Implement the target capability registry with VS Code and Kiro placeholders in `src/services/target-capability-registry.ts`
- [ ] T020 Implement the target layout registry with user and repository scope resolution in `src/services/target-layout-registry.ts`
- [ ] T021 Implement the shared target writer port and write result model in `src/services/target-writer.ts`
- [ ] T022 Implement deterministic resource transformer interfaces and diagnostics in `src/services/resource-transformer.ts`
- [ ] T023 Implement repository-scope secret-safe install policy checks and redacted diagnostics for prompts, instructions, agents, and skills in `src/services/repository-install-policy.ts`
- [ ] T024 Implement shared install, update, uninstall, and validate use cases over the target, writer, transformer, and safety-policy ports in `src/services/application-use-cases.ts`
- [ ] T025 Add migration cleanup markers for temporary dual-backend paths in `src/services/migration-guards.ts`
- [ ] T026 Run `npm run compile`, `npm run lint`, and the foundational tests, then record results in `specs/001-extension-cli-migration/validation-log.md`

**Checkpoint**: Golden VS Code fixtures, shared contracts, repository safety policy, writer contracts, and shared application use cases exist; user story implementation can proceed in priority order.

---

## Phase 3: User Story 1 - Preserve VS Code Extension Behavior (Priority: P1) MVP

**Goal**: Existing extension workflows continue to behave like `main` while internals delegate to shared application use cases.

**Independent Test**: Run extension unit and integration tests for install, update, uninstall, repository lockfile handling, repository-scope secret safety, and user-scope path resolution; compare output with the Phase 2 golden baseline.

### Tests for User Story 1

- [ ] T027 [P] [US1] Add VS Code golden comparison tests for user-scope prompts, instructions, agents, and skills in `test/services/vscode-user-golden.test.ts`
- [ ] T028 [P] [US1] Add VS Code golden comparison tests for repository-scope prompts, instructions, agents, skills, and lockfile expectations in `test/services/vscode-repository-golden.test.ts`
- [ ] T029 [P] [US1] Add failing regression tests for WSL and VS Code fork user-path resolution in `test/services/user-scope-service.test.ts`
- [ ] T030 [P] [US1] Add failing regression tests for repository lockfile compatibility during update and uninstall in `test/services/repository-scope-service.test.ts`
- [ ] T031 [P] [US1] Add failing extension service parity tests for install, update, uninstall, and move-scope workflows in `test/services/registry-manager.test.ts`
- [ ] T032 [P] [US1] Add failing VS Code repository-scope diagnostics tests for secret-like prompts, instructions, agents, and skills in `test/services/registry-manager-repository-safety.test.ts`

### Implementation for User Story 1

- [ ] T033 [US1] Adapt `BundleInstaller` to construct shared install and update use-case requests while preserving existing public method signatures in `src/services/bundle-installer.ts`
- [ ] T034 [US1] Adapt `UserScopeService` to resolve VS Code user-scope writes through the target layout contract in `src/services/user-scope-service.ts`
- [ ] T035 [US1] Adapt `RepositoryScopeService` to resolve repository-scope writes through the target layout contract and repository safety policy while preserving `prompt-registry.lock.json` shape in `src/services/repository-scope-service.ts`
- [ ] T036 [US1] Keep `RegistryManager` events, progress, storage integration, and command-facing behavior stable while delegating install, update, uninstall, and validate operations in `src/services/registry-manager.ts`
- [ ] T037 [US1] Verify extension command handlers still surface existing notifications, redacted repository-safety diagnostics, and errors after service delegation in `src/commands/install-bundle.ts`
- [ ] T038 [US1] Run `npm run test:unit`, `npm run test:integration`, `npm run compile`, and `npm run lint`, then record VS Code parity evidence in `specs/001-extension-cli-migration/validation-log.md`

**Checkpoint**: VS Code extension behavior remains compatible with `main`; MVP is independently testable.

---

## Phase 4: User Story 2 - Provide a First-Class CLI (Priority: P1)

**Goal**: Users can run supported terminal commands over the same shared application use cases as the extension, with stable human and JSON output.

**Independent Test**: Run CLI command tests against local fixture bundles and validate installed files, repository-scope safety diagnostics, stderr errors, JSON output, and exit codes.

### Tests for User Story 2

- [ ] T039 [P] [US2] Add failing CLI parser and help-output tests for list, validate, install, update, uninstall, and inspect commands in `test/cli/cli-parser.test.ts`
- [ ] T040 [P] [US2] Add failing CLI local install success tests using fixture bundles in `test/cli/install-command.test.ts`
- [ ] T041 [P] [US2] Add failing CLI invalid-input, unsupported-target, and stderr exit-code tests in `test/cli/error-output.test.ts`
- [ ] T042 [P] [US2] Add failing CLI JSON output stability tests for list, inspect, validate, and install results in `test/cli/json-output.test.ts`
- [ ] T043 [P] [US2] Add failing CLI remote install regression tests that prove remote paths use the shared writer factory in `test/cli/remote-install-command.test.ts`
- [ ] T044 [P] [US2] Add failing CLI repository-scope secret-safe install tests for prompts, instructions, agents, and skills in `test/cli/repository-safety-command.test.ts`

### Implementation for User Story 2

- [ ] T045 [US2] Add the CLI entrypoint and npm bin wiring without changing package manager in `src/cli/index.ts` and `package.json`
- [ ] T046 [US2] Implement CLI command parsing, help text, and shared command context in `src/cli/cli.ts`
- [ ] T047 [US2] Implement CLI install and update commands over shared application use cases in `src/cli/commands/install.ts`
- [ ] T048 [US2] Implement CLI uninstall, validate, list, and inspect commands over shared application use cases in `src/cli/commands/`
- [ ] T049 [US2] Implement CLI output formatters for human-readable and JSON modes in `src/cli/output.ts`
- [ ] T050 [US2] Implement CLI error mapping with actionable stderr messages, redacted repository-safety diagnostics, and non-zero exit codes in `src/cli/errors.ts`
- [ ] T051 [US2] Run CLI tests, `npm run compile`, and `npm run lint`, then record command evidence in `specs/001-extension-cli-migration/validation-log.md`

**Checkpoint**: CLI is a first-class interface and does not duplicate the install pipeline.

---

## Phase 5: User Story 3 - Add IDE Targets Without Copying Pipelines (Priority: P2)

**Goal**: VS Code and Kiro installs are driven by layouts, capabilities, writers, repository-scope safety policy, and transformers, making future targets additive.

**Independent Test**: Run golden output tests for VS Code and Kiro user and repository scopes, including target-specific transformations, unsupported-resource errors, and repository-scope secret-safe handling.

### Tests for User Story 3

- [ ] T052 [P] [US3] Add VS Code layout registry tests for user and repository scopes in `test/services/vscode-target-layout.test.ts`
- [ ] T053 [P] [US3] Add Kiro layout registry tests for user and repository scopes in `test/services/kiro-target-layout.test.ts`
- [ ] T054 [P] [US3] Add VS Code and Kiro golden output fixtures for transformed resources in `test/fixtures/golden/target-layouts/`
- [ ] T055 [P] [US3] Add unsupported capability tests for resources and operations not supported by a target in `test/services/target-capability-registry.test.ts`
- [ ] T056 [P] [US3] Add deterministic serialization tests for YAML or metadata transformations used by target writers in `test/services/resource-transformer.test.ts`
- [ ] T057 [P] [US3] Add repository-scope target layout safety tests proving prompts, instructions, agents, and skills obey the shared safety policy for VS Code and Kiro in `test/services/target-repository-safety.test.ts`

### Implementation for User Story 3

- [ ] T058 [US3] Add concrete VS Code target layouts and capabilities in `src/config/targets/vscode.ts`
- [ ] T059 [US3] Add concrete Kiro target layouts and capabilities in `src/config/targets/kiro.ts`
- [ ] T060 [US3] Add target layout registration and lookup wiring in `src/config/targets/index.ts`
- [ ] T061 [US3] Implement default target writer routing for prompts, instructions, agents, and skills in `src/services/default-target-writer.ts`
- [ ] T062 [US3] Implement Kiro-specific resource transformations without affecting VS Code output in `src/services/kiro-resource-transformer.ts`
- [ ] T063 [US3] Run golden output tests for VS Code and Kiro plus `npm run test:unit`, `npm run compile`, and `npm run lint`, then record target evidence in `specs/001-extension-cli-migration/validation-log.md`

**Checkpoint**: New target support can be added through layout and capability entries rather than a copied pipeline.

---

## Phase 6: User Story 4 - Cherry-Pick From Diverged Work Safely (Priority: P2)

**Goal**: Useful commits from `feat/cli-backup` are selected, ported, deferred, or rejected in dependency clusters with validation after each cluster.

**Independent Test**: Each accepted cluster has a recorded decision, rollback point, expected conflict notes, applied commits or manual-port notes, and validation output before the next cluster starts.

### Decision Gates for User Story 4

- [ ] T064 [P] [US4] Inspect workspace foundation commits `d121584` and `b7e3a56`, then record defer or accept decision in `specs/001-extension-cli-migration/cherry-pick-clusters.md`
- [ ] T065 [P] [US4] Inspect core contracts commits `25e713f`, `d8a1f1d`, `3900886`, and `fef8fd4`, then record cherry-pick, manual-port, defer, or reject decision in `specs/001-extension-cli-migration/cherry-pick-clusters.md`
- [ ] T066 [P] [US4] Inspect infra adapter and writer commits `8030749`, `3039306`, `cd2ce23`, `1ff77b8`, `59434aa`, and `a0709e8`, then record decision in `specs/001-extension-cli-migration/cherry-pick-clusters.md`
- [ ] T067 [P] [US4] Inspect app use-case commits `cc83571`, `17e4d26`, `eb7cb8b`, and `14bf71f`, then record decision in `specs/001-extension-cli-migration/cherry-pick-clusters.md`
- [ ] T068 [P] [US4] Inspect CLI and SDK commits `aa2e318`, `5d726d2`, `c1f9383`, and `6df3376`, then record decision in `specs/001-extension-cli-migration/cherry-pick-clusters.md`
- [ ] T069 [P] [US4] Inspect canonical monorepo commits `3b5c1c9`, `0a228be`, `ec15a5d`, `5e9a2f8`, and `8359b59`, then record dedicated-slice or reject decision in `specs/001-extension-cli-migration/cherry-pick-clusters.md`
- [ ] T070 [P] [US4] Inspect CLI maturation commits `c67b5ea`, `b4ab90c`, `77f64a3`, `7309165`, `e6759d8`, `86a4904`, `2948149`, `dc96a01`, `44c5678`, `3c61682`, `665c69a`, `7dcf722`, `2b31fe0`, `e1c841a`, `4ca3e36`, and `446dda3`, then record split decisions in `specs/001-extension-cli-migration/cherry-pick-clusters.md`
- [ ] T071 [P] [US4] Inspect architecture, transformer, and Kiro commits `93bb4dc`, `e356efd`, `08d6638`, `10ccdc2`, `9d6a20e`, `11bf009`, `97ab644`, `bf6a499`, `eeba72d`, and `3a6a755`, then record decision in `specs/001-extension-cli-migration/cherry-pick-clusters.md`
- [ ] T072 [P] [US4] Inspect diagnostics and environment hardening commits `2ac2773`, `12a44d1`, `8a2f199`, `a4ad600`, `5299597`, `d96ec32`, and `76ca45e`, then record decision in `specs/001-extension-cli-migration/cherry-pick-clusters.md`

### Porting and Validation for User Story 4

- [ ] T073 [US4] Apply or manually port only the accepted core contracts cluster after Phase 2 and T065, then record exact commits or files changed in `specs/001-extension-cli-migration/cherry-pick-clusters.md`
- [ ] T074 [US4] Run core contract tests, `npm run compile`, and `npm run lint`, then record core cluster validation in `specs/001-extension-cli-migration/validation-log.md`
- [ ] T075 [US4] Apply or manually port only the accepted infra adapter and writer cluster after T073, T074, and T066, then record exact commits or files changed in `specs/001-extension-cli-migration/cherry-pick-clusters.md`
- [ ] T076 [US4] Run writer golden tests, filesystem tests, `npm run compile`, and `npm run lint`, then record infra cluster validation in `specs/001-extension-cli-migration/validation-log.md`
- [ ] T077 [US4] Apply or manually port only the accepted app use-case cluster after T075, T076, and T067, then record exact commits or files changed in `specs/001-extension-cli-migration/cherry-pick-clusters.md`
- [ ] T078 [US4] Run extension install, update, uninstall, validate, repository-safety, and app use-case tests plus `npm run compile` and `npm run lint`, then record app cluster validation in `specs/001-extension-cli-migration/validation-log.md`
- [ ] T079 [US4] Apply or manually port only the accepted CLI baseline cluster after T077, T078, and T068, then record exact commits or files changed in `specs/001-extension-cli-migration/cherry-pick-clusters.md`
- [ ] T080 [US4] Run CLI command tests, package build checks, `npm run compile`, and `npm run lint`, then record CLI cluster validation in `specs/001-extension-cli-migration/validation-log.md`
- [ ] T081 [US4] Apply or manually port only the accepted target architecture and Kiro cluster after Phase 2 writer/target contracts, T075, T076, and T071, then record exact commits or files changed in `specs/001-extension-cli-migration/cherry-pick-clusters.md`
- [ ] T082 [US4] Run VS Code and Kiro golden output tests, repository-safety tests, `npm run compile`, and `npm run lint`, then record target cluster validation in `specs/001-extension-cli-migration/validation-log.md`
- [ ] T083 [US4] Apply or manually port only accepted diagnostics and environment hardening commits after CLI baseline validation and T072, then record exact commits or files changed in `specs/001-extension-cli-migration/cherry-pick-clusters.md`
- [ ] T084 [US4] Run diagnostics tests, CLI error-output tests, `npm run compile`, and `npm run lint`, then record diagnostics cluster validation in `specs/001-extension-cli-migration/validation-log.md`
- [ ] T085 [US4] Keep workspace foundation, monorepo, package-manager, SDK, and CLI maturation clusters deferred unless their decision gates define a dedicated slice with rollback and validation in `specs/001-extension-cli-migration/cherry-pick-clusters.md`

**Checkpoint**: Every selected `feat/cli-backup` cluster has evidence, validation, and an explicit outcome.

---

## Phase 7: Polish and Cross-Cutting Validation

**Purpose**: Complete documentation, packaging, cleanup markers, and final migration evidence after desired stories are implemented.

- [ ] T086 [P] Update user CLI documentation for supported commands, output modes, targets, repository-scope safety diagnostics, and examples in `docs/user-guide/cli.md`
- [ ] T087 [P] Update contributor setup and testing documentation for any new CLI, target, repository-safety, or package-layout commands in `docs/contributor-guide/development-setup.md`
- [ ] T088 [P] Update architecture documentation for shared engine, native interfaces, application use cases, target layouts, repository-scope safety, and cherry-pick strategy in `docs/contributor-guide/architecture.md`
- [ ] T089 [P] Update command reference documentation for CLI and extension command parity in `docs/reference/commands.md`
- [ ] T090 Remove temporary migration guards that are no longer needed and document remaining cleanup markers in `specs/001-extension-cli-migration/validation-log.md`
- [ ] T091 Run `npm run compile`, `npm run lint`, `npm run test:unit`, `npm run test:integration`, and `npm run package:vsix`, then record final results in `specs/001-extension-cli-migration/validation-log.md`
- [ ] T092 Produce the final selected, reimplemented, deferred, and rejected commit summary in `specs/001-extension-cli-migration/cherry-pick-clusters.md`
- [ ] T093 Verify all feature requirements FR-001 through FR-013 and success criteria SC-001 through SC-007 are covered, then record the traceability review in `specs/001-extension-cli-migration/validation-log.md`

---

## Dependencies and Execution Order

### Phase Dependencies

- **Phase 1 Setup**: Starts immediately from current `main` baseline and records branch evidence.
- **Phase 2 Foundational**: Depends on Phase 1; blocks all user story source work and all source-port tasks. VS Code golden fixture capture in T011 and T012 must complete before T017 or later source-changing foundational implementation.
- **Phase 3 US1**: Depends on all Phase 2 tasks; uses shared application use cases instead of introducing VS Code-only business rules.
- **Phase 4 US2**: Depends on all Phase 2 tasks and shared application use cases; must not implement a second install pipeline.
- **Phase 5 US3**: Depends on all Phase 2 writer and target contracts; target architecture work must not begin until target layout, capability, writer, transformer, and safety-policy contracts exist.
- **Phase 6 US4**: Decision gate tasks T064-T072 can run after Phase 1; source-port tasks T073-T085 require Phase 2 completion and must follow core before infra, infra before app, app before CLI, and writer/target contracts before target architecture.
- **Phase 7 Polish**: Depends on all desired user stories and accepted cherry-pick clusters.

### User Story Dependencies

- **US1 Preserve VS Code Extension Behavior (P1)**: Starts after Phase 2; no dependency on CLI.
- **US2 Provide a First-Class CLI (P1)**: Starts after Phase 2; depends on shared install, update, uninstall, and validate use cases, not on VS Code UI code.
- **US3 Add IDE Targets Without Copying Pipelines (P2)**: Starts after Phase 2; depends on target layout, writer, transformer, and repository-safety contracts.
- **US4 Cherry-Pick From Diverged Work Safely (P2)**: Decision gates start after Phase 1; actual ports are sequenced by cluster dependency and validation.

### Cherry-Pick Decision Gates

- A cluster is eligible only after its inspection task records purpose, commits, prerequisites, expected conflicts, decision, rollback point, and validation command in `specs/001-extension-cli-migration/cherry-pick-clusters.md`.
- Direct merge of `feat/cli-backup` remains disallowed unless a later plan updates `specs/001-extension-cli-migration/plan.md` and records the complexity exception.
- `ec15a5d` and other monorepo/package-manager commits must stay deferred unless T069 explicitly accepts a dedicated package-manager and layout migration slice.
- Stop porting at the first unresolved behavior change and record the stop reason in `specs/001-extension-cli-migration/validation-log.md`.

### Source-Port Dependency Chain

- Phase 2 foundational completion is required before T073, T075, T077, T079, T081, or T083.
- Core source ports: T073 before T075, T077, T079, T081, and T083.
- Infra source ports: T075 before T077, T079, T081, and T083.
- App source ports: T077 before T079 and T083.
- CLI source ports: T079 before T083 and any CLI maturation slice.
- Writer and target contracts: T017 through T024 before T081 target architecture ports.

### Validation Order

- After each implementation task group, run the narrowest relevant test first.
- After every source-changing Phase 2 task group or accepted cherry-pick cluster, include `npm run lint` with the focused validation command.
- After each accepted cherry-pick cluster, run its cluster validation before inspecting or applying the next source-port cluster.
- Before handoff, run compile, lint, unit tests, integration tests, and VSIX packaging if the slice touches activation, packaging, CLI bin wiring, or target layout behavior.

---

## Parallel Execution Examples

### Phase 1 Setup

```text
Task: T003 Create cherry-pick ledger in specs/001-extension-cli-migration/cherry-pick-clusters.md
Task: T004 Create package-manager decision record in specs/001-extension-cli-migration/package-manager-decision.md
Task: T005 Document VS Code behavior baseline in specs/001-extension-cli-migration/vscode-behavior-baseline.md
Task: T006 Document CLI acceptance baseline in specs/001-extension-cli-migration/cli-acceptance.md
Task: T007 Define repository-scope secret-safe policy in specs/001-extension-cli-migration/repository-secret-safety-policy.md
Task: T008 Document source-port ordering gates in specs/001-extension-cli-migration/cherry-pick-clusters.md
```

### Phase 2 Foundational Tests and Fixtures

```text
Task: T009 Add target model tests in test/services/target-model.test.ts
Task: T010 Add golden harness helpers in test/helpers/target-golden.ts
Task: T011 Capture VS Code user golden fixtures in test/fixtures/golden/vscode-user/
Task: T012 Capture VS Code repository golden fixtures in test/fixtures/golden/vscode-repository/
Task: T015 Add repository safety policy tests in test/services/repository-install-policy.test.ts
Task: T016 Add shared application use-case tests in test/services/application-use-cases.test.ts
```

### User Story 1 Tests

```text
Task: T027 Add VS Code user golden comparison tests in test/services/vscode-user-golden.test.ts
Task: T028 Add VS Code repository golden comparison tests in test/services/vscode-repository-golden.test.ts
Task: T029 Add user path regression tests in test/services/user-scope-service.test.ts
Task: T030 Add lockfile regression tests in test/services/repository-scope-service.test.ts
Task: T031 Add registry manager parity tests in test/services/registry-manager.test.ts
Task: T032 Add extension repository safety diagnostics tests in test/services/registry-manager-repository-safety.test.ts
```

### User Story 2 Tests

```text
Task: T039 Add CLI parser tests in test/cli/cli-parser.test.ts
Task: T040 Add CLI install tests in test/cli/install-command.test.ts
Task: T041 Add CLI error tests in test/cli/error-output.test.ts
Task: T042 Add CLI JSON output tests in test/cli/json-output.test.ts
Task: T043 Add CLI remote install tests in test/cli/remote-install-command.test.ts
Task: T044 Add CLI repository safety tests in test/cli/repository-safety-command.test.ts
```

### User Story 4 Decision Gates

```text
Task: T064 Inspect workspace foundation commits and update specs/001-extension-cli-migration/cherry-pick-clusters.md
Task: T065 Inspect core contracts commits and update specs/001-extension-cli-migration/cherry-pick-clusters.md
Task: T066 Inspect infra adapter and writer commits and update specs/001-extension-cli-migration/cherry-pick-clusters.md
Task: T067 Inspect app use-case commits and update specs/001-extension-cli-migration/cherry-pick-clusters.md
Task: T068 Inspect CLI and SDK commits and update specs/001-extension-cli-migration/cherry-pick-clusters.md
```

---

## Implementation Strategy

### MVP First (US1 Only)

1. Complete Phase 1 setup and Phase 2 foundational contracts, including VS Code golden fixture capture before source changes.
2. Complete Phase 3 to preserve VS Code extension behavior through shared application use cases.
3. Stop and validate extension parity with `npm run test:unit`, `npm run test:integration`, `npm run compile`, and `npm run lint`.
4. Record evidence before adding CLI, broader target support, or source-port clusters.

### Incremental Delivery

1. Baseline and foundations establish golden fixtures, shared contracts, safety policy, application use cases, and tests.
2. US1 preserves current extension behavior and protects production workflows.
3. US2 adds first-class CLI commands over the same shared use cases.
4. US3 adds VS Code and Kiro target layouts and golden output coverage.
5. US4 selectively ports validated `feat/cli-backup` clusters in the explicit core, infra, app, CLI, target, and diagnostics order, stopping after each cluster for evidence.
6. Polish updates documentation, packaging validation, and final traceability.

### Porting Policy

1. Prefer manual port or reimplementation when a `feat/cli-backup` commit depends on pnpm workspace layout or moved package paths.
2. Cherry-pick only when the cluster applies cleanly to the current npm-based layout and preserves VS Code behavior.
3. Apply source-port clusters only after Phase 2 validates with tests, compile, and lint.
4. Port core before infra, infra before app, app before CLI, and target architecture only after writer/target contracts exist.
5. Defer SDK, monorepo, diagnostics hardening, and CLI maturation until CLI baseline and target writer contracts are stable.
6. Record every accepted, rejected, deferred, and reimplemented commit in `specs/001-extension-cli-migration/cherry-pick-clusters.md`.

---

## Notes

- [P] tasks use separate files or independent docs/test fixtures and can run in parallel.
- [US1], [US2], [US3], and [US4] labels map tasks to the feature specification user stories.
- Tests are intentionally present because the spec requires independent test criteria, golden output coverage, CLI command tests, repository-scope safety coverage, and migration-slice validation.
- Keep source edits small and reversible; validate after each story or cherry-pick cluster before continuing.
- Do not modify package-manager, monorepo layout, CI, or publishing files unless the package-manager slice is explicitly accepted and documented.# Tasks: Extension and CLI Migration

**Input**: Design documents from `specs/001-extension-cli-migration/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `quickstart.md`, `.specify/memory/constitution.md`

**Tests**: Required by the feature specification. Tests must be added before implementation for each migration slice and must fail for missing behavior before the corresponding implementation task is completed.

**Organization**: Tasks are grouped by user story to keep VS Code behavior preservation, CLI delivery, target-driven installation, and cherry-pick governance independently testable.

## Phase 1: Setup (Baseline and Migration Controls)

**Purpose**: Confirm the migration starts from current `main`, create evidence logs, and prepare decision records before source changes.

---

## Phase 2: Foundational (Shared Contracts, Golden Baseline, and Application Use Cases)

**Purpose**: Establish golden fixtures, shared target/writer contracts, repository-scope safety policy, and application use cases that block all source-code story work.

**CRITICAL**: No user story implementation or `feat/cli-backup` source port may begin until this phase is complete. T011 and T012 capture the VS Code golden baseline before T017 or any other source-changing foundational implementation.

---

## Phase 3: User Story 1 - Preserve VS Code Extension Behavior (Priority: P1) MVP

**Goal**: Existing extension workflows continue to behave like `main` while internals delegate to shared application use cases.

**Independent Test**: Run extension unit and integration tests for install, update, uninstall, repository lockfile handling, repository-scope secret safety, and user-scope path resolution; compare output with the Phase 2 golden baseline.

### Tests for User Story 1

---

## Phase 4: User Story 2 - Provide a First-Class CLI (Priority: P1)

**Goal**: Users can run supported terminal commands over the same shared application use cases as the extension, with stable human and JSON output.

**Independent Test**: Run CLI command tests against local fixture bundles and validate installed files, repository-scope safety diagnostics, stderr errors, JSON output, and exit codes.

### Tests for User Story 2

---

## Phase 5: User Story 3 - Add IDE Targets Without Copying Pipelines (Priority: P2)

**Goal**: VS Code and Kiro installs are driven by layouts, capabilities, writers, repository-scope safety policy, and transformers, making future targets additive.

**Independent Test**: Run golden output tests for VS Code and Kiro user and repository scopes, including target-specific transformations, unsupported-resource errors, and repository-scope secret-safe handling.

### Tests for User Story 3

---

## Phase 6: User Story 4 - Cherry-Pick From Diverged Work Safely (Priority: P2)

**Goal**: Useful commits from `feat/cli-backup` are selected, ported, deferred, or rejected in dependency clusters with validation after each cluster.

**Independent Test**: Each accepted cluster has a recorded decision, rollback point, expected conflict notes, applied commits or manual-port notes, and validation output before the next cluster starts.

### Decision Gates for User Story 4

---

## Phase 7: Polish and Cross-Cutting Validation

**Purpose**: Complete documentation, packaging, cleanup markers, and final migration evidence after desired stories are implemented.

---

## Dependencies and Execution Order

### Phase Dependencies

---

### User Story Dependencies

---

### Cherry-Pick Decision Gates

---

### Source-Port Dependency Chain

---

### Validation Order

---

## Parallel Execution Examples

---

## Implementation Strategy

---

## Porting Policy

---
