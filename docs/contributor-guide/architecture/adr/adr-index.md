# Architecture Decision Records

Lightweight decision log for the `feat/ai-primitives-hub-next` library-centric
migration (see `.tmp/ai-primitives-hub-next-migration-plan.md` at the repo
root for the full plan). Each ADR is short, immutable once accepted, and
focused on one decision.

| ADR | Title | Status |
|---|---|---|
| [0001](./0001-ports-and-adapters-for-cli-and-extension.md) | Ports & Adapters Across the CLI and the VS Code Extension | Accepted |
| [0002](./0002-clipanion-cli-framework-with-pinned-rc.md) | Clipanion as the CLI Framework, RC Pin Accepted | Accepted |
| [0003](./0003-primitive-index-search-and-multi-target-in-scope.md) | Primitive Index/Search/Harvest and Full Multi-Target Support In Scope | Accepted |
| [0004](./0004-cli-only-rebrand-keep-lockfile-and-extension-identity-stable.md) | CLI-Only Rebrand — Keep Lockfile and Extension Identity Stable | Accepted |
| [0005](./0005-universal-xdg-based-app-storage.md) | Universal, XDG-Based Application Storage Port | Accepted |

## When to add a new ADR

Add one when a decision would otherwise only live in a chat transcript or a
PR description: framework/library choices, naming/branding calls, or any
decision that reverses or narrows a previous one. Number sequentially, never
edit an accepted ADR's decision — supersede it with a new one instead.
