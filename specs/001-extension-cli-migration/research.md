# Research: Extension and CLI Migration

## Decision 1: Start From `main`, Not `feat/cli-backup`

**Decision**: Use `main` as the base and port selected work from `feat/cli-backup`.

**Rationale**: The current production extension and recent docs/CI/dependency work are on `main`. Prior merge simulation showed the diverged branch is too large to merge casually, with hundreds of conflicting paths and heavy overlap around source layout, workflows, and package metadata.

**Alternatives Considered**:

- Directly merge `feat/cli-backup`: rejected because conflicts would hide behavior regressions.
- Merge `main` into `feat/cli-backup`: rejected as a reconciliation project rather than a clean alignment step.

## Decision 2: Keep CLI First-Class But Not the Backend for IDEs

**Decision**: CLI is a first-class adapter over shared app use cases. IDE extensions call those use cases directly rather than shelling out to the CLI for normal operation.

**Rationale**: Users need CLI workflows, but IDEs need native progress, auth, cancellation, storage, and error presentation. A CLI-only backend would force IDE adapters through terminal concerns and reduce integration quality.

**Alternatives Considered**:

- CLI as the only backend: rejected because it would make IDE integrations brittle and harder to test.
- Separate CLI and extension implementations: rejected because it duplicates install and validation behavior.

## Decision 3: Use Target Layouts Plus Capabilities

**Decision**: Represent IDE/platform support through target types, scope, layout routing, capability declarations, and optional resource transformers.

**Rationale**: Layouts answer where files go; capabilities answer which resource types and operations are supported. Both are required for scalable target support.

**Alternatives Considered**:

- Hardcoded repository writer paths: rejected because it only scales for GitHub/Copilot layouts.
- Transformer-only target support: rejected because path routing and unsupported operations still need a declarative contract.

## Decision 4: Isolate Package-Manager Migration

**Decision**: Treat pnpm/monorepo migration as its own slice unless the first source-code port proves it is unavoidable.

**Rationale**: Current `main` is npm-based. `feat/cli-backup` contains valuable package boundaries, but package-manager churn affects CI, publishing, contributors, and extension packaging.

**Alternatives Considered**:

- Cherry-pick the canonical monorepo commit early: rejected because it mixes many file moves and build changes.
- Never introduce packages: rejected because shared CLI/extension ownership likely needs clearer package boundaries.

## Decision 5: Golden Output Tests Are Required

**Decision**: Add golden output tests for target file placement and transformations before broad target expansion.

**Rationale**: Multi-IDE support is mostly observable through installed files. Golden tests catch path routing, resource naming, and transformation regressions cheaply.

**Alternatives Considered**:

- Only unit-test layout helpers: rejected because it misses full install behavior.
- Only integration-test VS Code: rejected because Kiro and future targets need independent confidence.