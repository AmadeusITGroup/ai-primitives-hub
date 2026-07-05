# Cherry-Pick Cluster Ledger

## Ordering Gates

- Phase 2 foundational contracts and tests must complete before any source port.
- Core contracts must land before infra writers/adapters.
- Infra writers/adapters must land before application use cases.
- Application use cases must land before CLI adapter work.
- Writer, target, transformer, and repository-safety contracts must land before target architecture and Kiro-specific work.
- `ec15a5d` and other monorepo/package-manager commits remain deferred unless a dedicated package-manager slice is accepted with rollback and validation.
- A cluster may be cherry-picked only after this ledger records purpose, prerequisites, expected conflicts, decision, rollback point, and validation command.

## Cluster Decisions

| Cluster | Commits | Purpose | Prerequisites | Expected Conflicts | Decision | Rollback Point | Validation |
|---------|---------|---------|---------------|--------------------|----------|----------------|------------|
| Workspace foundation | `d121584`, `b7e3a56` | pnpm workspace bootstrap and engine/script setup | Package-manager slice accepted | Root package metadata, lockfiles, CI, developer setup | Deferred | Branch HEAD before package-manager slice | `npm install` or accepted package-manager install, compile, lint, CI dry run |
| Core contracts | `25e713f`, `d8a1f1d`, `3900886`, `fef8fd4` | Domain types, ports, package exports | Phase 2 target/use-case contract tests | Source paths differ between `main` and branch package layout | **Defer** — domain types already exist in `src/types/`, monorepo extraction not needed | Branch HEAD before core port | Core contract tests, `npm run compile`, `npm run lint` |
| Infra adapters and writers | `8030749`, `3039306`, `cd2ce23`, `1ff77b8`, `59434aa`, `a0709e8` | Filesystem, writer, layout, archive, and adapter infrastructure | Accepted core contracts | `src/services` vs package layout, existing scope services | **Defer** — infra already in `src/services/`, monorepo extraction not needed | Branch HEAD before infra port | Writer golden tests, filesystem tests, compile, lint |
| App use cases | `cc83571`, `17e4d26`, `eb7cb8b`, `14bf71f` | Shared install/update/uninstall/validate orchestration | Accepted infra contracts and current extension parity tests | Existing `RegistryManager`, `BundleInstaller`, scope services | **Defer** — app use cases already in `src/services/application-use-cases.ts` | Branch HEAD before app port | Extension parity tests, app use-case tests, compile, lint |
| CLI and SDK baseline | `aa2e318`, `5d726d2`, `c1f9383`, `6df3376` | CLI package and possible SDK surface | Shared app use cases accepted | Package layout, bin wiring, exports | **Defer** — CLI already in `src/cli/`, SDK package not needed for current migration | Branch HEAD before CLI baseline port | CLI command tests, package build checks, compile, lint |
| Canonical monorepo | `3b5c1c9`, `0a228be`, `ec15a5d`, `5e9a2f8`, `8359b59` | Monorepo package structure, TypeScript solution, pnpm CI, docs | Dedicated package-manager and layout slice accepted | Very high: file moves, root metadata, workflows, docs | Deferred | Branch HEAD before monorepo slice | Full compile, lint, unit, integration, package, CI dry run |
| CLI maturation | `c67b5ea`, `b4ab90c`, `77f64a3`, `7309165`, `e6759d8`, `86a4904`, `2948149`, `dc96a01`, `44c5678`, `3c61682`, `665c69a`, `7dcf722`, `2b31fe0`, `e1c841a`, `4ca3e36`, `446dda3` | CLI framework migration, UX, scaffolding, plugin/hook support, E2E flows | CLI baseline accepted | CLI package layout and test harness | **Partial Port** — `44c5678` (table+help renderer), `665c69a` (plugin/hook kinds), `7dcf722` (scaffold types+command), `2b31fe0` (primitive scaffold) ported; remaining deferred | Branch HEAD before each CLI subcluster | CLI unit/E2E tests, fixture output checks, compile, lint |
| Architecture, transformers, Kiro | `93bb4dc`, `e356efd`, `08d6638`, `10ccdc2`, `9d6a20e`, `11bf009`, `97ab644`, `bf6a499`, `eeba72d`, `3a6a755` | Boundary cleanup, transformer registry, target layout/Kiro support | Writer/target contracts, repository safety policy, accepted infra | Existing repository writer and install paths | **Partial Port** — `10ccdc2` (shell completion), `bf6a499` (transformer integration in install) ported; `08d6638` and `3a6a755` already satisfied by Phase 5; remaining deferred | Branch HEAD before target architecture port | VS Code/Kiro golden tests, repository-safety tests, compile, lint |
| Diagnostics and environment hardening | `2ac2773`, `12a44d1`, `8a2f199`, `a4ad600`, `5299597`, `d96ec32`, `76ca45e` | CLI diagnostics, proxy/TLS support, schema embedding, lint/test cleanup | CLI baseline accepted | CLI config and diagnostics layout | **Partial Port** — `2ac2773` (agent mapping, already satisfied), `8a2f199` (proxy-aware fetch) ported; `a4ad600` (extended diagnostics), `76ca45e` (TLS cert diagnostics) deferred (doctor mode outside scope); remaining deferred | Branch HEAD before diagnostics port | Diagnostics tests, CLI error-output tests, compile, lint |

