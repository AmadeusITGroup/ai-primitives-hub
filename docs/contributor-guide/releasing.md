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

## Release Checklist

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
