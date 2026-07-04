# Feature Specification: Extension and CLI Migration

**Feature Branch**: `feat/extension-cli-migration`

**Spec Directory**: `specs/001-extension-cli-migration`

**Created**: 2026-07-04

**Status**: Draft

**Input**: User description: "Start from main, set up GitHub Spec Kit, create feat/extension-cli-migration, prepare specs and implementation plan, then identify relevant commits to cherry-pick from feat/cli-backup. CLI remains a must because some users prefer CLI."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Preserve VS Code Extension Behavior (Priority: P1)

As an existing AI Primitives Hub user, I can continue using the VS Code extension to browse hubs, manage sources and profiles, install/update/uninstall bundles, and move bundles between user and repository scopes after the internals are migrated.

**Why this priority**: The extension is the production surface on `main`; migration that breaks current workflows is a regression, even if the new architecture is cleaner.

**Independent Test**: Run existing extension unit and integration tests against the migrated implementation and verify representative install/update/uninstall flows still produce the same files and lockfile entries.

**Acceptance Scenarios**:

1. **Given** a configured hub source and available bundle, **When** the user installs the bundle through the extension, **Then** the same target files, metadata, and UI state appear as on `main`.
2. **Given** a repository-scoped installed bundle, **When** the user updates or uninstalls it through the extension, **Then** the repository files and `prompt-registry.lock.json` remain consistent with current behavior.
3. **Given** a user running in WSL or a VS Code fork, **When** the extension installs user-scoped resources, **Then** path resolution remains compatible with the existing scope services.

---

### User Story 2 - Provide a First-Class CLI (Priority: P1)

As a user who prefers terminal workflows, I can use a supported CLI to list, validate, install, update, uninstall, and inspect AI primitive bundles without opening VS Code.

**Why this priority**: CLI support is a product requirement, not an internal implementation detail.

**Independent Test**: Run CLI command tests against local fixture bundles and verify human-readable and machine-readable output, exit codes, and installed files.

**Acceptance Scenarios**:

1. **Given** a valid local collection bundle, **When** the user runs the CLI install command for a supported target and scope, **Then** the CLI writes the expected files and exits successfully.
2. **Given** invalid input or an unsupported target, **When** the user runs a CLI command, **Then** the CLI reports an actionable error on stderr and exits non-zero.
3. **Given** automation scripts, **When** they invoke CLI commands with JSON output, **Then** responses are stable enough for scripted consumption.

---

### User Story 3 - Add IDE Targets Without Copying Pipelines (Priority: P2)

As a maintainer, I can add support for targets such as Kiro, Windsurf, Claude Code, Copilot CLI, VS Code, and VS Code Insiders by defining target capabilities, layouts, and transformations rather than forking the install pipeline.

**Why this priority**: Multi-IDE scale depends on a shared target model, not scattered path conditionals.

**Independent Test**: Add golden output tests for at least VS Code and Kiro user and repository installs, including target-specific transformations.

**Acceptance Scenarios**:

1. **Given** a target layout definition, **When** a bundle is installed for that target, **Then** resources route to the layout-defined directories for prompts, instructions, agents, and skills.
2. **Given** a target-specific transformer, **When** a resource requires adaptation, **Then** only that target's output changes and unsupported resources fail safely.
3. **Given** a new target with no transformer, **When** common resource types are installed, **Then** the default writer uses the target layout without custom code.

---

### User Story 4 - Cherry-Pick From Diverged Work Safely (Priority: P2)

As a maintainer, I can review `feat/cli-backup` as a source branch and port useful commits in dependency clusters with validation after each cluster.

**Why this priority**: Direct merge analysis showed heavy divergence and many conflicts; one-by-one selection reduces risk.

**Independent Test**: For each cluster, cherry-pick or reimplement into a fresh branch, run the planned validation command, and stop at the first unresolved behavior change.

**Acceptance Scenarios**:

1. **Given** the fresh migration branch, **When** a cluster is selected, **Then** the plan identifies its commits, expected conflicts, and validation command before any cherry-pick.
2. **Given** a high-risk package layout commit, **When** it is considered, **Then** the plan either schedules it as a dedicated migration slice or rejects it in favor of incremental package extraction.

### Edge Cases

