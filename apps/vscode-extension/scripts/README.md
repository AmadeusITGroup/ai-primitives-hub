# Project Scripts

This directory contains utility scripts for managing the Prompt Registry project.

## 📋 Table of Contents

- [Test Scripts](#test-scripts)
- [Version Management](#version-management)
- [Package Helpers](#package-helpers)

---

## Test Scripts

### `run-single-test.js`

Helper script to run a single test file with automatic TypeScript to JavaScript path conversion.

#### Features

- ✅ Accepts TypeScript file paths (`.ts`) directly
- ✅ Automatically converts to compiled JavaScript paths
- ✅ Smart compilation: Only recompiles if needed
- ✅ Skip compilation with `--no-compile` flag for faster execution
- ✅ Works with both unit and integration tests

#### Usage

**Run a single test (auto-compiles if needed):**
```bash
npm run test:one -- test/path/to/file.test.ts
```

**Run without recompiling (faster if tests are already compiled):**
```bash
npm run test:one -- test/path/to/file.test.ts --no-compile
```

#### How It Works

1. Takes TypeScript test path: `test/commands/MyTest.test.ts`
2. Converts to compiled path: `test-dist/test/commands/MyTest.test.js`
3. Checks if compilation is needed (file missing or outdated)
4. Compiles if needed (unless `--no-compile` is used)
5. Runs the test with Mocha

#### Examples

```bash
# Unit test
npm run test:one -- test/services/AutoUpdateService.test.ts

# Integration test
npm run test:one -- test/commands/BundleCommands.autoUpdate.integration.test.ts

# Skip compilation for speed (tests already compiled)
npm run test:one -- test/utils/configTypeGuards.test.ts --no-compile

# With error-only logging
LOG_LEVEL=ERROR npm run test:one -- test/services/RegistryManager.test.ts
```

#### Troubleshooting

**Test file not found:**
- Ensure the path starts with `test/` and ends with `.test.ts`
- Check that the file exists in the test directory

**Compilation errors:**
- Run `npm run compile-tests` manually to see detailed errors
- Check TypeScript syntax in your test file

**Test fails to run:**
- Verify the compiled file exists in `test-dist/test/`
- Try running with full compilation: remove `--no-compile` flag

---

## Version Management

### `update-version.sh`

Automatically synchronizes version references across the project to match `package.json`.

#### Features

- ✅ Updates `package.json` version
- ✅ Updates README.md version badge
- ✅ Updates version references in documentation
- ✅ Updates VSIX filename references
- ✅ Creates automatic backups before changes
- ✅ Interactive confirmation for version changes
- ✅ Colorized output with clear status messages
- ✅ Validates semantic version format (X.Y.Z)

#### Usage

**Sync documentation with current package.json version:**
```bash
./scripts/update-version.sh
```

**Update to a specific version:**
```bash
./scripts/update-version.sh 2.1.0
```

**Using npm scripts (recommended):**
```bash
# Bump patch version (0.0.1 → 0.0.2)
npm run version:bump:patch

# Bump minor version (0.0.1 → 0.1.0)
npm run version:bump:minor

# Bump major version (0.0.1 → 1.0.0)
npm run version:bump:major

# Just sync docs without bumping
npm run version:update
```

#### What Gets Updated

The script updates version references in these files:

1. **package.json**
   - `"version": "X.Y.Z"`

2. **README.md**
   - Version badge: `version-X.Y.Z-green.svg`
   - VSIX filename: `prompt-registry-X.Y.Z.vsix`
   - Version headings: `### Current Version (X.Y.Z)`
   - Version ranges: `version (X.Y.Z+)`

3. **CONTRIBUTING.md**
   - Semantic versioning examples: `v1.0.0 → vX.Y.Z`

#### Example Workflow

```bash
# 1. Bump the patch version
npm run version:bump:patch

# 2. Review changes
git diff

# 3. Update CHANGELOG.md manually
# (Add release notes for the new version)

# 4. Run tests
npm test

# 5. Commit the version bump
git add -A
git commit -m "chore: bump version to 0.0.2"

# 6. Create and push tag
git tag -a v0.0.2 -m "Release v0.0.2"
git push origin main
git push origin v0.0.2
```

#### CI/CD Integration

The script can be integrated into your release workflow:

**GitHub Actions example:**
```yaml
name: Release

on:
  workflow_dispatch:
    inputs:
      version:
        description: 'Version to release (e.g., 2.1.0)'
        required: true

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20.x'
      
      - name: Update version
        run: |
          ./scripts/update-version.sh ${{ github.event.inputs.version }}
          
      - name: Create Pull Request
        uses: peter-evans/create-pull-request@v5
        with:
          title: "chore: bump version to ${{ github.event.inputs.version }}"
          branch: "release/v${{ github.event.inputs.version }}"
```

#### Exit Codes

- `0` - Success
- `1` - Error (invalid version, file not found, etc.)

#### Requirements

- **Bash 4.0+**
- **grep** with Perl regex support (`-P` flag)
- **sed**
- **jq** (optional, for more robust JSON parsing)

#### Troubleshooting

**Script fails with "grep: invalid option -- 'P'"**
- Your grep doesn't support Perl regex. Install GNU grep:
  ```bash
  # macOS
  brew install grep
  export PATH="/usr/local/opt/grep/libexec/gnubin:$PATH"
  ```

**Version not updating in all files**
- Check if the old version exists in the files
- Review the regex patterns in the script
- Manually verify the file formats match expectations

**Permission denied**
- Make the script executable:
  ```bash
  chmod +x scripts/update-version.sh
  ```

---

## Package Helpers

### `package-helpers.js`

Manages file exclusions for development vs production builds.

#### Usage

```bash
# Show current exclusion status
npm run ignore:status

# Switch to development mode (Copilot-friendly)
npm run ignore:dev

# Switch to production mode (smaller package)
npm run ignore:prod

# Restore original .vscodeignore
npm run ignore:restore
```

---

## Contributing

When adding new scripts:

1. Add proper shebang (`#!/usr/bin/env bash` or `#!/usr/bin/env node`)
2. Make executable: `chmod +x scripts/your-script.sh`
3. Add comprehensive help text (use `--help` flag)
4. Follow existing naming conventions
5. Add error handling and validation
6. Update this README with documentation
7. Add corresponding npm script in package.json

---

## Best Practices

### Script Development

- **Use `set -euo pipefail`** in bash scripts for safety
- **Validate inputs** before making changes
- **Create backups** before modifying files
- **Provide colorized output** for better UX
- **Return proper exit codes** (0 for success, non-zero for errors)
- **Document all options** in script header comments

### Naming Conventions

- Use kebab-case: `update-version.sh`
- Use descriptive names that indicate purpose
- Group related scripts with common prefixes

### Testing Scripts

Before committing:

1. Test with valid inputs
2. Test with invalid inputs
3. Test edge cases (empty files, missing files, etc.)
4. Test on different platforms (Linux, macOS, Windows via Git Bash)
5. Verify npm script integration works

---

## License

Apache License 2.0 - See [LICENSE](../LICENSE.txt) for details.
