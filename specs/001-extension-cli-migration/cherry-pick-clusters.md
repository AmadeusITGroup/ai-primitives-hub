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
| Core contracts | `25e713f`, `d8a1f1d`, `3900886`, `fef8fd4` | Domain types, ports, package exports | Phase 2 target/use-case contract tests | Source paths differ between `main` and branch package layout | Pending inspection | Branch HEAD before core port | Core contract tests, `npm run compile`, `npm run lint` |
| Infra adapters and writers | `8030749`, `3039306`, `cd2ce23`, `1ff77b8`, `59434aa`, `a0709e8` | Filesystem, writer, layout, archive, and adapter infrastructure | Accepted core contracts | `src/services` vs package layout, existing scope services | Pending inspection | Branch HEAD before infra port | Writer golden tests, filesystem tests, compile, lint |
| App use cases | `cc83571`, `17e4d26`, `eb7cb8b`, `14bf71f` | Shared install/update/uninstall/validate orchestration | Accepted infra contracts and current extension parity tests | Existing `RegistryManager`, `BundleInstaller`, scope services | Pending inspection | Branch HEAD before app port | Extension parity tests, app use-case tests, compile, lint |
| CLI and SDK baseline | `aa2e318`, `5d726d2`, `c1f9383`, `6df3376` | CLI package and possible SDK surface | Shared app use cases accepted | Package layout, bin wiring, exports | Pending inspection | Branch HEAD before CLI baseline port | CLI command tests, package build checks, compile, lint |
| Canonical monorepo | `3b5c1c9`, `0a228be`, `ec15a5d`, `5e9a2f8`, `8359b59` | Monorepo package structure, TypeScript solution, pnpm CI, docs | Dedicated package-manager and layout slice accepted | Very high: file moves, root metadata, workflows, docs | Deferred | Branch HEAD before monorepo slice | Full compile, lint, unit, integration, package, CI dry run |
| CLI maturation | `c67b5ea`, `b4ab90c`, `77f64a3`, `7309165`, `e6759d8`, `86a4904`, `2948149`, `dc96a01`, `44c5678`, `3c61682`, `665c69a`, `7dcf722`, `2b31fe0`, `e1c841a`, `4ca3e36`, `446dda3` | CLI framework migration, UX, scaffolding, plugin/hook support, E2E flows | CLI baseline accepted | CLI package layout and test harness | Pending inspection | Branch HEAD before each CLI subcluster | CLI unit/E2E tests, fixture output checks, compile, lint |
| Architecture, transformers, Kiro | `93bb4dc`, `e356efd`, `08d6638`, `10ccdc2`, `9d6a20e`, `11bf009`, `97ab644`, `bf6a499`, `eeba72d`, `3a6a755` | Boundary cleanup, transformer registry, target layout/Kiro support | Writer/target contracts, repository safety policy, accepted infra | Existing repository writer and install paths | Pending inspection | Branch HEAD before target architecture port | VS Code/Kiro golden tests, repository-safety tests, compile, lint |
| Diagnostics and environment hardening | `2ac2773`, `12a44d1`, `8a2f199`, `a4ad600`, `5299597`, `d96ec32`, `76ca45e` | CLI diagnostics, proxy/TLS support, schema embedding, lint/test cleanup | CLI baseline accepted | CLI config and diagnostics layout | Pending inspection | Branch HEAD before diagnostics port | Diagnostics tests, CLI error-output tests, compile, lint |

## Applied Ports

No commits have been cherry-picked or manually ported yet.