- `feat/cli-backup` commits may depend on files moved into a pnpm monorepo layout that does not exist on `main`.
- CLI remote install paths may bypass the shared writer factory unless explicitly refactored.
- Repository-scope writers may remain hardcoded to `.github` unless layout-driven scope handling is part of the migration.
- Some targets may support only a subset of resource types; unsupported routes must be explicit and test-covered.
- Existing user data, lockfiles, or installed files may have legacy shapes and must not be silently corrupted.
- Package-manager migration may affect CI, release packaging, extension publishing, and contributor setup.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST preserve existing VS Code extension user workflows on `main` during and after migration.
- **FR-002**: The system MUST provide a CLI as a first-class supported interface, not merely as an internal helper for IDE extensions.
- **FR-003**: The system MUST expose shared application-layer use cases that can be called by both CLI and VS Code adapters.
- **FR-004**: IDE adapters MUST call shared use cases in-process where practical and MUST keep IDE-specific UI, authentication, notifications, and storage integration local to the IDE adapter.
- **FR-005**: Installation MUST be target-driven through typed targets, scopes, layouts, capabilities, and optional resource transformers.
- **FR-006**: Repository-scope and user-scope installs MUST use the same target layout contract.
- **FR-007**: Target-specific transformations MUST be idempotent, deterministic, and fail-safe.
- **FR-008**: The migration MUST include golden output coverage for VS Code and Kiro user and repository installation layouts before broadening to more targets.
- **FR-009**: The migration MUST document each selected `feat/cli-backup` cherry-pick cluster with purpose, commit list, prerequisites, and validation.
- **FR-010**: The migration MUST avoid direct merge of `feat/cli-backup` into `main` unless a later plan proves conflict volume and behavior risk acceptable.
- **FR-011**: The migration MUST update user and contributor documentation when commands, package management, target support, or setup flows change.
- **FR-012**: The migration MUST keep build, lint, unit, and integration validation runnable from documented commands.
- **FR-013**: Repository-scope installation MUST protect against accidentally committing secrets or local-only private artifacts from prompts, instructions, agents, and skills by providing explicit policy, tests, and user-facing diagnostics.

### Key Entities *(include if feature involves data)*

- **Bundle**: Versioned collection of prompts, instructions, agents, skills, manifests, and metadata that can be installed or removed.
- **Target**: Destination environment such as VS Code, VS Code Insiders, Copilot CLI, Kiro, Windsurf, or Claude Code, including scope and optional workspace root.
- **Target Layout**: Declarative mapping from resource categories to filesystem paths for a target and scope.
- **Target Capability**: Explicit support statement for resource types, scope modes, lockfile behavior, transformation needs, and unsupported operations.
- **Resource Transformer**: Pure target-specific conversion applied to resource content or paths before writing.
- **Install Pipeline**: Shared application use case that resolves, downloads, validates, transforms, writes, and records bundle installation state.
- **Adapter**: Interface-specific shell for VS Code, CLI, or a future IDE that handles UX and delegates business behavior to shared use cases.
- **Cherry-Pick Cluster**: Ordered group of commits from `feat/cli-backup` that can be reviewed, ported, and validated as one migration slice.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Existing `main` validation commands for compile, lint, and tests pass after the migration slices that affect source code.
- **SC-002**: VS Code extension install/update/uninstall behavior is covered by existing or added tests with no known behavior regressions.
- **SC-003**: CLI installation and validation commands have automated tests covering success, invalid input, and JSON output.
- **SC-004**: Golden output tests cover at least VS Code and Kiro for user and repository scopes.
- **SC-005**: Adding a new target requires a layout/capability entry and optional transformer, without creating a second install pipeline.
- **SC-006**: The final migration PR contains a documented list of cherry-picked, reimplemented, deferred, and rejected `feat/cli-backup` commits.
- **SC-007**: Repository-scope install tests prove secret-like or local-only sensitive content is rejected, redacted, or routed according to the documented policy before any writer implementation is accepted.

## Assumptions

- The starting point for implementation is current `main`, not `feat/cli-backup`.
- `feat/cli-backup` is valuable as a prototype and source of commit clusters, but its branch shape is not automatically accepted.
- CLI support is in scope for the migration; additional IDE marketplace publishing is out of scope unless required for target validation.
- The initial implementation can prioritize VS Code and Kiro target coverage before expanding to Windsurf, Claude Code, and Copilot CLI.
- The package-manager strategy will be decided during implementation planning; npm remains the baseline until a package-manager migration slice is accepted.
