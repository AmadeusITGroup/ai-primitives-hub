# ADR-0007: Source-Aware GitHub App Authentication for CLI Workflows

**Status:** Accepted

## Context

The CLI and primitive-index harvester access a Hub whose configured sources can
span many GitHub organizations and repositories. The legacy source path could
fall back to anonymous GitHub requests, while a single generic developer token
is not an appropriate identity for every private source. Anonymous requests
also have a small shared rate-limit budget and can make a full Hub operation
fail late or appear stalled while retrying until a reset window.

The source-aware CI path therefore needs to select credentials from evidence
in the configured Hub, preserve repository scope across API/raw/asset hosts,
and fail before source work when access cannot be established. The decision
also affects `core` ports, `infra` adapters, CLI wiring, temporary credential
configuration, caching, and operational documentation.

ADR-0006 already defines the shared cache policy for reusable semantic
artifacts. This ADR narrows the authentication-related cache boundary: source
content and conditional-request metadata may be persisted when their
invalidation rules are explicit, but credentials and private-key material are
not cache artifacts.

## Decision

1. **Make source-aware authentication explicit and opt-in.**
   `AI_PRIMITIVES_HUB_GH_APP_AUTH_ENABLED` enables the stricter CLI/harvest
   path. When it is unset or false, the existing developer compatibility path
   remains unchanged.

2. **Require authenticated generic evidence before source classification.**
   Source-aware public and visibility checks use `GH_TOKEN`, then
   `GITHUB_TOKEN` in CI, or the local `gh auth token` provider where local
   fallback is allowed. Anonymous source-aware access is rejected before a
   GitHub request. Missing generic credentials, ambiguous visibility, rate
   limits, malformed targets, and failed checks produce an `unresolved`
   result; they do not trigger an anonymous fallback.

3. **Use repository-scoped GitHub App installation tokens only for sources
   proven to require them.**
   A source whose authenticated generic evidence reports private or otherwise
   requires repository-scoped access is checked with `gh app-auth token
   --repo <host>/<owner>/<repository>`. App-authenticated requests cannot fall
   back to a generic or personal credential. Public sources remain on the
   generic authenticated path.

4. **Carry source repository context separately from request host.**
   `TokenProvider` receives the request host plus an optional normalized
   `GitHubRepositoryTarget`. This allows API, raw-content, codeload, and
   release-asset requests for one source to use the same repository-scoped App
   decision without treating `api.github.com` or
   `raw.githubusercontent.com` as the App repository.

5. **Keep App setup separate from token lookup.**
   `gh app-auth setup` is an explicit bootstrap operation. The CLI derives
   organization wildcard routes from the observed App candidates, creates a
   temporary filesystem configuration only when App bootstrap inputs are
   explicitly supplied, and removes the temporary workspace in `finally`
   cleanup. `TokenProvider.getToken()` only validates context, mints, caches,
   or reuses a token; it does not discover installations or perform setup.

6. **Use safe in-memory App token caching.**
   Installation tokens are cached by exact canonical repository plus App/config
   identity, with single-flight refresh and a conservative lifetime below the
   one-hour GitHub token lifetime. Tokens are process-local and are never
   persisted in files, GitHub Actions caches, progress logs, snapshots,
   lockfiles, telemetry, or diagnostics.

7. **Persist only safe source content metadata where it improves repeat runs.**
   The existing content-addressed Git `BlobCache` and ETag store may be reused
   by trusted workflows. A GitHub Actions cache may carry `blobs/` and
   `etags.json` when the cache key includes a format namespace, runtime/dependency
   family, and verified source revision. It must not carry App tokens, PEMs, or
   unreviewed derived state by default. Cache restore is an optimization, not
   an authentication or authorization decision.

8. **Keep source decisions immutable and observable for one operation.**
   Each requested source receives a deterministic category, target, checked
   operations, optional verified revision, credential mode, and stable error
   code. Any unresolved source fails the requested operation and is exposed in
   the sanitized preflight report. A mutable shared client must not switch
   repository scope between requests.

9. **Limit the first implementation to CLI/CI and harvesting.**
   VS Code authentication and automatic hidden App setup in unrelated commands
   are out of scope for this decision. Install/update integrations may reuse
   the source-aware providers, but any future bootstrap convenience must retain
   the same explicit credentials, cleanup, and fail-closed rules.

## Alternatives considered

- **Anonymous-first with authenticated fallback:** rejected because it spends
  the unauthenticated budget before knowing whether authentication is needed,
  can stall on rate-limit reset sleeps, and violates the source-aware
  no-anonymous policy.
- **One generic/personal token for every source:** rejected because it does
  not provide repository-scoped access across all configured organizations and
  makes credential ownership/permission failures ambiguous.
- **App provider first with generic fallback:** rejected because it can use a
  credential for a source category that has not been established and can hide
  missing generic visibility evidence.
- **Persist installation tokens in the shared/Actions cache:** rejected due
  to expiry, revocation, secret-at-rest, cross-job, and cache-poisoning risks.
- **Central proxy or a single long-lived service credential:** deferred; it
  changes the trust boundary and operational ownership beyond this CLI
  feature. The repository-scoped App remains the smallest available change.
- **Apply the feature to the VS Code extension immediately:** deferred to
  avoid coupling an extension session/account-selection UX to CI bootstrap and
  to keep the first rollout limited to the CLI/harvester boundary.

## Consequences

- **Positive:** public sources use authenticated access from the first request,
  private sources receive least-scope App credentials, and source failures are
  reported before partial work is performed.
- **Positive:** API and download hosts retain the correct source repository
  scope; App token reuse reduces repeated child processes within one CLI
  invocation.
- **Positive:** content-addressed blob reuse and conditional requests can make
  repeated trusted harvests cheaper without persisting credentials.
- **Negative:** source-aware preflight adds metadata, commit, tree, collection,
  and release requests before normal operations. GitHub primary and secondary
  limits must be treated as shared operational capacity, with canaries,
  serialization, telemetry, and backoff/circuit-breaker behavior.
- **Negative:** CI must provision a supported `gh-app-auth` extension, App
  permissions/repository selection, generic credential, App selector, and
  private key. The full original Hub scope can remain unresolved until external
  App installation configuration is corrected.
- **Negative:** a separate CLI process cannot warm the process-local App token
  cache. Safe content/ETag caches may cross processes, but derived state needs
  explicit freshness and compatibility rules.
- **Unaffected:** the legacy non-opt-in developer path, VS Code account
  selection, repository lockfile semantics, and existing client-owned storage
  decisions remain governed by their existing contracts.

## Implementation implications

1. Keep the repository target and authentication category in the source-bound
   construction path from `app` through `infra` adapters and CLI commands.
2. Test missing generic credentials, anonymous rejection, category isolation,
   repository/host mismatch, route/installation failures, timeout/output
   validation, cache expiry, and concurrent single-flight calls.
3. Retain sanitized structured preflight reports in CLI JSON envelopes and
   fail closed when any requested source is unresolved.
4. Treat GitHub Actions cache as a trusted-run optimization. Use a rolling
   source-revision key, avoid pull-request cache exposure for private content,
   serialize jobs sharing a credential or installation, and gate expensive
   runs with real endpoint quota canaries.
5. Measure request counts and response-limit headers by authentication category
   before adding broad concurrency or cross-process content-cache policies.
6. Revisit the decision if App setup becomes a supported user-facing VS Code
   feature, if a central proxy changes the trust model, or if persistent
   derived-index state is made portable with explicit compatibility metadata.
