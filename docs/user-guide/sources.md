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

## Adding a Source

Open the Command Palette (`Ctrl+Shift+P` on Windows/Linux or `Cmd+Shift+P` on
macOS) and run **AI Primitives Hub: Add Source**.

### Via CLI
```bash
ai-primitives-hub source add <name> --type <type> [--url <url>] [--path <path>]
```

## Managing Sources

### Via Extension (Registry Explorer)
- **Sync** — Right-click → Sync Source
- **Edit** — Right-click → Edit Source
- **Toggle** — Right-click → Toggle Enabled/Disabled
- **Remove** — Right-click → Remove Source
- **Open Repository** — Right-click → Open Repository

Command Palette:
- **Sync All Sources** — Open the Command Palette (`Ctrl+Shift+P` on
  Windows/Linux or `Cmd+Shift+P` on macOS) and run
  **AI Primitives Hub: Sync All Sources**

### Via CLI
```bash
ai-primitives-hub source list
ai-primitives-hub source sync <name>
ai-primitives-hub source sync --all
ai-primitives-hub source remove <name>
```

## Skill Update Detection

- **Remote skills (`anthropic/skills`)**: each skill version is derived from a content hash. If any file in the skill directory (including `assets/`, `references/`, etc.) changes, the Marketplace shows **Update** after you sync the source.
- **Local skills (`local-skills`)**: installations are symlinked to your filesystem. Running **Sync Source** updates the recorded version automatically—no manual update button—so the UI reflects the latest hash without touching the symlink.

> Tip: if a skill doesnt show the expected update, run **Sync Source** and check the logs for hash calculation warnings.

## Private Repositories

Authentication tries in order:

### Via Extension
1. **VS Code GitHub Auth** — Check bottom-left for GitHub avatar
2. **GitHub CLI** — Run `gh auth login`
3. **Explicit Token** — Add when editing source (needs `repo` scope)

To verify access, open the Command Palette (`Ctrl+Shift+P` on Windows/Linux or
`Cmd+Shift+P` on macOS) and run
**AI Primitives Hub: Validate Repository Access**.

### Via CLI
1. **Environment variable** — Set `GITHUB_TOKEN` or `GH_TOKEN`
2. **GitHub CLI** — Run `gh auth login` (the CLI calls `gh auth token`)
3. **Explicit Token** — Pass `--token` flag or configure in `ai-primitives-hub.yml`

```bash
# Verify access
ai-primitives-hub doctor
```

## See Also

- [Profiles and Hubs](./profiles-and-hubs.md) — Organize bundles
- [Troubleshooting](./troubleshooting.md) — Authentication issues
