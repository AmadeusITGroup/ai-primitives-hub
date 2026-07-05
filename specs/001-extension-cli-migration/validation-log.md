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

## Phase 3 BundleInstaller Shared Request Validation

| Command | Status | Summary |
|---------|--------|---------|
| `npm run test:one -- test/services/bundle-installer.repositoryScope.test.ts` | Failed as expected, then passed | New T033 shared-target validation test first failed because repository install accepted a manifest entry with unsupported resource type `manifest` and continued to repository sync. After constructing a shared install use-case request in `BundleInstaller` and validating it before legacy copy/sync, the suite passed with 20 passing. |
| `npm run test:one -- test/services/registry-manager-repository-safety.test.ts` | Passed | Revalidated T032 after the BundleInstaller shared validation change; 2 passing. |
| `npx eslint src/services/bundle-installer.ts test/services/bundle-installer.repositoryScope.test.ts` | Passed with warnings | No ESLint errors after T033 changes. Remaining output is pre-existing unsafe-`any` warnings around manifest parsing in `BundleInstaller`. |
| `git diff --check` | Passed | No whitespace errors after T033 edits. |
| `npm run compile` | Passed with warning | Production compile completed. Warning remains the known optional Elasticsearch `apache-arrow/Arrow.node` module not found. |

### Phase 3 BundleInstaller Defects Found and Fixed

- `BundleInstaller.installFromBuffer()` now translates validated manifests into the shared application install request shape and runs target validation before legacy scope sync.
- Unsupported shared target resources are rejected before repository files or lockfiles are written, while existing public `installFromBuffer()` and `update()` signatures remain unchanged.

## Phase 3 UserScopeService Target Layout Validation

| Command | Status | Summary |
|---------|--------|---------|
| `npm run test:one -- test/services/user-scope-service.test.ts` | Failed as expected, then passed | New T034 shared-layout routing test first failed because user-scope prompt sync still wrote through the legacy hardcoded `User/prompts` path when the shared layout route was stubbed. After routing prompt, instruction, agent, and chatmode file placement through `resolveTargetLayout()`, the suite passed with 13 passing. |
| `npm run test:one -- test/services/vscode-user-golden.test.ts` | Passed | Revalidated current VS Code user-scope golden output after target-layout routing; 1 passing. |
| `npx eslint src/services/user-scope-service.ts test/services/user-scope-service.test.ts test/services/vscode-user-golden.test.ts` | Passed with warnings | No ESLint errors after T034 changes. Remaining output is pre-existing unsafe-`any` warnings in `UserScopeService`. |
| `git diff --check` | Passed | No whitespace errors after T034 edits. |
| `npm run compile` | Passed with warning | Production compile completed. Warning remains the known optional Elasticsearch `apache-arrow/Arrow.node` module not found. |

### Phase 3 UserScopeService Defects Found and Fixed

- User-scope prompt, instruction, agent, and chatmode file placement now resolves the resource route from the shared target layout contract while preserving existing VS Code profile and WSL base-directory detection.
- Current VS Code user-scope golden output remains unchanged: prompts, instructions, and agents still land under the active VS Code `User/prompts` route, and skills still use the existing user skill sync path.

## Phase 3 RepositoryScopeService Target Layout Validation

| Command | Status | Summary |
|---------|--------|---------|
| `npm run test:one -- test/services/repository-scope-service.test.ts` | Failed as expected, then passed | New T035 shared-layout routing test first failed because repository-scope prompt sync still copied to the legacy `.github/prompts` path when the shared layout route was stubbed. After routing prompt, instruction, agent, chatmode, and skill placement through `resolveTargetLayout()`, the suite passed with 43 passing. |
| `npm run test:one -- test/services/vscode-repository-golden.test.ts` | Passed | Revalidated current VS Code repository-scope files and lockfile layout after target-layout routing; 1 passing. |
| `npx eslint src/services/repository-scope-service.ts test/services/repository-scope-service.test.ts` | Passed | No ESLint errors after T035 changes. |
| `git diff --check` | Passed | No whitespace errors after T035 edits. |
| `npm run compile` | Passed with warning | Production compile completed. Warning remains the known optional Elasticsearch `apache-arrow/Arrow.node` module not found. |

### Phase 3 RepositoryScopeService Defects Found and Fixed

