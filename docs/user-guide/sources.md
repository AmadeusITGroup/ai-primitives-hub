# Managing Sources

Sources are repositories hosting prompt bundles.

## Automatic Source Setup

On first launch, AI Primitives Hub automatically adds the **Awesome Copilot** source (`github/awesome-copilot`). This gives you immediate access to community-curated collections without manual configuration.

If you select a hub during first-run setup, all sources defined in that hub are also automatically synced.

## Source Types

| Type | Use Case | Status |
|------|----------|--------|
| `awesome-copilot` | Community collections (GitHub-hosted) | Active |
| `local-awesome-copilot` | Local collection development/testing | Active |
| `azure-devops` | Community collections (Azure DevOps hosted) | Active |
| `github` | GitHub repository releases | Active ( Recommended ) |
| `local` | File system directories | Active |
| `apm` | APM package repositories | Active |
| `local-apm` | Local APM packages | Active |
| `skills` | GitHub repository with skills | Active |
| `local-skills` | Local filesystem skills directory | Active |
| `artifactory` | Static bundle index and ZIP archives in a generic JFrog Artifactory repository | Active |

### Artifactory sources

An Artifactory source uses a credential-free HTTPS repository root and a static `index-v1.json` file by default. For local development only, `http://localhost`, `http://127.0.0.1`, and `http://[::1]` are accepted with a warning; non-loopback HTTP remains rejected. The index references each bundle's manifest and ZIP archive with a relative path, size, and lowercase SHA-256 digest. Custom index paths can be configured with `indexFile`.

Keep Artifactory token values out of source URLs, hub configurations, index files, and lockfiles. For CLI use, set a credential reference to the environment variable that holds the token. In VS Code, importing an Artifactory hub asks for a credential label, while adding a source directly asks for the token. The extension stores each token securely and uses it for private-source indexing and revision checks. Authentication failures are reported and do not switch to GitHub. Artifactory hubs and sources do not require GitHub sign-in. Choose public access or provide an Artifactory Bearer token for private access.

The CLI records Artifactory installations under the catalog bundle ID, which may differ from the ZIP manifest ID. Install and update validate the manifest version against the resolved catalog version before writing. Lockfile replay resolves that catalog ID at the exact locked version and verifies the archive checksum using only Artifactory credentials. Older lockfiles written under the short manifest ID must be recreated by reinstalling the catalog ID; the CLI does not guess aliases or silently migrate entries. Keep the referenced catalog generation available for replay; a directly configured mutable index must retain its locked versions. Version mismatches are rejected before writing that bundle's files or lockfile entry. Failed updates are reported with a nonzero exit code rather than as successful upgrades.

Catalog synchronization, metadata requests, validation, and bundle resolution revalidate the Artifactory index on each operation, using its ETag when available. A `304` reuses the last validated index; a changed index is validated before replacing it. Refresh failures are reported rather than silently treated as a fresh catalog. Concurrent refreshes share one request. Archive and README downloads use the validated catalog snapshot and do not refresh the index again.

Artifactory index and bundle downloads follow at most 10 redirect hops within the configured source root. Each destination is checked before the next request is sent. Cross-origin redirects, redirects outside the source path, and ambiguous encoded paths are rejected without forwarding the token or contacting the destination.

Artifactory tokens are created in the Artifactory Administration UI (user profile/User Management) or through the Access token API supported by your Artifactory release. Use an access token with repository read permission for consumption. The token is an opaque, release-dependent string: copy the complete value returned by Artifactory, without adding `Bearer `; AI Primitives Hub adds that prefix to the HTTP `Authorization` header. The credential reference is not the token. In VS Code it does not need to exist as an environment variable, and you do not need to restart VS Code after entering the token.

## Adding a Source

Open the Command Palette (`Ctrl+Shift+P` on Windows/Linux or `Cmd+Shift+P` on
macOS) and run **AI Primitives Hub: Add Source**. Choose **Artifactory**, enter a name, the source root and index file, then choose **Public** for anonymous access or **Private** for Bearer authentication. Private access requires the complete Artifactory token in the password-protected prompt, without a `Bearer ` prefix. Enter the source priority to continue.

When you add an Artifactory source directly in VS Code, enter the token in the password-protected prompt. The extension validates the token before saving it for that source. If you cancel or validation fails, any saved token remains unchanged. The token does not appear in source settings.

For private GitHub sources, the extension uses the saved token to index content and check repository revisions. A source token takes precedence over the deprecated global GitHub token. The global token is used only for GitHub-backed sources, never for Artifactory or local sources.

CLI users can add the same source without storing a token in configuration:

```bash
export ARTIFACTORY_TOKEN='your-token'
ai-primitives-hub source add \
  --type artifactory \
  --url https://artifactory.example.com/artifactory/prompt-registry \
  --auth bearer \
  --credential-ref ARTIFACTORY_TOKEN
```

Use `--index-file <relative-path>` for an index other than `index-v1.json`. The credential reference is only a name; the token value is read from the environment when the CLI accesses the source.

## Managing Sources

In Registry Explorer:
- **Sync** — Right-click → Sync Source
- **Edit** — Right-click → Edit Source
- **Toggle** — Right-click → Toggle Enabled/Disabled
- **Remove** — Right-click → Remove Source
- **Open Repository** — Right-click → Open Repository

Command Palette:
- **Sync All Sources** — Open the Command Palette (`Ctrl+Shift+P` on
  Windows/Linux or `Cmd+Shift+P` on macOS) and run
  **AI Primitives Hub: Sync All Sources**

## Skill Update Detection

- **Remote skills (`anthropic/skills`)**: each skill version is derived from a content hash. If any file in the skill directory (including `assets/`, `references/`, etc.) changes, the Marketplace shows **Update** after you sync the source.
- **Local skills (`local-skills`)**: installations are symlinked to your filesystem. Running **Sync Source** updates the recorded version automatically—no manual update button—so the UI reflects the latest hash without touching the symlink.

> Tip: if a skill doesnt show the expected update, run **Sync Source** and check the logs for hash calculation warnings.

## Private Repositories

Authentication tries in order:
1. **VS Code GitHub Auth** — Check bottom-left for GitHub avatar
2. **GitHub CLI** — Run `gh auth login`
3. **Explicit Token** — Add when editing source (needs `repo` scope)

To verify access, open the Command Palette (`Ctrl+Shift+P` on Windows/Linux or
`Cmd+Shift+P` on macOS) and run
**AI Primitives Hub: Validate Repository Access**.

## See Also

- [Profiles and Hubs](./profiles-and-hubs.md) — Organize bundles
- [Troubleshooting](./troubleshooting.md) — Authentication issues
