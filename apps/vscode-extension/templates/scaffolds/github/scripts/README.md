# Scripts

This directory is reserved for project-specific scripts that are not part of the shared `@prompt-registry/collection-scripts` package.

## Shared Scripts (via npm package)

Most collection scripts are provided by the `@prompt-registry/collection-scripts` npm package. These are available as CLI commands after running `npm install`:

| Command | Description |
|---------|-------------|
| `validate-collections` | Validate collection YAML files |
| `validate-skills` | Validate skill folders against the Agent Skills specification |
| `build-collection-bundle` | Build a collection bundle ZIP |
| `compute-collection-version` | Compute next version from git tags |
| `detect-affected-collections` | Detect collections affected by file changes |
| `generate-manifest` | Generate deployment manifest |
| `publish-collections` | Build and publish affected collections |
| `list-collections` | List all collections in repo |
| `create-skill` | Create a new skill directory structure (interactive wizard) |

## Usage

```bash
# Validate collections
npm run validate

# Validate skills
npm run skill:validate

# Create a new skill (interactive)
npm run skill:create

# Create a skill non-interactively
npx create-skill my-skill --description "My skill description"
```

## Migration from Local Scripts

If you previously had local scripts in this directory, they have been replaced by the npm package. To migrate:

1. Remove old script files (keep only this README)
2. Run `npm install` to get the shared package
3. Use the npm scripts defined in `package.json`
