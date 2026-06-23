# app — Use-Case Orchestration

Wires `core` ports + `infra` adapters into pipelines. Depends on `core` + `infra`.

## Structure

```
src/
├── install/        → Install/uninstall pipeline
│   ├── pipeline.ts
│   ├── install-bundle.ts
│   ├── uninstall-bundle.ts
│   ├── uninstall-pipeline.ts
│   └── layout-resolver.ts
├── transform/      → Resource transformation per target
│   ├── transformer-registry.ts   → Register all transformers here
│   └── transformers/
│       ├── kiro-transformer.ts
│       └── noop-transformer.ts
├── registry/       → Registry management
├── search/         → Search use cases
├── collection/     → Collection operations
├── discovery/      → Discovery use cases
├── context-detection/ → Target context detection
├── resolvers/      → Source resolution orchestration
├── stores/         → Store orchestration
└── writers/        → File tree writer
```

## Build & Test

```bash
pnpm --filter=@prompt-registry/app run build
pnpm --filter=@prompt-registry/app run test
pnpm --filter=@prompt-registry/app run test:coverage
pnpm --filter=@prompt-registry/app run lint
```

Uses **Vitest**.

For iteration, prefer `test`; use `test:coverage` when the change affects a wider
app slice.

## Adding a Transformer

1. Create `src/transform/transformers/<target>-transformer.ts` implementing `IResourceTransformer` from `@prompt-registry/core`
2. Register it in `src/transform/transformer-registry.ts` (in `TransformerRegistry.withBuiltIns()`)
3. The `TargetType` must already exist in `core/src/domain/install/target.ts`

A transformer file that is not registered in `withBuiltIns()` silently falls back
to `NoOpTransformer` for that target.

## Adding to the Install Pipeline

The install flow runs in `src/install/pipeline.ts`. Steps are composed there — add new pipeline steps by extending the pipeline, not by modifying `install-bundle.ts` directly unless adding bundle-level logic.
