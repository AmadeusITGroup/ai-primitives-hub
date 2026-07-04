# Validation Log: Extension and CLI Migration

## Branch Evidence

| Field | Value |
|-------|-------|
| Recorded | 2026-07-04 |
| Migration branch | `feat/extension-cli-migration` |
| Migration branch HEAD | `faba4a5b573aaef5283dfd737ca327db61c5cd4b` |
| `main` HEAD | `faba4a5 fix: test badly isolated test that were changing real mcp.json (#318)` |
| `feat/cli-backup` HEAD | `76ca45e feat: extending doctor mode to cover possible issues linked with the extra TLS certificates authorities` |
| Merge base with `feat/cli-backup` | `b3219f3af93b1f093125852d721ba81a7356391a` |

## Baseline Validation

| Command | Status | Summary |
|---------|--------|---------|
| `npm install` | Passed with warning | Installed 1284 packages and audited 1287 packages; 0 vulnerabilities. Warning: local Node `v22.14.0` does not satisfy `@o3r/schematics` engine `^22.17.0 || ^24.0.0`. |
| `npm run compile` | Passed with warning | `lib` TypeScript build and webpack compile completed. Warning: optional `apache-arrow/Arrow.node` module not found from Elasticsearch helper import. |
| `npm run lint` | Failed baseline | 874 problems: 1 error and 873 warnings. Error is existing `@stylistic/comma-dangle` in `test/services/mcp-server-manager.test.ts`. |
| `npm run test:unit` | Failed baseline | Direct run failed because `test-dist/test/**/*.test.js` was missing. Follow-up `npm run compile-tests && npm run test:unit` produced 2322 passing, 33 pending, 1 failing. Failing test: `ElasticSearchTransport registerHub() should pass system + default CA certificates to the ES client when available`, expected `tls.ca` to be an array. |

## Spec Kit Validation

| Command | Status | Summary |
|---------|--------|---------|
| `git diff --check` | Passed | No whitespace errors after task regeneration. |
| `speckit.analyze` | Passed with low note | No critical, high, or medium findings. Low note: optional phase-name mapping between plan and tasks. |

## Phase 2 Foundational Validation

| Command | Status | Summary |
|---------|--------|---------|
| `npx eslint src/types/target.ts src/services/application-use-cases.ts src/services/repository-install-policy.ts src/services/resource-transformer.ts src/services/target-capability-registry.ts src/services/target-layout-registry.ts src/services/target-writer.ts src/services/migration-guards.ts test/helpers/target-golden.ts test/helpers/target-golden.test.ts test/services/application-use-cases.test.ts test/services/repository-install-policy.test.ts test/services/resource-transformer.test.ts test/services/target-model.test.ts test/services/vscode-install-parity.test.ts` | Passed | Phase 2 touched files lint clean. ESLint printed only the existing multi-project performance warning. |
| `npm run compile-tests` | Passed | TypeScript test compile completed and fixtures copied to `test-dist`. |
| `npm run test:one -- test/services/target-model.test.ts` | Passed | 8 passing. |
| `npm run test:one -- test/helpers/target-golden.test.ts` | Passed | 2 passing. |
| `npm run test:one -- test/services/resource-transformer.test.ts` | Passed | 3 passing. |
| `npm run test:one -- test/services/repository-install-policy.test.ts` | Passed | 3 passing. |
| `npm run test:one -- test/services/application-use-cases.test.ts` | Passed | 4 passing. |
| `npm run test:one -- test/services/vscode-install-parity.test.ts` | Passed | 5 passing. |
| `npm run compile` | Passed with warning | `lib` TypeScript build and webpack compile completed. Warning remains the known optional `apache-arrow/Arrow.node` module not found from Elasticsearch helper import. |
| `npm run lint` | Failed baseline | 874 problems: 1 error and 873 warnings. The only error remains existing `@stylistic/comma-dangle` in `test/services/mcp-server-manager.test.ts`; grep of `/tmp/ai-primitives-hub-phase2-lint-after.log` found no Phase 2 touched-file entries. |

## Phase 3 VS Code Golden Validation

| Command | Status | Summary |
|---------|--------|---------|
| `npm run test:one -- test/helpers/target-golden.test.ts` | Passed | 2 passing. Revalidated deterministic golden helper behavior after adding symlink file reads for user-scope output. |
| `npm run test:one -- test/services/vscode-user-golden.test.ts` | Passed | 1 passing. Confirms `UserScopeService.syncBundle()` preserves current user-scope prompt, instruction, agent, and skill output. |
| `npm run test:one -- test/services/vscode-repository-golden.test.ts` | Passed | 1 passing. Confirms `RepositoryScopeService.syncBundle()` plus lockfile creation preserves current repository-scope files and lockfile shape. |
| `npm run test:one -- test/services/user-scope-service.test.ts` | Passed | 11 passing. Regression coverage for the touched user-scope service still passes. |
| `npm run test:one -- test/services/repository-scope-service.test.ts` | Passed | Repository-scope service regression suite passed after normalizing singular `instruction` manifest type to `instructions`. |
| `npm run compile-tests` | Passed | TypeScript test compile completed and fixtures copied to `test-dist`. |
| `npx eslint src/services/user-scope-service.ts src/services/repository-scope-service.ts test/helpers/target-golden.ts test/services/vscode-user-golden.test.ts test/services/vscode-repository-golden.test.ts` | Passed with warnings | No ESLint errors after T027/T028 fixes. Remaining output is pre-existing unsafe-`any` warnings in the large scope services. |

