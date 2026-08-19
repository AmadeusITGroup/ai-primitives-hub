# Configuration

## VS Code Extension Settings

Access: `File → Preferences → Settings → Extensions → AI Primitives Hub`

| Setting | Description | Default |
|---------|-------------|---------|
| `promptregistry.installationScope` | Installation scope (`user`, `workspace`, `project`) | `user` |
| `promptregistry.enableLogging` | Enable debug logging | `true` |
| `promptregistry.autoCheckUpdates` | Auto-check updates on activation | `true` |
| `promptregistry.updateCheck.enabled` | Enable update checks | `true` |
| `promptregistry.updateCheck.frequency` | `daily`, `weekly`, `manual` | `daily` |
| `promptregistry.updateCheck.autoUpdate` | Auto-install updates | `false` |
| `promptregistry.updateCheck.cacheTTL` | Cache TTL (ms) | `300000` |

## CLI Configuration

The CLI reads configuration from `ai-primitives-hub.yml` in your project root. This file defines targets, sources, and hub settings:

```yaml
# ai-primitives-hub.yml
targets:
  - name: my-vscode
    type: vscode
    scope: user
  - name: my-kiro
    type: kiro
    scope: repository
    path: /path/to/project
  - name: my-claude
    type: claude-code
    scope: user
```

### Target Types

| Type | Description | Scope Options |
|------|-------------|---------------|
| `vscode` | VS Code (user or repository) | `user`, `repository` |
| `vscode-insiders` | VS Code Insiders | `user`, `repository` |
| `copilot-cli` | GitHub Copilot CLI (user-only) | `user` |
| `kiro` | Kiro IDE / Kiro CLI | `user`, `repository` |
| `windsurf` | Windsurf Editor (Codeium) | `user`, `repository` |
| `claude-code` | Anthropic Claude Code | `user`, `repository` |

Manage targets with:
```bash
ai-primitives-hub target add <name> --type <type> [--scope <scope>] [--path <path>]
ai-primitives-hub target list
ai-primitives-hub target remove <name>
ai-primitives-hub target types    # list all supported target types
```

## Telemetry

Telemetry respects VS Code's built-in telemetry setting. To enable or disable it:

1. Open **File → Preferences → Settings** (or `Cmd+,` / `Ctrl+,`)
2. Search for `telemetry.telemetryLevel`
3. Choose a level:

| Level | Effect on AI Primitives Hub |
|-------|--------------------------|
| `all` | Telemetry events are collected |
| `error` | Only error events are collected |
| `crash` | Telemetry is disabled |
| `off` | Telemetry is disabled |

You can also set it in `settings.json`:

```json
{
  "telemetry.telemetryLevel": "all"
}
```

Enabling telemetry helps us understand how the extension is used so we can focus on the features that matter most. For GitHub-based bundle installs, the telemetry payload uses the base bundle identity in the bundleId field and keeps the version in the version field so analytics can aggregate installs correctly.

## Export/Import Settings

- **Export**: Registry Explorer toolbar → Export button
- **Import**: Registry Explorer toolbar → Import button (merge or replace)

## Installation Paths

File locations vary by target IDE:

| Target | User Scope Path | Repository Scope Path |
|--------|----------------|----------------------|
| **VS Code** (macOS) | `~/Library/Application Support/Code/User/prompts` | `.github/prompts/` |
| **VS Code** (Linux) | `~/.config/Code/User/prompts` | `.github/prompts/` |
| **VS Code** (Windows) | `%APPDATA%/Code/User/prompts` | `.github/prompts/` |
| **VS Code Insiders** | Same structure with `Code - Insiders` | `.github/prompts/` |
| **Kiro / Kiro CLI** | `~/.kiro/` | `.kiro/` |
| **Windsurf / Devin** | `~/.codeium/windsurf/` | `.windsurf/` |
| **Claude Code** | `~/.claude/` | `.claude/` |
| **Copilot CLI** | `~/.copilot/` | `.github/` |

> **Note:** The extension auto-detects your host editor and uses the correct paths. The CLI uses the target configuration in `ai-primitives-hub.yml`.

## See Also

- [Settings Reference](../reference/settings.md) — Complete settings list
- [Troubleshooting](./troubleshooting.md) — Common issues
