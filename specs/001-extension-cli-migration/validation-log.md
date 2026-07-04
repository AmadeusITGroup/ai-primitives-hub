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

## Notes

- No source-code migration or cherry-pick has been applied yet.
- Direct merge of `feat/cli-backup` remains disallowed by the plan.
- Baseline lint and unit test failures are recorded as pre-migration evidence and are not caused by source changes in this branch.
- Phase 2 foundational contracts, golden helpers, safety policy, transformer pipeline, writer port, and shared use cases are validated and ready for the next planned slice.