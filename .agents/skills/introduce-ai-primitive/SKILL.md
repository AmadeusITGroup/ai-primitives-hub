---
name: introduce-ai-primitive
description: End-to-end contributor recipe for introducing an installable AI primitive kind or extending an existing kind to new targets, scopes, or delivery surfaces. Use for primitive installation or distribution changes.
---

# Introduce or enable an AI primitive

Use this recipe for a **new kind** or for **new support for an existing kind**. Read the root and closest `AGENTS.md` guides first. This is contributor guidance, not instructions for authoring a collection.

## 1. Define the contract and the actual gap

1. Check `packages/core/src/domain/primitive/types.ts` and `packages/core/src/public/schemas/collection.schema.json`. Do not add a second kind if the canonical kind already exists. PR #497's `knowledge` was already recognized; the missing capability was delivery to GitHub/Copilot and Kiro.
2. Write a small support matrix in the task or PR description: applicable source forms (canonical folder, explicit path elsewhere, nested skill asset), release formats (`formatVersion: 1` and legacy), target/host, user/workspace/repository scope, install/update/uninstall, persisted path, and unsupported-target policy. Decide which distribution formats and discovery/UI surfaces belong in this change and create a tracked follow-up with acceptance criteria for anything deferred. If the request is for generic collection support, do not make an optional skill, plugin, or interchange format mandatory.
3. State the mapping for a real declared item, including the full nested relative path, and its inverse for removal. Define how duplicate names, custom layouts, missing sources, malformed IDs, and unsupported routes behave. "Recognized in the schema" or "has a layout route" is not an end-to-end acceptance criterion.

## 2. Follow the source all the way into a release

- For a genuinely new kind, align the collection schema, `PRIMITIVE_KINDS`/`normalizePrimitiveKind`, manifest vocabulary and aliases, validators, author documentation, and their tests. Keep one canonical kind; translate legacy spellings at the boundary rather than creating another enum.
- Trace `lib/src/release-manifest.ts` and `lib/bin/generate-manifest.js`. A governed archive's `items[]` is authoritative; target writers receive the root deployment manifest plus inventory entries with `role: installable`. `metadata` and `ignored` are evidence, not target content. Check the legacy manifest projection and preserve source bytes, including skill assets and binary files when supported.
- In `packages/core/src/domain/collection/manifest-validator.ts`, use the same manifest selection rule for placement and projection: governed `formatVersion: 1` uses `items[]`; legacy uses `prompts[]` first plus distinct `items[]`, without double-installing an alias. Validate declared source paths and collisions **before** writing. Project a noncanonical source into a target-installable bundle key only when explicitly declared; do not copy its neighboring files or scan arbitrary repository folders.

## 3. Route by capability, not by filename guesses

- Add a route only for explicitly supported host/scope combinations in `packages/infra/src/writers/default-layouts.json`; check aliases, configured layouts, and `Target.allowedKinds`. Check `KIND_TO_ROUTE_KEY` in `packages/app/src/writers/file-tree-writer.ts` and any separate writer such as `packages/infra/src/writers/repo-scope-writer.ts`. The CLI's existing Copilot repository routes differ from some generic layouts; do not replace one writer with another without preserving installed paths and legacy lockfiles.
- Treat the explicit manifest kind before falling back to `determineFileType`. `packages/core/src/domain/install/copilot-file-type.ts` names only Copilot file types: do not send a generic kind to `getTargetFileName` or fabricate an extension for it.
- Trace **all entry points**, not just a layout test: CLI local and remote install, lockfile replay, profile activation, update, uninstall; extension `BundleInstaller`, `RepositoryScopeService`, `UserScopeService`, and workspace handling. Put shared rules in `core`/`app`, with filesystem effects behind ports, rather than duplicating business rules in delivery code. Define and test unsupported-target behavior explicitly: a CLI preflight can reject partial bundle content while a host without the route may skip an unsupported placement.

## 4. Make tracking, removal, and failure safety part of the feature

