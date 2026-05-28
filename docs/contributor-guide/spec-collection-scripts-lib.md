# Specification: Collection Scripts Library (`@prompt-registry/collection-scripts`)

**⚠️ DEPRECATED:** This specification is deprecated. The `@prompt-registry/collection-scripts` package has been replaced by individual packages in the monorepo:
- `@prompt-registry/core` for domain types and interfaces
- `@prompt-registry/infra` for infrastructure (harvesters, search, storage)
- `@prompt-registry/app` for application layer
- `@prompt-registry/cli` for CLI tool

The `lib/` directory is maintained for backward compatibility but will be removed in a future release.

## Overview (Deprecated)

Extract the scaffold scripts from `templates/scaffolds/github/scripts/` into a standalone npm package published to GitHub Packages. This eliminates duplication across collection repositories and enables centralized maintenance.

## Problem Statement

Currently, scaffold scripts are copied into each collection repository created from the scaffold. This causes:
1. **Duplication**: Same code exists in multiple repositories
2. **Maintenance burden**: Bug fixes and improvements must be manually applied to each repository
3. **Version drift**: Different repositories may have different versions of the scripts
4. **No upgrade path**: No mechanism to propagate fixes to existing repositories

## Solution

Create an npm subproject at `lib/` that:
1. Contains all reusable collection scripts
2. Has its own CI/CD pipeline publishing to GitHub Packages
3. Is consumed by scaffolded repositories via npm dependency
4. Is also used by the VS Code extension's validate commands for consistency

## Package Structure

```
lib/
├── package.json              # @prompt-registry/collection-scripts
├── tsconfig.json             # TypeScript configuration
├── src/
│   ├── index.ts              # Main exports
│   ├── validate.ts           # Collection validation (from lib/validate.js)
│   ├── collections.ts        # Collection utilities (from lib/collections.js)
│   ├── bundle-id.ts          # Bundle ID generation (from lib/bundle-id.js)
│   └── cli.ts                # CLI argument parsing (from lib/cli.js)
├── bin/
│   ├── validate-collections.js    # CLI entry point
│   ├── build-collection-bundle.js # CLI entry point
│   ├── compute-collection-version.js
│   ├── detect-affected-collections.js
│   ├── generate-manifest.js
│   └── publish-collections.js
└── test/
    └── *.test.ts             # Unit tests
```

## API Design

### Core Modules

#### `validate.ts`
```typescript
export const VALIDATION_RULES: ValidationRules;
export function validateCollectionId(id: string): ValidationResult;
export function validateVersion(version: string): ValidationResult;
export function validateItemKind(kind: string): ValidationResult;
export function normalizeRepoRelativePath(path: string): string;
export function isSafeRepoRelativePath(path: string): boolean;
export function validateCollectionFile(repoRoot: string, collectionFile: string): FileValidationResult;
export function validateCollectionObject(collection: object, sourceLabel: string): ObjectValidationResult;
export function validateAllCollections(repoRoot: string, collectionFiles: string[]): AllCollectionsResult;
export function generateMarkdown(result: AllCollectionsResult, totalFiles: number): string;
```

#### `collections.ts`
```typescript
export function listCollectionFiles(repoRoot: string): string[];
export function readCollection(repoRoot: string, collectionFile: string): Collection;
export function resolveCollectionItemPaths(repoRoot: string, collection: Collection): string[];
```

#### `bundle-id.ts`
```typescript
export function generateBundleId(repoSlug: string, collectionId: string, version: string): string;
```

#### `cli.ts`
```typescript
export function parseSingleArg(argv: string[], flag: string): string | undefined;
export function parseMultiArg(argv: string[], flag: string): string[];
export function hasFlag(argv: string[], flag: string): boolean;
export function getPositionalArg(argv: string[], index: number): string | undefined;
```

## CI/CD Workflow

### New Workflow: `lib-collection-scripts-ci.yml`

Triggers:
- Push to `main` with changes in `lib/**`
- Pull requests with changes in `lib/**`

Jobs:
1. **lint-and-test**: Run ESLint and unit tests
2. **build**: Compile TypeScript
3. **publish** (on main only): Publish to GitHub Packages with auto-versioning

### Modified Workflow: `vscode-extension-secure-ci.yml`

Add path exclusions:
```yaml
paths-ignore:
  - "lib/**"
```

## Scaffold Template Changes

### Before (current)
```
templates/scaffolds/github/
├── scripts/
│   ├── lib/
│   │   ├── validate.js
│   │   ├── collections.js
│   │   ├── bundle-id.js
│   │   └── cli.js
│   ├── validate-collections.js
│   ├── build-collection-bundle.js
│   └── ... (other scripts)
└── package.json.template
```

### After (proposed)
```
templates/scaffolds/github/
├── scripts/
│   └── README.md  # Points to npm package
└── package.json.template  # Includes @prompt-registry/collection-scripts dependency
```

The scaffold's `package.json.template` will include:
```json
{
  "devDependencies": {
    "@prompt-registry/collection-scripts": "^1.0.0"
  },
  "scripts": {
    "validate": "validate-collections",
    "build": "build-collection-bundle",
    "publish": "publish-collections"
  }
}
```

## VS Code Extension Integration

### `ValidateApmCommand.ts` Changes

The extension's validate command will import validation logic from the shared library:
```typescript
import { validateCollectionFile, validateAllCollections } from '@prompt-registry/collection-scripts';
```

This ensures validation behavior is identical between:
- CLI scripts in collection repositories
- VS Code extension's validate command

## Migration Path

### For New Repositories
Scaffolded repositories will automatically use the npm package.

### For Existing Repositories
1. Remove `scripts/lib/` directory
2. Update `package.json` to add dependency
3. Update npm scripts to use CLI commands

## Testing Strategy

### Unit Tests (in `lib/test/`)
- Port existing tests from `test/scripts/collections-lib.test.ts`
- Add tests for CLI entry points
- Ensure 100% coverage of validation logic

### Integration Tests
- Test that scaffolded repositories can install and use the package
- Test that VS Code extension correctly uses the shared library

## Acceptance Criteria

1. [ ] `lib/` npm package builds and passes all tests
2. [ ] CI workflow publishes to GitHub Packages on merge to main
3. [ ] Extension CI ignores changes to `lib/`
4. [ ] Scaffold templates use npm package instead of copied scripts
5. [ ] VS Code validate command uses shared library
6. [ ] Existing tests in `test/scripts/` continue to pass
7. [ ] Documentation updated in `docs/author-guide/`

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Breaking existing collection repos | Maintain backward compatibility; document migration |
| GitHub Packages access issues | Provide fallback instructions for private repos |
| Version conflicts | Use semver and clear changelog |

## Implementation Order

1. Create `lib/` package structure with TypeScript
2. Port JavaScript files to TypeScript
3. Create CI workflow for lib package
4. Update extension CI to ignore lib changes
5. Update scaffold templates
6. Update VS Code validate command
7. Update documentation