## Applied Ports

The following commits were manually ported (not cherry-picked) from `feat/cli-backup` into the single-package structure. Original author: **Waldek Herka**.

| Commit | Feature | Ported To | Notes |
|--------|---------|-----------|-------|
| `2ac2773` | Agent mapping in default layouts | `src/config/targets/vscode.ts` | Already satisfied by Phase 5 implementation |
| `44c5678` | Table renderer + help renderer | `src/cli/table.ts`, `src/cli/help-renderer.ts` | Adapted from clipanion to function-based CLI |
| `10ccdc2` | Shell completion command | `src/cli/completion.ts` | bash/zsh completion script generation |
| `8a2f199` | Proxy-aware fetch utility | `src/utils/proxy-aware-fetch.ts` | Respects HTTP_PROXY/HTTPS_PROXY/NO_PROXY env vars |
| `bf6a499` | Transformer integration in install | `src/services/application-use-cases.ts` | Kiro transformer applied during materializeFiles |
| `665c69a` | Plugin/hook resource kinds | `src/types/target.ts`, `src/types/registry.ts`, `src/config/targets/vscode.ts`, `src/cli/commands/install.ts` | Added plugin/hook to RESOURCE_KINDS, DeploymentManifest, layouts |
| `7dcf722` | Collection scaffolding | `src/types/scaffold.ts`, `src/cli/commands/scaffold.ts` | Scaffold types and collection create command |
| `2b31fe0` | Primitive scaffolding | `src/cli/commands/scaffold.ts` | Scaffold command supports primitive types |

## Inspection Notes (T064–T072)

All 58 commits across 9 clusters were inspected via `git show --stat`. Every commit operates on a monorepo package structure (`packages/core`, `packages/infra`, `packages/app`, `packages/cli`, `packages/sdk`) using pnpm workspaces. The current project maintains a single-package npm structure.

Key findings:
- **Clusters 1–6** (28 commits): Pure monorepo restructuring — package extraction, pnpm workspace setup, TypeScript solution config, CI pipeline changes. All deferred.
- **Cluster 7** (16 commits): CLI maturation in `packages/cli/`. Four commits ported: `44c5678` (table+help renderer), `665c69a` (plugin/hook), `7dcf722` (scaffold), `2b31fe0` (primitive scaffold). Remaining deferred.
- **Cluster 8** (10 commits): Architecture fixes and transformer/Kiro support. Two commits already satisfied by Phase 5. Two ported: `10ccdc2` (completion), `bf6a499` (transformer integration). Remaining deferred.
- **Cluster 9** (7 commits): Diagnostics, proxy/TLS, doctor mode. `2ac2773` already satisfied. `8a2f199` (proxy-aware fetch) ported. `a4ad600` and `76ca45e` (doctor diagnostics) deferred. Remaining deferred.

Per T085: workspace foundation, monorepo, package-manager, SDK, and CLI maturation clusters remain deferred unless a dedicated slice with rollback and validation is defined.