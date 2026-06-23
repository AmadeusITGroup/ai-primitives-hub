# Copilot Instructions for Contributors and AI Agents

These are short, actionable notes to help an AI coding assistant be productive in this repository.

**🚨 MANDATORY FIRST STEP: Read Folder-Specific Guidance BEFORE Writing Code 🚨**

Before working in any folder, **MUST READ** the corresponding AGENTS.md file:

| Working in... | Read first |
|---------------|------------|
| `docs/` | `docs/AGENTS.md` — Documentation structure, placement, and discovery |
| `test/` | `test/AGENTS.md` — Test writing patterns and helpers |
| `test/e2e/` | `test/e2e/AGENTS.md` — E2E test patterns |
| `src/adapters/` | `src/adapters/AGENTS.md` — Adapter interface and implementation |
| `src/services/` | `src/services/AGENTS.md` — Service layer patterns |

**Before writing or modifying ANY file:**
1. Identify which folder the file is in (e.g., `test/services/foo.test.ts` → `test/`)
2. Read that folder's `AGENTS.md` first
3. Apply its guidance

Skipping these guides leads to broken VS Code mocks, duplicated utilities, and deviation from established patterns.

---

## Development Methodology

### Bug Fixes: Test First

1. **Reproduce first**: Create a failing test that demonstrates the bug
2. **Confirm failure**: Run the test, verify it fails as expected
3. **Fix the code**: Make the minimal change to fix the issue
4. **Confirm fix**: Run the test, verify it passes
5. **No regression**: Run related tests to ensure nothing broke

### Debugging: Isolate the Fault Location

When tests fail, determine whether the bug is in **test code** or **production code** BEFORE iterating:

1. **Read error messages carefully**: `expected X, got Y` tells you what the code produced vs what was expected
2. **Add debug logging to production code first**: If the test setup looks correct, the bug is likely in production code
3. **Trace data transformations**: When IDs or values change unexpectedly, log at each transformation point
4. **Check for inconsistent code paths**: Different entry points (e.g., `installBundle` vs `updateBundle`) may use different logic
5. **Validate assumptions with real-world testing**: If possible, reproduce the issue in the actual extension before fixing

**Red flags that the bug is in production code:**
- Test fixtures match documented formats but validation fails
- Multiple test approaches fail with the same error pattern
- Error shows data transformation (e.g., `v1.0.0` → `1.0.0`) not present in test code

**Anti-pattern**: Repeatedly modifying test fixtures when the error message shows production code is transforming data incorrectly.

### Test-Driven Development (TDD)

Use TDD when it makes sense (most new functionality):
1. Write a failing test for the expected behavior
2. Write the minimum code to make it pass
3. Refactor if needed, keeping tests green

### E2E Testing

E2E tests must invoke actual code paths, never reimplement production code. See `test/e2e/AGENTS.md` for detailed patterns and examples.

### Test Completion Criteria

See `test/AGENTS.md` for the full test completion checklist. Key rule: if tests won't run due to setup issues **you** introduced, the task is incomplete.

### Minimal Code Principle

- Write the **absolute minimum** code to solve the requirement
- No extras, no abstractions, no "nice-to-haves"
- Every line must directly contribute to the solution—if it doesn't, delete it
- Prefer simple, direct implementations over clever ones

### Backward Compatibility

- **Do NOT** try to be backward compatible with changes just introduced in the same session or in the current changed files
- **For new features**: Ask the user if backward compatibility is required before proposing a design
- If backward compatibility is needed, document the migration path

### Discovery Before Design

Before implementing anything new:
1. Search for existing similar functionality (`grep -r "class.*Manager" src/`)
2. Check if utilities already exist in `src/utils/` or `test/helpers/`
3. Review tests for established patterns
4. Reuse before rewriting, consolidate before duplicating

---

## Big Picture

This is a VS Code extension (AI Primitives Hub) that provides a marketplace and registry for Copilot prompt bundles.

### Architecture Overview

```
src/
├── adapters/     → Source-specific implementations (GitHub, Local, etc.)
├── commands/     → VS Code command handlers
├── services/     → Core business logic (RegistryManager, BundleInstaller, etc.)
├── storage/      → Persistent state management
├── types/        → TypeScript type definitions
├── ui/           → UI providers (Marketplace WebView, Tree View)
├── utils/        → Shared utilities
└── extension.ts  → Entry point
```

### Key Components

- **UI surface**: `src/ui/*` (Marketplace and `RegistryTreeProvider`)
- **Orchestration**: `src/services/RegistryManager.ts` (singleton) coordinates adapters, storage, and installer
- **Installation flow**: adapters produce bundle metadata/URLs → `BundleInstaller` downloads/extracts/validates → scope services sync to target directories
- **Scope services**: `UserScopeService` (user/workspace) and `RepositoryScopeService` (repository) handle scope-specific file placement
- **Lockfile management**: `LockfileManager` manages `prompt-registry.lock.json` for repository-scoped bundles

### Key Files

