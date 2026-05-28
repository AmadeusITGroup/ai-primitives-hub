# Settings Reference

This document describes all configuration settings available for the Prompt Registry extension.

## General Settings

### `promptregistry.autoCheckUpdates`

- **Type:** `boolean`
- **Default:** `true`
- **Description:** Automatically check for updates on extension activation.

### `promptregistry.enableLogging`

- **Type:** `boolean`
- **Default:** `true`
- **Description:** Enable detailed logging for debugging purposes. When enabled, logs are written to the Output panel under "Prompt Registry".

### `promptregistry.installationScope`

- **Type:** `string`
- **Default:** `"user"`
- **Options:** `"user"`, `"workspace"`, `"project"`
- **Description:** Default installation scope for Prompt Registry components.
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

## See Also

- [Command Reference](./commands.md) — All available commands
- [Configuration Guide](../user-guide/configuration.md) — User guide for configuration
- [Troubleshooting](../user-guide/troubleshooting.md) — Common issues and solutions
