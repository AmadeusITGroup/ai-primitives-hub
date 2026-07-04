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

## Notes

- No source-code migration or cherry-pick has been applied yet.
- Direct merge of `feat/cli-backup` remains disallowed by the plan.
- Baseline lint and unit test failures are recorded as pre-migration evidence and are not caused by source changes in this branch.