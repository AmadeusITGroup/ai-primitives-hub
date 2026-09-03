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

Do not put credentials in the source URL, hub configuration, index, or lockfile. For private sources, configure Bearer authentication with a source-scoped credential reference. The CLI resolves that reference as an environment-variable name; the VS Code extension stores the token in SecretStorage. Authentication failures are reported and do not fall back to GitHub.

## Adding a Source

Open the Command Palette (`Ctrl+Shift+P` on Windows/Linux or `Cmd+Shift+P` on
macOS) and run **AI Primitives Hub: Add Source**. Choose **Artifactory** to enter the source root, index file, and optional Bearer token; the token is stored in VS Code SecretStorage.

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
