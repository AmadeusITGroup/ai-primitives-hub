# ADR-0003: Primitive Index/Search/Harvest and Full Multi-Target Support In Scope

**Status:** Accepted

## Context

The reference branch adds a hand-rolled BM25 primitive-index/search/harvest
subsystem and multi-target support (`vscode`, `vscode-insiders`,
`copilot-cli`, `kiro`, `windsurf`, `claude-code`) alongside its architecture
refactor. Initial migration-plan drafting recommended deferring both as a
separate epic, to avoid conflating "align architecture" with "ship new
product surface." On review, the product argument for inclusion was judged
stronger: without search/discovery, installing a bundle first requires
already knowing it exists, which weakens the CLI's UX; multi-target support
is also largely modeled already (`core`'s `Target` union already includes
all six types).

Investigation while planning surfaced a nuance worth recording: only the
**Kiro** target has a real content transformer
(`app/transform/transformers/kiro-transformer.ts`) in the reference branch —
Windsurf and Claude-Code currently fall back to a no-op transformer, i.e.
only the type/writer plumbing exists for them, not real content adaptation.

## Decision

Include both in scope for `feat/ai-primitives-hub-next`, sequenced as their
own dedicated commits/sub-phases (harvest+search infra in Phase 3,
discovery/search orchestration and multi-target transforms in Phase 4,
`index`/`discover` CLI commands alongside `install`/`uninstall` — not after
— in Phase 5), rather than deferred. Windsurf and Claude-Code transformers
are written for real during Phase 4, not copied as no-ops.

## Consequences

- **Positive:** the CLI ships with real discoverability and full multi-target
  support from its first release, matching the reference branch's product
  ambition.
- **Negative:** materially larger scope than a pure architecture-alignment
  effort; Phases 3–5 carry more work than originally scoped. Mitigated by
  keeping this work in its own commits, separate from the pure
  domain-extraction commits, so review and `git bisect` aren't complicated
  by mixing the two concerns.
