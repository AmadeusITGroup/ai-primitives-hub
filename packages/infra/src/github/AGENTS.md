# `lib/src/github/` — shared GitHub middleware

**Read this before touching any GitHub-network-related code.**

## What this module is

Single-funnel HTTP client + supporting utilities for every GitHub
interaction in the lib. Consolidates two previously-parallel stacks
(`install/*` HTTP clients and `primitive-index/hub/*` API client)
into one consistent surface.

## Layout

| File | Purpose |
|------|---------|
| `client.ts` | `GitHubClient` — REST API funnel: retries, rate-limit, ETag, observability |
| `asset-fetcher.ts` | `AssetFetcher` — binary fetches (release assets, raw blobs) with the Accept-header switch |
| `url.ts` | URL builders (`buildApiUrl`, `buildRawContentUrl`, `buildReleaseAssetApiUrl`) and host predicates |
| `token.ts` | `TokenProvider` interface + `staticTokenProvider`, `envTokenProvider`, `ghCliTokenProvider`, `compositeTokenProvider`, `defaultTokenProvider` |
| `errors.ts` | `GitHubApiError`, `GitHubNetworkError` |
| `events.ts` | `ClientEvent`, `ClientEventHandler`, `NOOP_EVENT_HANDLER` |
| `etag-store.ts` | Persistent `{url -> etag}` JSON store (atomic write) |
| `blob-cache.ts` | Content-addressed (git blob SHA1) on-disk cache |
| `bench/` | Microbenchmark harness + standard cases with asserted thresholds |
| `index.ts` | Barrel — import from this when consuming |

## When to use which class

- **`GitHubClient`** — every JSON REST call. Get retries, rate-limit
  handling, ETag conditional requests, observability events for free.
- **`AssetFetcher`** — fetching binary content (release-asset zips,
  raw markdown blobs). Different Accept-header policy than the JSON
  client (handles I-012 — strict octet-stream on api.github.com,
  permissive elsewhere).
- **`EtagStore`** + **`BlobCache`** — when you need to persist HTTP
  caching across runs (the harvester does; the install pipeline
  currently doesn't but easily could).

## Key architectural rules

1. **Inject everything.** `fetch`, `sleep`, `random` are constructor
   options. This is the only way to write deterministic tests for
   retry/rate-limit/jitter logic.
2. **No `User-Agent` shenanigans.** The default UA is set once in
   `GitHubClient`/`AssetFetcher`. Don't add UA logic anywhere else.
3. **Tokens are host-aware.** A `TokenProvider.getToken(host)` only
   returns a token for GitHub hosts. Foreign hosts get `null`.
4. **No bare `fetch()` calls.** Anywhere outside this module that
   talks to GitHub should construct a `GitHubClient` /
   `AssetFetcher` and use it.

## Bench

```bash
npm run bench   # under lib/
```

Asserts that p95 of every standard case stays under its threshold:

| Case | Threshold (ms) | Typical p95 (ms) |
|---|---:|---:|
| cold (raw getJson) | 5 | 0.4 |
| warm-etag-304 | 1 | 0.07 |
| blob-cache-hit (inline-bytes) | 1 | 0.01 |
| transient-5xx (1 retry) | 5 | 0.4 |
| rate-limit recovery | 5 | 0.3 |

The default `npm test` runs a smoke version (N=2) of the bench so
schema breakage gets caught without paying the full cost.

## Adding a new GitHub-network feature

1. Decide whether it's a JSON GET (-> `GitHubClient`), binary GET
   (-> `AssetFetcher`), or stateful (-> `EtagStore` /
   `BlobCache`).
2. If you need a URL, build it via `url.ts` — never hand-roll.
3. If you need auth, take `TokenProvider` as a constructor option;
   never read env vars directly.
4. Add a test driving the fake fetch (see `test/github/*.test.ts`
   for patterns).
5. If your feature changes hot-path costs, add a case to
   `bench/cases.ts` with an appropriate threshold.
