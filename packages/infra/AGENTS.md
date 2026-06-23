# infra — Port Adapters

Implements all ports defined in `core`. Depends on `core` only — never import `infra` from `core`.

## Structure

```
src/
├── github/       → Single-funnel GitHub HTTP client for ALL GitHub interactions
│   ├── client.ts         → Main GitHub client (consolidates all GitHub HTTP)
│   ├── token.ts          → Auth token resolution
│   ├── blob-cache.ts     → ETag-based blob caching
│   └── asset-fetcher.ts  → Release asset downloads
├── writers/      → ITargetWriter implementations (one per TargetType)
│   ├── repo-scope-writer.ts
│   └── zip-writer.ts
├── resolvers/    → ISourceResolver implementations
│   ├── github-resolver.ts
│   ├── awesome-copilot-resolver.ts
│   ├── local-resolver.ts
│   ├── hub-resolver.ts
│   └── skills-resolver.ts
├── http/         → NodeHttpClient (IHttpClient adapter)
├── fs/           → Filesystem adapter (IFilesystem)
├── stores/       → Index stores
├── downloaders/  → Bundle downloaders
├── extractors/   → Bundle extractors
├── search/       → Search adapter
├── harvest/      → Bundle providers
├── discovery/    → Discovery adapter
└── scaffolding/  → Scaffold templates + adapter
```

## Build

```bash
pnpm --filter=@prompt-registry/infra run build
pnpm --filter=@prompt-registry/infra run test
pnpm --filter=@prompt-registry/infra run lint
```

Build includes a `copy-templates` step (`node -e fs.cpSync`) — do **not** replace with shell `cp`.

## Export And Registration Checks

`src/index.ts` is the public infra barrel. After adding a resolver, writer, or
other adapter, export it there as well as registering it in the relevant registry
such as `src/resolvers/resolver-registry.ts`.

## GitHub Client (`src/github/`)

`src/github/` is the **single funnel** for all GitHub network interactions. All GitHub-related HTTP must go through `client.ts`. Do not create parallel GitHub HTTP stacks elsewhere.

## Adding a New Target Writer

1. Create `src/writers/<target>-writer.ts` implementing `ITargetWriter` from `@prompt-registry/core`
2. Export from the package index
3. Wire into `app` pipelines — the `TargetType` must already exist in `core`

## Adding a New Source Resolver

1. Create `src/resolvers/<name>-resolver.ts` implementing `ISourceResolver`
2. Register in `resolver-registry.ts`
3. Export from the package index
