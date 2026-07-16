# `packages/` — AI Primitives Hub library-centric packages

Ports-and-adapters packages shared by the VS Code extension and the (future)
`ai-primitives-hub` CLI. See `.tmp/ai-primitives-hub-next-migration-plan.md`
at the repo root for the full migration plan, architecture rationale, and
phase-by-phase sequencing this directory is built against.

## Why a nested pnpm workspace?

This directory is its own pnpm workspace (`packages/pnpm-workspace.yaml`),
separate from the repository root, which remains npm-managed
(`package.json` + `package-lock.json`, npm workspaces for `lib/` and
`github-actions/*`). Running `pnpm install` from `packages/` only ever
touches `packages/node_modules` and each package's own `node_modules` — it
never touches the root's existing, npm-managed `node_modules`. This lets the
new packages adopt pnpm immediately without any risk to the VS Code
extension's existing, working build.

`apps/vscode-extension` and `lib` join this workspace later, once the
extension itself is relocated (see migration plan, Phase 6) and the whole
repository can move to pnpm in one deliberate, reviewed step.

## Packages

| Package | Purpose | Depends on |
|---|---|---|
| `core` | Domain types and port interfaces. No dependency on other `@ai-primitives-hub` packages. | — |
| `infra` | Adapters implementing `core`'s ports: source adapters (GitHub/local/APM/Skills/Awesome Copilot), harvest, search, per-target writers, stores, scaffolding. | `core` |
| `app` | Use-case orchestration: install/uninstall pipelines, registry (hub/profile), discovery + search, multi-target content transforms. Also the public SDK surface until a standalone `sdk` package has a real consumer. | `core`, `infra` |
| `cli` | Thin Clipanion delivery adapter — argument parsing + calling into `app` + formatting output, never business logic. | `core`, `infra`, `app` |

## Planned module boundaries (reserved, not yet populated)

- `infra/src/{adapters,harvest,search,writers,stores,scaffolding,fs,http}/`
- `app/src/{install,registry,discovery,search,transform,transform/transformers}/`
- `cli/src/{commands,framework,doctor}/`

## Commands

```bash
cd packages
pnpm install
pnpm -r build
pnpm -r lint
pnpm -r test
```