- Preflight every destination before creating directories or writing; reject traversal, absolute/drive paths, escaping parent symlinks, unsafe final symlinks, and hostile custom routes. Validate the physical parent and lexical repository root; a final link may be unlinked safely only when it is the entry being removed. Keep removal fail-closed: an unsafe lockfile entry must not trigger partial deletion or removal of the bundle's tracking record.
- Record the **actual written destination** for repository lockfiles using repository-relative forward slashes; use the appropriate canonical bundle key for user tracking. Pair every `written` path with its source bytes for checksums. Cover both committed and local-only modes: exclude exactly installed files, preserve other bundles' exclusions, and use the stored mode when uninstalling.
- Journal originals before writes; verify bytes; roll back new, overwritten, and partially written files if a later write or lockfile persistence fails. Do not overwrite files changed independently after the write. Surface incomplete rollback rather than claiming success. Persist tracking atomically where supported. Invalid paths in one bundle's read-only status check should not prevent healthy bundles from being listed, but must still block that unsafe bundle's destructive removal.

## 5. Prove the public behavior, including failures

Start with a failing test for one representative declared source, including a noncanonical path when the contract allows one. Then cover:

- Governed items-only and legacy manifests, including legacy manifests with both `prompts[]` and `items[]`; metadata/ignored and undeclared neighbors must not be installed.
- The host/scope matrix, a missing route, two sources sharing a basename, nested source paths, and an embedded skill asset where those forms are supported. Preserve existing naming/placement for other kinds.
- Install → lockfile entry → update or replay → uninstall round trips, modified files, custom layouts, local-only Git excludes, and unrelated/shared files. Test CLI commands and extension services through their public boundaries.
- Missing/unsafe declarations, traversal and symlinks, partial write and failed persistence, repeated sync of an owned link, and an unrelated user file or link. A test double must actually simulate the unsafe path rather than silently falling through.

For native filesystem paths use `node:path` `join`/`resolve` in assertions and mocks; for archive and lockfile values use forward slashes. Follow `packages/AGENTS.md`'s cross-platform checklist. `path.win32`/`path.posix` can exercise pure transformations off Windows, but cannot replace the Windows runner for filesystem semantics.

## 6. Review the complete scope before calling it done

1. Run focused tests first, then the affected package suites (`pnpm -C packages -r build`, `pnpm -C packages -r test`, `pnpm -C packages -r lint:fix`, and `pnpm -C lib test` when release generation changes). For extension work, compile tests and run `LOG_LEVEL=ERROR pnpm -C apps/vscode-extension run test:unit`; run relevant integration tests. Do not run non-fixing lint after `lint:fix`. Check that builds did not accidentally stage generated validation bundles.
2. Check the **latest PR head** in the Linux, macOS, and Windows matrix in `.github/workflows/vscode-extension-secure-ci.yml`. If working off Windows, use the CI job log through `gh` and do not claim Windows coverage from a Linux-only run. Keep platform-specific tests enabled unless the platform lacks a required capability and equivalent safety behavior is tested elsewhere.
3. Independently review the complete source-to-destination and failure path. If CodeRabbit CLI is available, review against the exact PR base and include uncommitted/untracked changes (`coderabbit review --deep --base-commit <base-sha> --include-untracked --agent`); verify each finding rather than following suggestions that weaken fail-closed behavior. Re-run review after the final fixes.
4. Audit marketplace counts, filters, cards, and details **if discoverability is in scope**; an installable kind need not yet be visible there. If deferred, say so in the PR and write a dedicated issue with agentic acceptance guidance. Update author, user, and installation-flow docs for behavior shipped. Keep the PR description, linked issue, unresolved review threads, required approvals, and claimed CI status aligned with the code that will merge.

## Worked example: `knowledge` in PR #497

Issue #496 specified a normal collection item whose source lives outside `.github`:

```yaml
items:
  - path: specifications/RDP/provider_layer/SBB_B2P/SBB_B2P.md
    kind: knowledge
```

- `knowledge` already existed in the schema and `PrimitiveKind`. The release archive kept the source path and marked its file `installable`. Adding only a `knowledge/` layout route **did not** make a prefix-routed writer see `specifications/...`.
- Manifest-aware projection supplies `knowledge/specifications/RDP/provider_layer/SBB_B2P/SBB_B2P.md` to supported writers. GitHub/Copilot installs it under `.github/knowledge/…` and Kiro under `.kiro/knowledge/…`, without copying undeclared neighbors. Repository lockfiles track the physical destination so uninstall can invert the mapping.
- Canonical-only manifests, CLI and extension scopes, skill sidecars, rollback, symlink containment, and Windows-native test paths each required separate checks. The original PR description still describes manifest-aware installation as future work: update the description when scope grows.
- Marketplace primitive coverage and a unified repository writer remain explicit follow-ups, not hidden assumptions of this installation PR.