| File | Purpose |
|------|---------|
| `src/services/registry-manager.ts` | Main entrypoint, event emitters |
| `src/services/bundle-installer.ts` | Download/extract/validate/install logic |
| `src/services/lockfile-manager.ts` | Lockfile CRUD for repository-scoped bundles |
| `src/services/user-scope-service.ts` | User/workspace scope file placement |
| `src/services/repository-scope-service.ts` | Repository scope file placement |
| `src/adapters/*` | Source implementations (github, awesome-copilot, apm, skills, and local variants) |
| `src/storage/registry-storage.ts` | Persistent paths and JSON layout |
| `src/services/migration-registry.ts` | globalState-based migration tracker |
| `src/migrations/` | Migration scripts (one file per migration) |
| `src/commands/*` | Command handlers wiring UI to services |

---

## Development Workflows

### Commands

```bash
npm install                    # Install dependencies
npm run compile                # Production webpack bundle
npm run watch                  # Dev watch mode
npm run lint                   # ESLint (v9 flat config: eslint.config.mjs)
npm run package:vsix           # Create .vsix package
```

For test commands and debugging strategies, see `test/AGENTS.md`.

### Log Management

- Minimize context pollution: pipe long output through `tee <name>.log | tail -20`
- Analyze existing logs with `grep` before re-running tests
- When a command fails, summarize from tail output, refer to stored log for details
- **For checkpoint tasks**: If full test suite passes, analyze the log - do NOT re-run individual tests

---

## Project Conventions

### Singletons
`RegistryManager.getInstance(context?)` requires ExtensionContext on first call. Pass `context` from `extension.ts`.

### Storage
Persistent data lives under `context.globalStorageUri.fsPath`. Use `RegistryStorage.getPaths()`.

### Bundles
Valid bundles require `deployment-manifest.yml` at root. `BundleInstaller.validateBundle` enforces id/version/name.

### Adapters
Register via `RepositoryAdapterFactory.register('type', AdapterClass)`. Implement `IRepositoryAdapter`.

### Scopes
Installs support `user`, `workspace`, and `repository` scopes. Repository scope uses the lockfile (`prompt-registry.lock.json`) as the single source of truth.

### Linting
ESLint v9 with flat config (`eslint.config.mjs`). The `lib/` directory is excluded from root linting (it has its own ESLint setup). The `@typescript-eslint/semi` rule was removed in v8 — formatting is handled by Prettier (`eslint-config-prettier`).

### lib/ workspace
`lib/` is a separate npm workspace (`@prompt-registry/collection-scripts`). Tests compile to `lib/dist-test/` via `lib/tsconfig.test.json` before running with mocha. Run `cd lib && npm test` to build and test.

### Error Handling
Use `Logger.getInstance()`. Throw errors with clear messages. Commands catch and show via VS Code notifications.

### Migrations
Use `MigrationRegistry` (globalState-backed) for tracking data migrations. Each migration is a named entry with `pending`/`completed`/`skipped` status. Define migration logic in `src/migrations/`. Wire migrations into `extension.ts` activation via `runMigrations()`. Lockfile migrations use dual-read (try new + legacy ID) since lockfiles are Git-shared. Mark all migration-related code with `@migration-cleanup(migration-name)` comments so cleanup sites can be found with `grep -r "@migration-cleanup"`.

### Migration Cleanup
When a migration is no longer needed, search for all related code with:
```bash
grep -r "@migration-cleanup(migration-name)" src/ test/
```
This finds every file with dual-read fallback, legacy functions, and migration logic that can be removed.

---

## Integration Points

- **Network**: Adapters use `axios`. Unit tests use `nock` for HTTP mocking.
- **File I/O**: Bundle extraction uses `adm-zip`. Clean temp directories in tests.
- **VS Code API**: Activation lifecycle, `ExtensionContext` storage URIs, event emitters.

---

## Quick Examples

### Add a new adapter
Copy `src/adapters/github-adapter.ts` (or the closest existing adapter), implement `IRepositoryAdapter` (see `src/adapters/AGENTS.md`), and register via `RepositoryAdapterFactory.register('type', AdapterClass)` in `RegistryManager`.

### Fix bundle validation
Update `BundleInstaller.validateBundle()` — manifest version must match bundle.version unless `'latest'`.

### Inspect installed bundles
Open extension global storage path (see `RegistryStorage.getPaths().installed`) or enable `promptregistry.enableLogging`.

---

## What to Avoid

- Don't assume OS-specific Copilot paths—use `UserScopeService`
- Don't change activation events without updating `package.json` and tests
- Don't duplicate utilities—check `src/utils/` and `test/helpers/` first
- Don't over-engineer—solve the immediate problem only

---

## **MANDATORY** Documentation Updates

**After implementing features or fixing bugs, you MUST update documentation.** See [docs/AGENTS.md](docs/AGENTS.md) for file placement guidance, documentation discovery, and standards.

---

## **MANDATORY** Folder-Specific Guidance

See the [FIRST STEP table at the top of this file](#-first-step-read-folder-specific-guidance-) for the complete list of folder-specific AGENTS.md files you **MUST** read before working in those areas.
