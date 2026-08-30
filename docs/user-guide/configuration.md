# Configuration

Access: `File → Preferences → Settings → Extensions → AI Primitives Hub`

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
| `promptregistry.security.scanOnSave` | Scan trusted local Markdown files on save | `true` |
| `promptregistry.security.minimumSeverity` | Minimum diagnostic severity | `INFO` |
| `promptregistry.security.includeLlmControls` | Enable LLM control checks | `false` |
| `promptregistry.security.showInfoControls` | Show informational controls | `true` |
| `promptregistry.security.debounceMs` | Save-scan debounce delay (ms) | `300` |

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

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/Code/User/prompts` |
| Linux | `~/.config/Code/User/prompts` |
| Windows | `%APPDATA%/Code/User/prompts` |

## See Also

- [Settings Reference](../reference/settings.md) — Complete settings list
- [Security Scanning](./security-scanning.md) — Scanner usage and CI configuration
- [Troubleshooting](./troubleshooting.md) — Common issues
