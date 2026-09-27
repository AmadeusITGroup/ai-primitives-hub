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

```bash
pnpm -C packages -r build
pnpm -C packages -r test
pnpm -C packages -r lint:fix
```

Tests use Vitest. For a bug fix or feature: add a focused failing test in the owning package, make the minimal change, rerun, then run that package's suite.

## Cross-platform filesystem tests

- Classify each path before writing assertions or filesystem doubles: use `node:path` `join`/`resolve` for host-native paths (including expected writes, mock `realpath` inputs/outputs, and workspace roots); use forward slashes only for portable archive/lockfile paths. Do not compare a native path to a hard-coded `/ws/...` string.
- An external-parent mock must match a path assembled with the same host path API and return an external path assembled with that API. Check that the mock actually intercepts the intended parent before trusting a containment test; keep assertions on the writer's public result and the filesystem's observable state.
- On a non-Windows machine, exercise pure path contracts with both `path.posix` and `path.win32` where useful. This does not emulate Windows filesystem behavior, drive roots, or symlink permissions. Keep real-filesystem tests where supported; do not skip a failing Windows assertion to make the matrix green.
- For path changes, run focused local coverage, then confirm the **current PR head** passes the `windows-latest` job in `.github/workflows/vscode-extension-secure-ci.yml` before calling the change merge-ready. If Windows is unavailable locally, inspect the job using `gh run view <run-id> --repo AmadeusITGroup/ai-primitives-hub --job <job-id> --log`; report Windows as unverified until CI passes. Compare expected and received paths and trace the production path *and* the test double before editing fixtures or behavior.

## References

- [ADR index](../docs/contributor-guide/architecture/adr/adr-index.md) — the decisions these boundaries encode
- [Clean architecture](../docs/contributor-guide/architecture/library-centric-architecture/clean-architecture.md) and [codemap](../docs/contributor-guide/architecture/library-centric-architecture/codemap.md)
