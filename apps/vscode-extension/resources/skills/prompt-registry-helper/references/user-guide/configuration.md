# Configuration

Access: `File → Preferences → Settings → Extensions → Prompt Registry`

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `promptregistry.installationScope` | Installation scope (`user`, `workspace`, `project`) | `user` |
| `promptregistry.enableLogging` | Enable debug logging | `true` |
| `promptregistry.autoCheckUpdates` | Auto-check updates on activation | `true` |
| `promptregistry.updateCheck.enabled` | Enable update checks | `true` |
| `promptregistry.updateCheck.frequency` | `daily`, `weekly`, `manual` | `daily` |
| `promptregistry.updateCheck.autoUpdate` | Auto-install updates | `false` |
| `promptregistry.updateCheck.cacheTTL` | Cache TTL (ms) | `300000` |

## Telemetry

Telemetry respects VS Code's built-in telemetry setting. To enable or disable it:

1. Open **File → Preferences → Settings** (or `Cmd+,` / `Ctrl+,`)
2. Search for `telemetry.telemetryLevel`
3. Choose a level:

| Level | Effect on Prompt Registry |
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

Enabling telemetry helps us understand how the extension is used so we can focus on the features that matter most.

## Export/Import Settings

- **Export**: Registry Explorer toolbar → Export button
- **Import**: Registry Explorer toolbar → Import button (merge or replace)

## Installation Paths

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/Code/User/prompts` |
| Linux | `~/.config/Code/User/prompts` |
| Windows | `%APPDATA%/Code/User/prompts` |

## See Also

- [Settings Reference](../reference/settings.md) — Complete settings list
- [Troubleshooting](./troubleshooting.md) — Common issues