### Phase 3 Defects Found and Fixed

- User-scope golden output initially missed symlinked files; `test/helpers/target-golden.ts` now reads regular files and symlinks.
- `UserScopeService` generated an invalid filename for singular manifest type `instruction`; it now maps `instruction` to Copilot file type `instructions`.
- `RepositoryScopeService` failed repository placement for singular manifest type `instruction`; it now maps `instruction` to Copilot file type `instructions` before resolving target paths.

## Phase 3 User Path Validation

| Command | Status | Summary |
|---------|--------|---------|
| `npm run test:one -- test/services/user-scope-service.test.ts` | Failed as expected, then passed | New T029 regression first failed because WSL Windsurf sync wrote under the default `Code` path instead of the Windsurf Windows data folder. After adding the Windsurf URI-scheme mapping, the suite passed with 12 passing. |
| `npm run test:one -- test/services/user-scope-service.wsl.test.ts` | Passed | Existing WSL path behavior still passes with 11 passing, including stable, insiders, unknown-scheme fallback, copy mode, and missing `cmd.exe` fallback cases. |
| `npx eslint src/services/user-scope-service.ts test/services/user-scope-service.test.ts` | Passed with warnings | No ESLint errors after the T029 test and resolver change. Remaining output is pre-existing unsafe-`any` warnings in `UserScopeService`. |

### Phase 3 User Path Defects Found and Fixed

- `UserScopeService` did not resolve WSL Windsurf installs to the Windows Windsurf user data folder; the WSL URI-scheme map now resolves `windsurf` to `Windsurf`.

## Phase 3 Repository Lockfile Compatibility Validation

| Command | Status | Summary |
|---------|--------|---------|
| `npm run test:one -- test/services/repository-scope-service.test.ts` | Failed as expected, then passed | New T030 update regression first failed because `syncBundle()` left obsolete lockfile-tracked files behind. New uninstall regression first failed because legacy Windows-separator lockfile paths did not resolve to installed `.github` files on this platform. After cleanup and path-normalization fixes, the suite passed with 42 passing. |
| `npx eslint src/services/repository-scope-service.ts test/services/repository-scope-service.test.ts` | Passed | T030 touched files lint clean. ESLint printed only the existing multi-project performance warning. |
| `git diff --check && npm run compile-tests && npm run compile` | Passed with warning | Whitespace check and TypeScript test compile passed. Production compile passed with the known optional Elasticsearch `apache-arrow/Arrow.node` warning. |

### Phase 3 Repository Lockfile Defects Found and Fixed

- Repository update sync now removes obsolete files from the previous lockfile entry when the file is unmodified and not shared by another bundle.
- Repository uninstall now normalizes legacy lockfile paths with Windows separators before resolving, comparing, removing files, and cleaning git-exclude entries.

## Phase 3 RegistryManager Parity Validation

| Command | Status | Summary |
|---------|--------|---------|
| `npm run test:one -- test/services/registry-manager.test.ts` | Failed as expected, then passed | New T031 repository workflow parity tests first failed because repository-scope install, update, and uninstall emitted normal bundle events but did not fire `onRepositoryBundlesChanged`. After emitting the repository refresh event for repository-scope mutations, the suite passed with 26 passing. |

### Phase 3 RegistryManager Parity Defects Found and Fixed

- Repository-scope install, update, and uninstall now notify `onRepositoryBundlesChanged`, keeping marketplace/tree UI listeners refreshed after direct RegistryManager operations and command-level move-scope workflows that compose uninstall/install.
- `RegistryManager` has no dedicated move-scope API; move-scope behavior is currently implemented by `BundleScopeCommands` through `uninstallBundle()` and `installBundle()`, so this parity check covers the service calls that command path depends on.

## Phase 3 Repository Safety Diagnostics Validation

| Command | Status | Summary |
|---------|--------|---------|
| `npm run test:one -- test/services/registry-manager-repository-safety.test.ts` | Failed as expected, then passed | New T032 RegistryManager repository-safety test first failed because committed repository installs accepted secret-like prompt, instruction, agent, and skill content. After wiring repository-scope `BundleInstaller.installFromBuffer()` through the repository install policy before workspace writes, the suite passed with 2 passing. |
| `npm run test:one -- test/services/registry-manager.test.ts` | Passed | Revalidated T031 RegistryManager workflow parity after T032 installer changes; 26 passing. |
| `npx eslint src/services/registry-manager.ts src/services/bundle-installer.ts test/services/registry-manager.test.ts test/services/registry-manager-repository-safety.test.ts` | Passed with warnings | No ESLint errors after T031/T032 changes. Remaining output is pre-existing unsafe-`any` warnings in the large service files. |
| `git diff --check` | Passed | No whitespace errors after T031/T032 edits. |
| `npm run compile` | Passed with warning | Production compile completed. Warning remains the known optional Elasticsearch `apache-arrow/Arrow.node` module not found. |

### Phase 3 Repository Safety Defects Found and Fixed

- Committed repository installs now reject manifest resources whose extracted content contains secret-like material, and diagnostics redact matched content with `[REDACTED]`.
- `local-only` repository mode remains allowed for the same resource content, preserving the non-committed escape hatch.

## Notes

- No source-code migration or cherry-pick has been applied yet.
- Direct merge of `feat/cli-backup` remains disallowed by the plan.
- Baseline lint and unit test failures are recorded as pre-migration evidence and are not caused by source changes in this branch.
- Phase 2 foundational contracts, golden helpers, safety policy, transformer pipeline, writer port, and shared use cases are validated and ready for the next planned slice.