# @ai-primitives-hub/app

Use-case orchestration for AI Primitives Hub. Depends on `core` and
`infra`. Consumed by both `cli` and (via the strangler-fig migration,
Phase 4) the VS Code extension — this is the single shared implementation
that replaces today's duplicated logic between the two delivery mechanisms.

Status: **scaffolding only** (Phase 1 of `.tmp/ai-primitives-hub-next-migration-plan.md`).
Real orchestration lands in Phase 4 (§7.5): install/uninstall pipelines
extracted from the extension's `BundleInstaller`/`UserScopeService`/
`RepositoryScopeService`/`LockfileManager`/`HubManager`/`RegistryManager`,
discovery/search orchestration over `infra`'s harvest+BM25 engine, and
per-target content transforms (Kiro real; Windsurf/Claude-Code to be
written for real, not left as no-ops).

Also doubles as the public SDK surface (decision 2 in the migration plan)
until a standalone `@ai-primitives-hub/sdk` package has a real external
consumer to justify splitting it out.

## Development

```bash
pnpm --filter @ai-primitives-hub/app build
pnpm --filter @ai-primitives-hub/app test
pnpm --filter @ai-primitives-hub/app lint
```
