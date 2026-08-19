# Settings Reference

This document describes all configuration settings available for AI Primitives Hub — both the VS Code extension settings and the CLI configuration file.

## VS Code Extension Settings

### `promptregistry.autoCheckUpdates`

- **Type:** `boolean`
- **Default:** `true`
- **Description:** Automatically check for updates on extension activation.

### `promptregistry.enableLogging`

- **Type:** `boolean`
- **Default:** `true`
- **Description:** Enable detailed logging for debugging purposes. When enabled, logs are written to the Output panel under "AI Primitives Hub".

### `promptregistry.installationScope`

- **Type:** `string`
- **Default:** `"user"`
- **Options:** `"user"`, `"workspace"`, `"project"`
- **Description:** Default installation scope for AI Primitives Hub components.
  - `user` — Install bundles for the current user (available across all workspaces)
  - `workspace` — Install bundles for the current workspace only
  - `project` — Install bundles at the project level

> **Note:** Repository-level installation is selected via the installation dialog, not this setting. When installing a bundle, you'll be prompted to choose between Repository (Commit), Repository (Local Only), or User Profile. See [Repository Installation](../user-guide/repository-installation.md) for details.

## GitHub Settings

### `promptregistry.githubToken`

- **Type:** `string`
- **Default:** `""`
- **Description:** GitHub personal access token for private repositories. Generate with `gh auth token` or create a PAT in GitHub settings.

## Update Settings

### `promptregistry.updateCheck.enabled`

- **Type:** `boolean`
- **Default:** `true`
- **Description:** Enable automatic update checks for installed bundles.

### `promptregistry.updateCheck.frequency`

- **Type:** `string`
- **Default:** `"daily"`
- **Options:** `"daily"`, `"weekly"`, `"manual"`
- **Description:** How often to check for bundle updates.
  - `daily` — Check once per day
  - `weekly` — Check once per week
  - `manual` — Only check when manually triggered

### `promptregistry.updateCheck.notificationPreference`

- **Type:** `string`
- **Default:** `"all"`
- **Options:** `"all"`, `"critical"`, `"none"`
- **Description:** Which updates to show notifications for.
  - `all` — Show notifications for all available updates
  - `critical` — Only show notifications for critical updates
  - `none` — Don't show update notifications

### `promptregistry.updateCheck.autoUpdate`

- **Type:** `boolean`
- **Default:** `false`
- **Description:** Automatically install updates in the background. When enabled, bundles with per-bundle auto-update enabled will update automatically.

### `promptregistry.updateCheck.cacheTTL`

- **Type:** `number`
- **Default:** `300000` (5 minutes)
- **Minimum:** `60000` (1 minute)
- **Maximum:** `3600000` (1 hour)
- **Description:** Cache time-to-live for update check results in milliseconds.

## Configuration Examples

### Basic Setup

```json
{
  "promptregistry.enableLogging": true,
  "promptregistry.installationScope": "user"
}
```

### Auto-Update Configuration

```json
{
  "promptregistry.updateCheck.enabled": true,
  "promptregistry.updateCheck.frequency": "daily",
  "promptregistry.updateCheck.autoUpdate": true,
  "promptregistry.updateCheck.notificationPreference": "all"
}
```

### Minimal Notifications

```json
{
  "promptregistry.updateCheck.enabled": true,
  "promptregistry.updateCheck.frequency": "weekly",
  "promptregistry.updateCheck.notificationPreference": "critical"
}
```

## CLI Configuration

The CLI reads configuration from `ai-primitives-hub.yml` in the project root. This file is created by `ai-primitives-hub init` and can be edited manually.

### Structure

```yaml
# ai-primitives-hub.yml
targets:
  - name: my-vscode
    type: vscode           # vscode | vscode-insiders | copilot-cli | kiro | windsurf | claude-code
    scope: user            # user | repository
    # path: /optional/path  # override the default install path
    # allowedKinds:         # restrict which primitive types are installed
    #   - prompts
    #   - agents

sources:
  - name: awesome
    type: awesome-copilot
    enabled: true

hub:
  url: https://raw.githubusercontent.com/org/hub/main/hub.yml
```

### Target Configuration

Each target entry supports:

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique identifier for the target |
| `type` | Yes | One of: `vscode`, `vscode-insiders`, `copilot-cli`, `kiro`, `windsurf`, `claude-code` |
| `scope` | Yes | `user` or `repository` (Copilot CLI is always `user`) |
| `path` | No | Override the default install path |
| `allowedKinds` | No | Restrict which primitive types are installed (e.g., `prompts`, `agents`, `instructions`, `skills`, `hooks`, `plugins`) |

### Per-Target File Layouts

The CLI and extension use built-in layout maps (`default-layouts.json`) to route files to the correct directories per target type. Content transformers automatically adapt frontmatter for each target:

| Target | Transformer | Key Adaptations |
|--------|------------|-----------------|
| `vscode` / `vscode-insiders` | No-op (pass-through) | None |
| `copilot-cli` | No-op (pass-through) | None |
| `kiro` (Kiro IDE / Kiro CLI) | `KiroTransformer` | Ensures `name` field in agent frontmatter |
| `windsurf` (Devin) | `WindsurfTransformer` | Adds `trigger` field to rules frontmatter |
| `claude-code` | `ClaudeCodeTransformer` | Ensures `name` + `description` in agent frontmatter |

### CLI State

CLI state is stored in:

| Scope | Location |
|-------|----------|
| Per-project target state | `.ai-primitives-hub/target-state.json` |
| User-level target state | `$XDG_CONFIG_HOME/ai-primitives-hub/target-state.json` (or `~/.config/ai-primitives-hub/` on Linux/macOS, `%APPDATA%\ai-primitives-hub\` on Windows) |

## See Also

- [Command Reference](./commands.md) — All available commands
- [Configuration Guide](../user-guide/configuration.md) — User guide for configuration
- [Troubleshooting](../user-guide/troubleshooting.md) — Common issues and solutions