- Repository-scope file and skill placement now resolves target directories from the shared target layout contract while preserving the default VS Code `.github/*` output and lockfile-relative path shape.
- Local-only git-exclude entries now follow the same layout-routed repository paths produced during sync.

## Phase 3 RegistryManager Delegation Validation

| Command | Status | Summary |
|---------|--------|---------|
| `npm run test:one -- test/services/registry-manager.test.ts` | Passed | Added T036 assertions proving repository-scope install, update, and uninstall still notify repository listeners while bypassing `RegistryStorage` installation writes/removals. The suite stayed green with 26 passing after centralizing RegistryManager post-delegation storage and event handling. |
| `npm run test:one -- test/services/registry-manager-repository-safety.test.ts` | Passed | Revalidated repository-safety diagnostics after the T036 RegistryManager delegation refactor; 2 passing. |
| `npx eslint src/services/registry-manager.ts test/services/registry-manager.test.ts` | Passed with warnings | No ESLint errors after T036 changes. Remaining output is the pre-existing unsafe-`any` warnings in `RegistryManager`. |
| `git diff --check` | Passed | No whitespace errors after T036 edits. |
| `npm run compile` | Passed with warning | Production compile completed. Warning remains the known optional Elasticsearch `apache-arrow/Arrow.node` module not found. |

### Phase 3 RegistryManager Defects Found and Fixed

- RegistryManager now centralizes post-delegation install, update, and uninstall side effects so repository-scoped operations continue to bypass `RegistryStorage` while firing the same extension-facing events.
- Command-facing behavior stayed stable: delegated operations still emit install/update/uninstall events and repository refresh notifications at the same scope boundaries as before.

## Phase 3 Install Command Notification Validation

| Command | Status | Summary |
|---------|--------|---------|
| `npm run test:one -- test/commands/bundle-installation-commands.property.test.ts` | Failed as expected, then passed | New T037 regression first failed because repository-safety install rejections were routed through the generic `ErrorHandler`, which collapsed the redacted diagnostic into a categorized message and dropped the `[REDACTED]` detail. After preserving `Repository install rejected:` messages at the install command boundary, the focused suite passed with 5 passing while still asserting the existing success notification path. |
| `git diff --check` | Passed | No whitespace errors after T037 edits. |

### Phase 3 Install Command Defects Found and Fixed

- The install command now preserves redacted repository-safety diagnostics and remediation guidance when delegated repository installs are rejected, instead of replacing them with a generic categorized error.
- Existing success-path notifications remain intact after installation completes and auto-update preference storage succeeds.

## Phase 3 Broader VS Code Parity Validation

| Command | Status | Summary |
|---------|--------|---------|
| `LOG_LEVEL=ERROR npm run test:unit` | Failed with baseline issue | Repo-wide unit/property/e2e coverage ran after T037 and reported `2361 passing`, `33 pending`, and `1 failing`. The failing test is the pre-existing `ElasticSearchTransport registerHub() should pass system + default CA certificates to the ES client when available`, which expects `tls.ca` to be an array. No new command-layer or migration-slice regressions were introduced by T037. |
| `npm run test:integration` | Passed | Real VS Code integration coverage remained green after the delegation and command-layer changes; 7 passing. |
| `npm run compile` | Passed with warning | Production compile completed. Warning remains the known optional Elasticsearch `apache-arrow/Arrow.node` module not found. |
| `npm run lint` | Failed with baseline issues | Repo-wide lint still reports `854 problems (4 errors, 850 warnings)`. Errors are outside this slice: `test/services/mcp-server-manager.test.ts` trailing comma and `test/services/vscode-repository-golden.test.ts` max-len plus missing final newline. The remaining output is the existing warning baseline. |
| `git diff --check` | Passed | No whitespace errors after T037/T038 edits. |

## Phase 4 CLI Parser and Entrypoint Validation

