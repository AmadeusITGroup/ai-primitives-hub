# Release Process

## Versioning

[Semantic Versioning](https://semver.org/):
- **MAJOR** — Breaking changes
- **MINOR** — New features (backward compatible)
- **PATCH** — Bug fixes (backward compatible)

## Version Update

Use the automated version scripts:

```bash
npm run version:bump:patch   # 0.0.2 → 0.0.3
npm run version:bump:minor   # 0.0.2 → 0.1.0
npm run version:bump:major   # 0.0.2 → 1.0.0
```

These scripts update `package.json` and version references in `README.md`.

## Workspace Package Releases

The packages under `packages/` publish to npm as `@ai-primitives-hub/core`,
`@ai-primitives-hub/infra`, `@ai-primitives-hub/app`, and
`@ai-primitives-hub/cli`. Use the **Release @ai-primitives-hub packages to
npmjs** workflow in GitHub Actions to release them. The workflow uses a
reviewable, two-stage process rather than mutating `main` directly.

### 1. Prepare a release pull request

Run the workflow from the `main` branch and choose:

| Input | Values | Purpose |
| --- | --- | --- |
| `release_type` | `patch`, `minor`, `major`, `prerelease` | Semantic version bump to apply. |
| `preid` | For example, `alpha` | Prerelease identifier; used only for `prerelease` bumps. |
| `packages` | `all`, `core`, `infra`, `app`, `cli` | Packages to version, validate, build, and publish. |
| `npm_tag` | `latest`, `next`, `alpha`, `beta` | npm distribution tag. |
| `dry_run` | Boolean | Validate and build without pushing a branch or opening a pull request. |
| `skip_checks` | Boolean | Skip lint and tests; the release build still runs. |

The prepare job:

1. Installs Node.js 24 and the pnpm version declared by the root
   `package.json` `packageManager` field.
2. Bumps the selected package manifests with `pnpm version` and updates
   `pnpm-lock.yaml`.
3. Builds the selected packages and their workspace dependencies once so all
   package declarations are available to type-aware linting, then runs lint and
   tests unless `skip_checks` is enabled.
4. Uploads the resulting `dist` directories and a release manifest as a
   workflow artifact.
5. Creates and pushes a branch named
   `release/packages/<packages>/<npm-tag>/<workflow-run-id>`, then opens a pull
   request into `main`.

The build must precede linting on a clean checkout: package metadata points to
generated declarations under ignored `dist` directories. A previous local build
can hide this requirement by leaving those declarations on disk.

Review the package versions and lockfile changes in the pull request. The
generated release branch and pull request make the version change auditable and
allow the normal repository checks to run before publication.

### 2. Merge and publish

Merging the release pull request into `main` triggers the publication stage. It
downloads the build artifact from the originating prepare run and verifies all
of the following before making changes:

- The branch name, package selection, npm tag, and originating workflow run
  agree with the manifest.
- The artifact was built from the exact pull request head commit.
- The merged package names and versions match the validated artifact.
- Each expected build output is present.

After verification, the workflow copies the validated `dist` output into the
merged checkout, installs dependencies with lifecycle scripts disabled, creates
lightweight package tags, and publishes without rebuilding:

| Package | Git tag |
| --- | --- |
| `@ai-primitives-hub/core` | `packages/core-v<version>` |
| `@ai-primitives-hub/infra` | `packages/infra-v<version>` |
| `@ai-primitives-hub/app` | `packages/app-v<version>` |
| `@ai-primitives-hub/cli` | `packages/cli-v<version>` |

Publication uses the selected npm distribution tag and npm trusted publishing
with provenance. Configure a GitHub Actions trusted publisher separately for
each package on npmjs.com, using the repository owner and name that match the
package metadata, the workflow filename `packages-release.yml`, and the
`npmjs` environment when restricting the publisher to this workflow. Allow the
`npm publish` action.

The publish job intentionally does not configure `registry-url` or a
long-lived `NODE_AUTH_TOKEN`; npm OIDC authentication supplies the temporary
publish credential. A pull request that is closed without being merged does not
publish anything.

### Retries and failure handling

The publication stage is safe to retry after a partial failure:

- Existing package tags are left unchanged when they already point to the
  merged release commit.
- Versions already present on npm are skipped when their expected release tag
  exists.
- If an npm version exists without the expected tag, or a tag points to a
  different commit, the workflow fails closed for manual investigation.

Dispatching a new prepare run creates a new branch and artifact. This is the
right recovery path when a release pull request was closed without merging or
when the source branch needs to be regenerated.

## VS Code Extension Release Checklist

1. **Update version**:
   ```bash
   npm run version:bump:patch  # or minor/major
   ```

2. **Run tests**:
   ```bash
   npm run lint
   npm run compile
   npm test
   ```

3. **Commit and push**:
   ```bash
   git add -A
   git commit -m "chore: bump version to X.Y.Z"
   git push
   ```

4. **Create GitHub Release** (triggers publishing):
   
   **Option A: GitHub CLI (recommended)**:
   ```bash
   gh release create v0.0.3 *.vsix --title "Release v0.0.3" --generate-notes
   ```
   
   **Option B: GitHub Web UI**:
   - Go to GitHub → Releases → "Create a new release"
   - Create tag `vX.Y.Z` (e.g., `v0.0.3`)
   - Upload the `.vsix` file
   - Add release notes
   - Publish release
   
   **Important:** Publishing the release triggers the CI workflow to publish to VS Code Marketplace and Open VSX Registry.

   Required publishing secrets:
   - `VSCODE_MARKETPLACE_TOKEN` for VS Code Marketplace
   - `OPEN_VSX_TOKEN` for Open VSX Registry

## Pre-release Testing

Test locally before releasing:

```bash
npm run package:production   # Build optimized package
code --install-extension prompt-registry-*.vsix
```

Test on: macOS, Linux, Windows, VS Code Stable + Insiders.

## PR Process

1. Update from main: `git fetch upstream && git rebase upstream/main`
2. Run checks: `npm run lint && npm run compile && npm test`
3. Submit PR with description
4. Address review feedback
5. Merge after approval

## See Also

- [Development Setup](./development-setup.md)
- [Coding Standards](./coding-standards.md)
