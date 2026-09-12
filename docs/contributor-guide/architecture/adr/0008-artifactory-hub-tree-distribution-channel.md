# ADR-0008: Generic Artifactory Hub Tree as an Explicit Distribution Channel

**Status:** Proposed

## Context

AI Primitives Hub currently treats GitHub as the primary runtime source for
published bundle metadata and release assets. Enterprise consumers may need to
consume the same governed artifacts from JFrog Artifactory because GitHub is
unavailable, restricted, or not approved as the runtime binary-distribution
channel. The consumer must still receive the existing AI Primitives Hub bundle
contract: deployment manifests, ZIP archives, optional READMEs, metadata,
checksums, and reproducible lockfile behavior.

JFrog offers native Agent Packages/APM, Skills, and Agent Plugins surfaces, but
those contracts are beta or scope-limited, use package layouts that differ from
AI Primitives Hub bundles, and do not represent every supported primitive kind
as one atomic installable bundle. Artifactory repository listing, AQL, or
recursive Storage API discovery would add provider-specific permissions,
N+1 requests, and topology coupling.

The feature also crosses the shared architecture boundary. It needs domain
validation and ports in `packages/core`, HTTP and credential adapters in
`packages/infra`, use-case composition in `packages/app`, and thin delivery
wiring in the CLI and VS Code extension. Private hub consumption additionally
requires a consistent credential policy: CLI credentials must be supplied by a
host environment, VS Code token values must remain in SecretStorage, and
neither delivery may silently reuse GitHub credentials for an Artifactory host.

The repository's study and implementation identify a complete Artifactory hub
tree as the supported private topology:

```text
<hub-root>/hub-config.yml
<hub-root>/sources/<source-id>/index-v1.json
<hub-root>/sources/<source-id>/bundles/<bundle-id>/<version>/deployment-manifest.yml
<hub-root>/sources/<source-id>/bundles/<bundle-id>/<version>/<bundle-id>-<version>.zip
<hub-root>/sources/<source-id>/bundles/<bundle-id>/<version>/README.md
```

The architectural choice should be recorded separately from the implementation
so that the generic repository/static-index model, source identity, trust
boundary, and fallback policy are not defined only by the current branch or PR.

## Decision

1. **Use a generic Artifactory repository with an AI Primitives Hub static index
   for the MVP.**

   Each Artifactory source has a configured source root and a versioned
   `index-v1.json` catalog. The index contains normalized bundle metadata,
   immutable relative object paths, sizes, SHA-256 digests, and optional
   provenance fields. The existing `deployment-manifest.yml`, ZIP archive, and
   installation contracts remain authoritative for installed content.

2. **Model Artifactory as an explicit source type and distribution channel.**

   Hub and lockfile schemas, source identity, adapters, resolvers, and delivery
   commands recognize `artifactory` directly. Artifactory and GitHub sources
   retain provider-specific identities in the MVP. Equivalent content exposed
   by both providers is therefore selected explicitly rather than implicitly
   deduplicated or merged.

3. **Support a complete private hub tree so runtime consumption does not require
   GitHub access.**

   A private Artifactory hub reference resolves `hub-config.yml` from the
   configured repository root. The imported configuration points to Artifactory
   source roots containing their indexes and bundle objects. A successful
   source-index request alone is not considered sufficient: hub configuration,
   index, manifest, archive, install/update, and exact-version lockfile replay
   must all be supported by the same configured channel.

4. **Use source-scoped Bearer credentials with delivery-specific secret
   providers.**

   The source configuration stores only an opaque credential reference and an
   authentication mode. The CLI resolves the reference through the process
   environment or its injected host credential provider. The VS Code extension
   stores the token value only in `ExtensionContext.secrets` and persists the
   reference/label in non-secret state. Credentials are attached only when the
   request matches the configured Artifactory origin and confined path prefix;
   unsafe redirects receive no credential. GitHub token providers are never a
   fallback for Artifactory requests. Basic authentication is deferred unless a
   qualified target requires it.

5. **Put provider behavior in shared layers and keep deliveries thin.**

   - `core` owns source/index shapes, validation rules, integrity policy, error
     contracts, and credential ports without HTTP, filesystem, or VS Code
     dependencies.
   - `infra` owns the Artifactory HTTP client, static-index adapter, hub
     resolver, bundle downloader, credential implementations, and publication
     adapters.
   - `app` composes adapters and orchestrates source, hub, install, lockfile,
     and replication workflows.
   - The CLI parses options, resolves environment-backed credentials, and
     formats output; it does not implement provider rules.
   - The VS Code extension owns prompts, SecretStorage wiring, notifications,
     and delivery-specific UX; it does not duplicate Artifactory business
     logic.

   This preserves ADR-0001's one shared domain across the CLI and extension and
   follows the repository's strangler-fig migration boundary.

6. **Fail closed and verify integrity before installation.**

   Artifactory index responses are bounded and schema-validated. Object paths
   must be safe relative paths confined to the source root; duplicate bundle
   identities are invalid. The client verifies the downloaded archive's size
   and SHA-256 before extraction, then reuses the existing root-manifest,
   archive-safety, file-integrity, and writer-verification pipeline. Manifest
   identity/version disagreement, path violations, malformed data, checksum
   mismatches, and 401/403 responses are terminal errors and never trigger
   GitHub fallback.

