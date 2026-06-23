# sdk — Integration API

High-level API surface for external integrations. Depends on `core` + `infra`.

## Build & Test

```bash
pnpm --filter=@prompt-registry/sdk run build
pnpm --filter=@prompt-registry/sdk run test
pnpm --filter=@prompt-registry/sdk run lint
```

Uses **Vitest**.

## Public Surface Checks

`src/index.ts` is the SDK barrel. It currently re-exports `@prompt-registry/core`
and `@prompt-registry/infra` only.

If a new API needs orchestration logic, move that logic into `app` first and keep
this package as the stable export surface.

## Purpose

Provides a stable, ergonomic API over `app` use-cases for consumers who don't want to wire the full pipeline themselves. Keep it thin — delegate to `app` orchestration rather than duplicating logic here.

## Conventions

- Export only what external consumers need; don't leak internal types
- Keep the public API surface stable — breaking changes require a semver major bump
- If you find yourself reimplementing `app` logic here, move it to `app` instead
