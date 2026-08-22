# `packages/` — AI Primitives Hub library-centric packages

Ports-and-adapters packages shared by the two delivery layers: the VS Code
extension (`apps/vscode-extension`) and the `ai-primitives-hub` CLI
(`packages/cli`). Dependencies point inward only, so `core` never knows about
a delivery framework.

For the architecture rationale and the decisions behind this layout, see the
[contributor architecture guide](../docs/contributor-guide/architecture.md),
[clean architecture](../docs/contributor-guide/architecture/library-centric-architecture/clean-architecture.md),
and the [ADR index](../docs/contributor-guide/architecture/adr/adr-index.md).

## Packages

| Package | Purpose | Depends on |
|---|---|---|
| `core` | Domain types and port interfaces. No dependency on other `@ai-primitives-hub` packages. | — |
| `infra` | Adapters implementing `core`'s ports: source adapters (GitHub/local/APM/Skills/Awesome Copilot), harvest, search, per-target writers, stores, scaffolding. | `core` |
| `app` | Use-case orchestration: install/uninstall pipelines, registry (hub/profile), discovery + search, multi-target content transforms. Also the public SDK surface until a standalone `sdk` package has a real consumer. | `core`, `infra` |
| `cli` | Thin Clipanion delivery adapter — argument parsing + calling into `app` + formatting output, never business logic. | `core`, `infra`, `app` |

## Module layout

- `infra/src/{adapters,harvest,search,writers,stores,scaffolding,fs,http}/`
- `app/src/{install,registry,discovery,search,transform,transform/transformers}/`
- `cli/src/{commands,framework,doctor}/`

## Commands

These packages are members of the single pnpm workspace defined at the
repository root, so install from the root — there is no separate install step
for this directory, and the root `pnpm-lock.yaml` pins every package here.

```bash
pnpm install                                    # from the repository root

pnpm --filter "@ai-primitives-hub/*" build      # topological: core -> infra -> app -> cli
pnpm --filter "@ai-primitives-hub/*" lint:fix
pnpm --filter "@ai-primitives-hub/*" test

pnpm -C packages/infra test                     # a single package
```

Prefer the `--filter` form over `pnpm -C packages -r <script>`: `-r` resolves
against the workspace root, so from here it selects **all** projects in the
monorepo — the extension and the Docusaurus site included — not just this
directory.
