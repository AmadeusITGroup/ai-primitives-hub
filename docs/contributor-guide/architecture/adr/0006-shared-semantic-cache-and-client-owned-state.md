# ADR-0006: Shared Semantic Cache and Client-Owned State

**Status:** Accepted

## Context

ADR-0005 established `AppStorage` as the framework-independent storage port
and deliberately preserved the VS Code extension's existing
`globalStorageUri` layout for compatibility. That decision correctly prevents
an undiscoverable relocation of existing user data, but it leaves an important
long-term policy ambiguous: whether every artifact accessed by the extension
should remain physically inside VS Code global storage.

The CLI and VS Code extension are two delivery mechanisms for the same
application. They should be able to reuse compatible semantic artifacts such
as source metadata, downloaded bundle archives, embedding models, and
primitive indexes. Keeping those artifacts in separate client roots creates
duplicate downloads, duplicate indexes, and different freshness behavior.

At the same time, not all persisted data is reusable. Activation migrations,
UI preferences, extension lifecycle state, and state whose meaning depends on
VS Code are correctly owned by the extension. Moving that state to a shared
cache would couple unrelated clients and make lifecycle cleanup unsafe.

The primitive index makes the boundary concrete. It is a semantic cache, but
it must not be treated as one global file: indexes from different hubs, source
snapshots, or ranking profiles are not interchangeable.

This ADR narrows only the physical-placement assumption in ADR-0005's
decision 3. It does not supersede the `AppStorage` port, the compatibility
adapter, or the requirement to preserve existing user data.

## Decision

1. **Keep ADR-0005 in force for the storage abstraction and compatibility
   promise.** `AppStorage` remains an injected port. Existing VS Code data
   under `globalStorageUri` remains readable, and no accepted storage decision
   is silently invalidated by this ADR.

2. **Separate logical storage from physical placement.** An `AppStorage`
   implementation resolves logical application namespaces, but the choice of
   physical root is a policy of the composition root. Application use cases
   and shared index/search code must not depend on `vscode` or construct a
   client-specific storage adapter.

3. **Use a shared XDG-compatible cache policy for reusable semantic
   artifacts.** Where the platform supports it, the CLI and VS Code extension
   use the same application cache namespace for:

   - source and bundle metadata;
   - downloaded archives and extracted content caches;
   - embedding/model artifacts; and
   - persisted primitive indexes.

   On platforms without XDG, `infra` may map the same policy to the platform's
   standard shared per-user cache location. The policy is shared; callers do
   not assume a Unix-specific absolute path.

4. **Keep client-owned state in client-owned stores.** VS Code
   `globalStorage` remains the home for activation migrations, UI preferences,
   extension lifecycle state, and VS Code-specific installation or workspace
   state. CLI/application configuration and persistent non-cache data remain
   in their appropriate XDG data/config roots.

5. **Namespace semantic indexes by their compatibility inputs.** A persisted
   primitive index must be addressed by a stable representation of at least:

   ```text
   <cache>/ai-primitives-hub/indexes/<hub-key>/<source-revision>/<profile-id>/primitive-index.v2.json
   ```

   The exact path encoding is implementation-defined, but the key must prevent
   one hub, source snapshot, or ranking/embedding profile from loading another
   one's index. Coverage and profile metadata remain authoritative at load
   time; the filename alone is never sufficient for compatibility.

6. **Migrate conservatively.** Existing extension-local cache entries are
   read-compatible during migration. New shared entries are introduced only
   with explicit ownership and invalidation rules. Writes are atomic, failed
   refreshes retain the last-known-good index, and concurrent writers must use
   a defined lock or single-writer policy. Migration must not silently delete
   or move existing data.

7. **Retain Option B from the cross-delivery index/search design.** The app
   layer owns index lifecycle and search use cases; the CLI and VS Code
   extension remain thin delivery adapters. This ADR changes the physical cache
   policy, not the dependency direction or the shared ranking/search contract.

8. **Expose read-only search through a typed application contract.** Delivery
   adapters use `PrimitiveSearchRequest` and `PrimitiveSearchResponse` rather
   than inferring an index condition from file-system or embedding errors.
   The response distinguishes ready, degraded, and unavailable search, while
   `IndexStatus` distinguishes missing, refreshing, partial, incompatible, and
   failed snapshots. The query operation only reads a persisted index; it never
   enumerates providers, resolves remote revisions, or initiates a rebuild.

## Consequences

- **Positive:** the CLI and VS Code extension can reuse compatible semantic
  caches, reducing duplicate downloads and avoiding divergent index behavior.
- **Positive:** the index remains client-agnostic while still being scoped to
  the active hub, source revision, and search profile.
- **Positive:** VS Code lifecycle state remains isolated from cache eviction
  and from other delivery mechanisms.
- **Negative:** cache ownership, locking, migration, and invalidation require
  explicit implementation work; simply changing a path is not sufficient.
- **Negative:** existing VS Code cache files temporarily require a
  compatibility read path while the namespaced shared-cache migration is
  rolled out.
- **Unaffected:** repository-relative lockfiles and target installation roots
  remain governed by their existing contracts; they are not semantic caches
  and must not be moved by this ADR.

## Implementation implications

The implementation should proceed in this order:

1. Add a narrow shared-cache/index storage port or extend `AppStorage` with
   logical cache namespaces; preserve explicit path overrides for diagnostics.
2. Move hub/source/profile-aware index path resolution to the application or
   composition boundary, not `PrimitiveIndexService`.
3. Add atomic persistence, last-known-good retention, compatibility checks,
   and a migration reader for the existing VS Code cache layout.
4. Add cross-delivery contract tests proving equivalent corpus/profile/query
   inputs produce equivalent results from CLI and VS Code.
5. Remove the compatibility reader only in a separately documented breaking
   change after the supported migration window has elapsed.