7. **Keep publication separate from consumption and publish complete trees in a
   safe order.**

   GitHub remains the canonical authoring and provenance channel. Replication or
   other CI tooling may copy verified release bytes into Artifactory, but
   clients do not publish directly. A publication run writes immutable bundle
   objects first, verifies or reuses same-digest existing objects, publishes a
   complete source index second, and publishes `hub-config.yml` last. Dry-run
   and explicit review acknowledgement are required before writes in the CLI.
   Conflicting or unverifiable existing objects stop the operation by default.

8. **Defer native JFrog package contracts, transparent fallback, and signing.**

   Native Agent Packages/APM, Skills, and Agent Plugins integrations remain
   separate future adapters. Automatic GitHub/Artifactory fallback is deferred
   until a separate channel-identity and policy ADR defines its provenance,
   lockfile, and failure semantics. The MVP's unsigned index is an integrity
   and consistency mechanism, not an independent proof of publisher identity;
   signing/evidence requires a future trust-root and verification decision.

## Alternatives considered

- **Keep GitHub as the only runtime distribution channel:** rejected because it
  does not support private-network and approved-enterprise-repository use cases.
- **Use native JFrog Agent Packages/APM:** rejected for MVP because the surface
  is beta, has a different package-root contract, and does not preserve the
  existing complete bundle model without conversion.
- **Use native Skills or Agent Plugins repositories:** rejected because these
  split a collection across primitive families and cannot represent every
  supported primitive kind as one atomic bundle.
- **Use Artifactory listing, Storage API, or AQL for discovery:** rejected
  because it introduces provider-specific permissions, N+1 requests, and
  topology/version coupling; one validated static index is deterministic and
  portable.
- **Proxy GitHub through Artifactory:** rejected as the primary contract because
  it retains mutable source-repository semantics and does not provide a
  governed immutable bundle catalog.
- **Merge Artifactory and GitHub behind transparent fallback:** deferred because
  authentication, integrity, provenance, source identity, and lockfile replay
  failures must not silently change providers.
- **Persist Artifactory tokens in hub configuration or shared application
  state:** rejected because it violates the secret boundary; only references
  and non-secret configuration may be persisted.

## Consequences

- **Positive:** existing bundle ZIPs and deployment manifests remain usable
  without conversion, so all current primitive kinds share one installation
  pipeline.
- **Positive:** catalog synchronization requires one bounded index request per
  source and does not require AQL or recursive repository listing.
- **Positive:** CLI and VS Code use the same source adapter, resolver, integrity
  checks, and lockfile semantics while retaining their native credential UX.
- **Positive:** a complete private hub tree can operate without private GitHub
  runtime access, and explicit provider identity makes policy and provenance
  observable.
- **Positive:** immutable object paths, checksums, and ordered publication make
  interrupted or resumed replication safer and keep incomplete content out of
  advertised indexes.
- **Negative:** the project owns the index schema, publisher behavior, and
  compatibility policy instead of delegating discovery to native JFrog package
  APIs.
- **Negative:** Artifactory and GitHub versions of equivalent content are not
  transparently deduplicated in the MVP; users must choose the source/channel
  explicitly.
- **Negative:** a static index with SHA-256 detects corruption and mismatch but
  does not independently establish publisher identity. Signing/evidence remains
  a future security decision.
- **Negative:** real Artifactory qualification is required for endpoint routing,
  ETag behavior, repository topology, token scopes, and least-privilege
  publisher permissions. The publisher must not retain delete permission for
  production sign-off.
- **Unaffected:** GitHub remains the default source and existing GitHub/local/
  APM/Skills/Azure workflows retain their current contracts. Existing identifier
  compatibility rules and the XDG/AppStorage decisions from ADR-0004 through
  ADR-0006 remain in force.

## Implementation implications

1. Keep `artifactory` in core source unions, hub/lockfile schemas, source ID
   normalization, and public validation paths.
2. Keep `index-v1.json` validation strict: bounded input, safe relative paths,
   valid SemVer, unique `(id, version)` entries, object metadata, and matching
   configured source identity.
3. Bind Artifactory credentials to the exact normalized origin and path prefix;
   strip them on cross-origin or out-of-prefix redirects and never include
   values in URLs, logs, caches, snapshots, lockfiles, or serialized output.
4. Use the injected storage ports for validated index cache metadata and follow
   ADR-0005/0006; credentials are not cache artifacts.
5. Preserve exact source/object paths and archive checksums in lockfile entries so
   replay does not re-evaluate a mutable `latest` index.
6. Keep replication as an explicit app use case with a thin CLI command and a
   separate publisher port. Require dry-run/review gates, request budgets,
   bounded concurrency, cache/resume behavior, conflict checks, and ordered
   publication.
7. Test both deliveries against shared fixtures and mock external HTTP/auth
   boundaries. Add live qualification only with approved disposable prefixes
   and separate read-only consumer and deploy-only publisher principals.
8. Update source, command, publishing, replication, schema, testing, and
   security documentation when behavior or operational requirements change.
9. Revisit this ADR before adding native JFrog package adapters, transparent
   cross-provider fallback, Basic authentication, or signed/evidence-backed
   publication.

## Related decisions

- [ADR-0001: Ports & Adapters Across the CLI and the VS Code Extension](./0001-ports-and-adapters-for-cli-and-extension.md)
- [ADR-0005: Universal, XDG-Based Application Storage Port](./0005-universal-xdg-based-app-storage.md)
- [ADR-0006: Shared Semantic Cache and Client-Owned State](./0006-shared-semantic-cache-and-client-owned-state.md)
- [ADR-0007: Source-Aware GitHub App Authentication for CLI Workflows](./0007-source-aware-github-app-authentication.md)
