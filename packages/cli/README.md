# @ai-primitives-hub/cli

Thin Clipanion delivery adapter over `@ai-primitives-hub/app`. Depends on
`core`, `infra`, and `app`. Commands parse arguments, call into `app`, and
format output — no business logic lives here (see migration plan §3.3.3 for
why this rule exists and what happens when it's violated).

Status: **scaffolding only** (Phase 1 of `.tmp/ai-primitives-hub-next-migration-plan.md`).
Real commands land in Phase 5 (§7.6): framework wiring (Clipanion, RC pin
accepted per decision 8), foundational commands (`status`, `config`,
`target`, `source`), hub/profile commands, index/search/discovery commands,
install/uninstall, collection/scaffolding commands, and doctor/diagnostics
(including HTTP-proxy/TLS-CA support carried over from prior work).

## Development

```bash
pnpm --filter @ai-primitives-hub/cli build
pnpm --filter @ai-primitives-hub/cli test
pnpm --filter @ai-primitives-hub/cli lint
```
