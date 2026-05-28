# Collection Scripts Library

The Prompt Registry provides a shared npm package `@prompt-registry/collection-scripts` that contains all the scripts needed for building, validating, and publishing Copilot prompt collections.

## Installation

### Quick Setup

The `@prompt-registry/collection-scripts` package is now available on npmjs.com:

```bash
# Install the package
npm install @prompt-registry/collection-scripts
```

### GitHub Actions

In GitHub Actions, no special configuration is needed since the package is on npmjs:

```yaml
- name: Install dependencies
  run: npm ci
```

## Usage in Collection Repositories

### NPM Scripts

The scaffolded repositories automatically include the necessary npm scripts:

```json
{
  "scripts": {
    "validate": "validate-collections",
    "validate:verbose": "validate-collections --verbose",
    "build-collection-bundle": "build-collection-bundle",
    "publish-collections": "publish-collections",
    "list-collections": "list-collections",
    "compute-collection-version": "compute-collection-version",
    "skill:create": "create-skill",
    "build": "build-collection-bundle",
    "publish": "publish-collections"
  }
}
```

### Common Tasks

```bash
# Validate all collections
npm run validate

# Build a specific collection bundle
npm run build-collection-bundle -- --collection-file collections/my.collection.yml --version 1.0.0

# Publish affected collections (used in CI)
npm run publish-collections

# Create a new skill
npm run skill:create my-new-skill
```

## GitHub Actions Integration

The scaffolded GitHub Actions automatically use the npm package:

```yaml
- name: Validate collections
  run: npm run validate -- --output-markdown validation-comment.md

- name: Publish affected collections
  run: npx publish-collections
```

## VS Code Extension Integration

The Prompt Registry VS Code extension uses the same validation logic as the CLI tools, ensuring consistent behavior between the extension and command-line tools.

## Available Commands

| Command | Description |
|---------|-------------|
| `validate-collections` | Validate collection YAML files |
| `validate-skills` | Validate skill folders against Agent Skills spec |
| `build-collection-bundle` | Build a collection bundle ZIP |
| `compute-collection-version` | Compute next version from git tags |
| `detect-affected-collections` | Detect collections affected by file changes |
| `generate-manifest` | Generate deployment manifest |
| `publish-collections` | Build and publish affected collections |
| `list-collections` | List all collections in repo |
| `create-skill` | Create a new skill directory (interactive wizard) |

## Programmatic API

You can also use the library directly in your code:

```typescript
import {
  validateCollectionFile,
  validateAllCollections,
  listCollectionFiles,
  generateBundleId
} from '@prompt-registry/collection-scripts';

// Validate a single collection
const result = validateCollectionFile(repoRoot, 'collections/my.collection.yml');

// List all collections
const collections = listCollectionFiles(repoRoot);

// Generate a bundle ID
const bundleId = generateBundleId('owner/repo', 'my-collection', '1.0.0');
```

## Migration from Local Scripts

If you have an existing repository with local scripts:

1. Remove the `scripts/lib/` directory
2. Update `package.json` to include the npm dependency
3. Update npm scripts to use CLI commands directly
4. The GitHub Actions will automatically use the npm package via `npx`

## Benefits

- **Single Source of Truth**: All repositories use the same validation logic
- **Automatic Updates**: Bug fixes and improvements are available via npm updates
- **Consistency**: Identical behavior between CLI, CI/CD, and VS Code extension
- **Maintenance**: Centralized code reduces duplication and maintenance burden
