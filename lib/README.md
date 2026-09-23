# @prompt-registry/collection-scripts

Shared scripts for building, validating, and publishing Copilot prompt collections.

## Installation

### Option 1: Use with npx (Recommended)
No installation required - run from anywhere:

```bash
npx --package @prompt-registry/collection-scripts validate-collections
```

### Option 2: Install locally
```bash
npm install @prompt-registry/collection-scripts
```

### Option 3: Install globally
```bash
npm install -g @prompt-registry/collection-scripts
```

## Usage

### npx (No Installation Required)

```bash
# Validate collections
npx --package @prompt-registry/collection-scripts validate-collections --verbose

# Create a new skill (interactive)
npx --package @prompt-registry/collection-scripts create-skill

# Create a skill (non-interactive)
npx --package @prompt-registry/collection-scripts create-skill my-skill --description "A helpful skill" --non-interactive

# Validate skills
npx --package @prompt-registry/collection-scripts validate-skills

# Build collection bundle
npx --package @prompt-registry/collection-scripts build-collection-bundle --collection-file collections/my.collection.yml --version 1.0.0

# List collections
npx --package @prompt-registry/collection-scripts list-collections

# Publish affected collections (CI/CD)
npx --package @prompt-registry/collection-scripts publish-collections

# Analyze hub release downloads
npx --package @prompt-registry/collection-scripts hub-release-analyzer https://github.com/owner/repo
npx --package @prompt-registry/collection-scripts hub-release-analyzer ./hub-config.yml --output-dir ./reports
```

### After Installation

If installed locally or globally, you can run commands directly:

```bash
validate-collections --verbose
create-skill my-skill --description "A helpful skill"
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `validate-collections` | Validate collection YAML files |
| `validate-skills` | Validate skill folders following Agent Skills spec |
| `build-collection-bundle` | Build a collection bundle ZIP |
| `compute-collection-version` | Compute next version from git tags |
| `detect-affected-collections` | Detect collections affected by file changes |
| `generate-manifest` | Generate deployment manifest |
| `publish-collections` | Build and publish affected collections |
| `list-collections` | List all collections in repo |
| `create-skill` | Create a new skill directory structure |
| `hub-release-analyzer` | Analyze GitHub release download statistics for hub configs |

## Programmatic API

```typescript
import {
  // Validation
  validateCollectionId,
  validateVersion,
  validateItemKind,
  validateCollectionFile,
  validateAllCollections,
  generateMarkdown,
  VALIDATION_RULES,
  
  // Collections
  listCollectionFiles,
  readCollection,
  resolveCollectionItemPaths,
  
  // Bundle ID
  generateBundleId,
  
  // CLI utilities
  parseSingleArg,
  parseMultiArg,
  hasFlag,
  getPositionalArg,
} from '@prompt-registry/collection-scripts';
```

## Usage in package.json

```json
{
  "scripts": {
    "validate": "validate-collections",
    "build": "build-collection-bundle --collection-file collections/my.collection.yml --version 1.0.0",
    "publish": "publish-collections"
  }
}
```

## Development

This package is a member of the repository's pnpm workspace, so install from
the repository root rather than from `lib/`:

```bash
pnpm install          # from the repository root
pnpm -C lib build
pnpm -C lib test
```

### Releasing

The package is configured to use provenance signing for npm publish. Make sure to set up OIDC authentication if publishing to npm.
The version is taken from the package.json file. Therefore it is important to bump the version before publishing 

```bash
npm version <patch|minor|major>
```

## License

Apache License Version 2.0
