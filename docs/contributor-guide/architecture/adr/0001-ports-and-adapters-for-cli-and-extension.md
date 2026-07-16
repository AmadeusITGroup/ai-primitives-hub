# ADR-0001: Ports & Adapters Across the CLI and the VS Code Extension

**Status:** Accepted

## Context

The reference branch (`feat/library-centric-flows-with-cli`) introduced a
ports-and-adapters split (`packages/core`, `infra`, `app`, `cli`) for its new
CLI, but the VS Code extension was relocated into the same monorepo
(`apps/vscode-extension`) without adopting those layers — it kept its
original `src/services/*` implementation. The result: two parallel, largely
duplicated implementations of the same domain (bundles, sources, hubs,
installs), not one domain shared by two delivery mechanisms. This defeats
the stated purpose of the pattern ("add new delivery mechanisms without
changing domain") and is the single largest architectural defect identified
during the migration-plan review (see `.tmp/ai-primitives-hub-next-migration-plan.md` §3.3.1).

## Decision

Adopt ports & adapters **end-to-end**: `core` (domain types + ports), `infra`
(adapters), `app` (use-case orchestration), `cli` (thin Clipanion delivery
adapter) — and migrate the VS Code extension onto `app`/`core`/`infra` too,
not just the CLI. The extension keeps its own UI/command/webview code (VS
Code is itself a delivery mechanism in this model) but stops re-implementing
business logic that already exists in `app`.

Migration uses a **strangler fig**, not a rewrite: each `src/services/*`
class is extracted into `app` one at a time (smallest/most independent
first), becoming a thin delegator, so the extension is fully working and
tested at every commit. See migration plan §6.3 and §7.5 (Phase 4).

## Consequences

- **Positive:** one implementation of domain logic for both the extension
  and the CLI; the "independence of delivery mechanism" claim becomes true
  and testable, not aspirational.
- **Positive:** each extraction commit is small, reviewable, and
  independently revertable.
- **Negative:** slower to reach full architectural alignment than a
  big-bang rewrite would be — accepted deliberately in exchange for the
  extension never being broken mid-migration.
