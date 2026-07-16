# @ai-primitives-hub/infra

Adapters implementing `@ai-primitives-hub/core`'s port interfaces. Depends
on `core` only — never on `app` or `cli` (dependency rule).

Status: **scaffolding only** (Phase 1 of `.tmp/ai-primitives-hub-next-migration-plan.md`).
Real adapters land in Phase 3 (§7.4): source adapters (GitHub, local, APM,
Skills incl. git-trees-API perf, Awesome Copilot), the harvest subsystem
(bundle providers, hub harvester, tree enumeration), the search subsystem
(BM25 engine, tokenizer), and per-target writers.

## Development

```bash
pnpm --filter @ai-primitives-hub/infra build
pnpm --filter @ai-primitives-hub/infra test
pnpm --filter @ai-primitives-hub/infra lint
```