| Command | Status | Summary |
|---------|--------|---------|
| `npm run test:one -- test/cli/cli-parser.test.ts` | Failed as expected, then passed | New T039 parser/help tests first failed because the migration branch had no `src/cli/cli.ts` module or root CLI entrypoint. After adding a minimal parser/help module plus root CLI entrypoint wiring, the focused suite passed with 8 passing. |
| `npx eslint src/cli/cli.ts src/cli/index.ts test/cli/cli-parser.test.ts` | Passed | Focused lint for the new CLI parser files passed after adding required JSDoc, avoiding object-literal default parameters, and restoring trailing newlines. |
| `git diff --check` | Passed | No whitespace errors after the initial CLI parser and entrypoint slice. |
| `npm run test:one -- test/cli/cli-parser.test.ts` | Failed as expected, then passed | New T046 shared-context tests first failed because `createCliContext()` and `getCliCommandDefinition()` did not exist. After introducing shared CLI command metadata plus a reusable execution context, the focused suite passed with 10 passing. |
| `npx eslint src/cli/cli.ts src/cli/index.ts test/cli/cli-parser.test.ts` | Passed | Focused lint remained clean after adding shared command definitions and context. ESLint printed only the existing multi-project performance warning. |
| `git diff --check` | Passed | No whitespace errors after the T046 shared-context slice. |
| `npm run test:one -- test/cli/install-command.test.ts` | Failed as expected, then passed | New T047 command-adapter tests first failed because `src/cli/commands/install.ts` did not exist. After adding minimal install/update command adapters that load a bundle and delegate to the shared application use cases, the focused suite passed with 2 passing. |
| `npx eslint src/cli/commands/install.ts test/cli/install-command.test.ts` | Passed | Focused lint passed after restoring trailing newlines and removing unnecessary async/type assertions. ESLint printed only the existing multi-project performance warning. |
| `git diff --check` | Passed | No whitespace errors after the T047 install/update command slice. |
| `npm run test:one -- test/cli/install-command.test.ts` | Failed as expected, then passed | New T040 fixture-driven local install test first failed because the CLI command layer had no `loadLocalBundle()` path for `deployment-manifest.yml` directories. After adding a local manifest/file loader and executing the fixture through `createApplicationUseCases()`, the focused suite passed with 3 passing. |
| `npx eslint src/cli/commands/install.ts test/cli/install-command.test.ts` | Passed | Focused lint remained clean after adding the local bundle loader and fixture-backed success case. ESLint printed only the existing multi-project performance warning. |
| `git diff --check` | Passed | No whitespace errors after the T040 local install slice. |
| `npm run test:one -- test/cli/error-output.test.ts` | Failed as expected | New T041 error-output tests confirm the current CLI entrypoint still falls back to the generic `Command "install" is not implemented yet.` stderr path. Invalid `--output` handling already returns exit code `1`, while missing-install-target and unsupported-target diagnostics remain unimplemented. |
| `npx eslint test/cli/error-output.test.ts` | Passed | Focused lint passed for the new T041 error-output test file. ESLint printed only the existing multi-project performance warning. |
| `git diff --check` | Passed | No whitespace errors after the T041 error-output test slice. |

### Phase 4 CLI Parser and Entrypoint Defects Found and Fixed

- The migration branch had no CLI parser/help module or root entrypoint, so the first CLI command-contract tests failed on a missing module rather than business behavior.
- A minimal `src/cli/cli.ts` parser/help contract and `src/cli/index.ts` entrypoint now exist, and `package.json` exposes a provisional `prompt-registry` bin target aligned with the TypeScript `out/` tree while broader packaging validation remains deferred to T051.
- The first shared-context tests exposed that the CLI layer only returned parsed flags and hardcoded help text; `src/cli/cli.ts` now owns reusable command definitions and a shared CLI execution context that the entrypoint can consume without duplicating stream and cwd setup.
- The first install/update command tests exposed that no CLI adapter existed between bundle loading and the shared application use cases; `src/cli/commands/install.ts` now shapes a local-source install/update request without duplicating pipeline logic.
- The first fixture-backed local install test exposed that the CLI command layer still lacked a real loader for local bundle directories; `src/cli/commands/install.ts` now reads `deployment-manifest.yml` plus prompt files and reuses the shared application install use case to produce the repository-scoped outputs.
- The first error-output tests expose the next missing command-layer behavior: `main()` still treats all install invocations as unimplemented, so actionable `--target` validation and unsupported-target diagnostics need to land before CLI error handling is complete.

## Notes

- No source-code migration or cherry-pick has been applied yet.
- Direct merge of `feat/cli-backup` remains disallowed by the plan.
- Baseline lint and unit test failures are recorded as pre-migration evidence and are not caused by source changes in this branch.
- Phase 2 foundational contracts, golden helpers, safety policy, transformer pipeline, writer port, and shared use cases are validated and ready for the next planned slice.