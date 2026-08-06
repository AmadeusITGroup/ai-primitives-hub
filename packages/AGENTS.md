# Packages — Shared Domain (Ports & Adapters)

The four `@ai-primitives-hub/*` packages are the shared implementation behind both delivery layers (CLI and VS Code extension). Dependencies point inward only:

```text
CLI / Extension → app → infra → core
```

| Package | Role | May depend on | Never |
|---|---|---|---|
| `core` | Domain types, business rules, port interfaces | (nothing) | `infra`, `app`, `vscode`, direct `fs`/`http` |
| `infra` | Adapters implementing core's ports | `core` | `app`, `cli`, `vscode` |
| `app` | Use-case orchestration + public SDK surface | `core`, `infra` | `cli`, `vscode`; no business rules |
| `cli` | Thin Clipanion delivery adapter | `core`, `infra`, `app` | `vscode` |

## Rules

- Put domain logic and new port interfaces in `core`; keep it dependency-free (matches existing `ports/*.ts` style — no `vscode`, no `fs`).
- Implement external systems in `infra` behind a core port. Add a source adapter by copying one in `infra/src/adapters/`, implementing `SourceAdapter`, and wiring it into `app`'s `createSourceAdapter` switch.
- `app` orchestrates only — it composes ports and adapters, holds no business rules, and takes storage via the injected `AppStorage` port (never `vscode.ExtensionContext`).
- `cli` commands stay thin: parse/format I/O, delegate everything else to `app`. Clipanion is pinned exactly (`4.0.0-rc.4`, no `^`).

## Commands

From the repository root:

```bash
pnpm run verify:packages   # build + test + lint:fix for these four packages
pnpm run build:packages
pnpm run test:packages
pnpm run lint:packages
```

These filter on `@ai-primitives-hub/*`. Do not open-code `pnpm -C packages -r <script>`: it resolves the whole workspace and also runs the extension, `lib/`, `website/`, and `github-actions/`. For a single package, `pnpm -C packages/<name> test` is fine.

Tests use Vitest, which exits non-zero on failure — check that exit status rather than grepping the summary, and pass `--no-color` when you do need to match `Tests N passed`. For a bug fix or feature: add a focused failing test in the owning package, make the minimal change, rerun, then run that package's suite.

A cross-package type change is only visible to the other packages after a build, because they resolve `@ai-primitives-hub/*` through `dist/`. Build before trusting a lint or typecheck result.

## References

- [ADR index](../docs/contributor-guide/architecture/adr/adr-index.md) — the decisions these boundaries encode
- [Clean architecture](../docs/contributor-guide/architecture/library-centric-architecture/clean-architecture.md) and [codemap](../docs/contributor-guide/architecture/library-centric-architecture/codemap.md)
