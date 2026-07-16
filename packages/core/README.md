# @ai-primitives-hub/core

Domain types and port interfaces for AI Primitives Hub. Depends on nothing
else in this workspace — every other package depends on `core`, `core`
depends on no `@ai-primitives-hub/*` package.

Status: **scaffolding only** (Phase 1 of `.tmp/ai-primitives-hub-next-migration-plan.md`).
Real domain types land in Phase 2 (§7.3): `bundle`, `collection`, `source`,
`install`/`target`, `hub`/`profile`/`registry`, `primitive`/index, and the
port interfaces adapters in `@ai-primitives-hub/infra` implement.

## Development

```bash
pnpm --filter @ai-primitives-hub/core build
pnpm --filter @ai-primitives-hub/core test
pnpm --filter @ai-primitives-hub/core lint
```
