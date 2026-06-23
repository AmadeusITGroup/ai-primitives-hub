# core — Domain Types & Port Interfaces

**Invariant: no imports from `infra`, `app`, `cli`, `sdk`, or `apps/*`.** Enforced by TypeScript project references and ESLint rule `local-domain/no-feature-imports-in-domain`.

## Structure

```
src/
├── domain/
│   ├── bundle/       → BundleRef, BundleManifest, HarvestedFile, BundleProvider
│   ├── collection/   → Collection types
│   ├── discovery/    → Discovery types
│   ├── hub/          → HubConfig, HubSourceSpec, PluginManifest
│   ├── install/      → Target, TargetType, installation layout types
│   ├── primitive/    → Primitive (union), PrimitiveKind, PRIMITIVE_KINDS
│   ├── registry/     → RegistryConfig types
│   ├── scaffold/     → Scaffold types
│   ├── skill/        → Skill types
│   ├── source/       → Source types
│   └── index.ts      → Barrel exports
├── ports/            → Port interfaces (IBundleDownloader, IFilesystem, IHttpClient,
│                        IGitHubApi, ITargetWriter, IResourceTransformer, etc.)
└── public/schemas/   → JSON Schemas for manifests shipped with the package
```

## Build

```bash
pnpm --filter=@prompt-registry/core run build
```

Build includes a `copy-schemas` step (`node -e fs.cpSync`) — do **not** replace with shell `cp` (intentional for Windows compatibility).

## Current Target Types

`vscode` | `vscode-insiders` | `copilot-cli` | `kiro` | `windsurf` | `claude-code`

Defined in `src/domain/install/target.ts` as `TARGET_TYPES` const array.

## Domain Type Promotion Rule

Only add types here when **≥2 feature consumers** exist (or one feature + one public-API consumer). Single-consumer types stay in their feature layer. Speculative promotion creates dead code.

## Adding a New Domain Type

1. Add to the appropriate subdomain in `src/domain/`
2. Re-export from `domain/index.ts`
3. Pin the new shape in `test/domain/domain-shape.test.ts` (if applicable)
4. If it requires I/O, define a **port** (interface) in `src/ports/` — no implementations here

## Adding a New Target Type

- [ ] Add to `TARGET_TYPES` array in `src/domain/install/target.ts`
- [ ] Add discriminated union variant in `target.ts`
- [ ] Add writer in `packages/infra/src/writers/`
- [ ] Add transformer in `packages/app/src/transform/transformers/` (if content needs adaptation)
- [ ] Register transformer in `packages/app/src/transform/transformer-registry.ts`

## Type Patterns

```typescript
// Branded IDs to prevent confusion
type BundleId = string & { readonly __brand: 'BundleId' };

// Discriminated unions for variants
type Primitive =
  | { kind: 'prompt'; title: string }
  | { kind: 'skill'; name: string }
  | { kind: 'agent'; title: string; model: string };

// All domain properties are readonly
export interface BundleManifest {
  readonly id: string;
  readonly version: string;
}
```
