# Marketplace

Open via Activity Bar icon or `Ctrl+Shift+P` → "Prompt Registry: Focus On Marketplace View"

## Browsing

- **Search** — Filter by name, description, tags
- **Filter by Type** — Prompts, Instructions, Chat Modes, Agents
- **Filter by Tags** — Multiple tags use OR logic
- **Filter by Source** — Show bundles from specific repositories
- **Installed Only** — Show only installed bundles

## Installing

1. Click bundle tile to view details
2. Click **Install** (or **Update** if newer version exists)
3. Badge shows "✓ Installed" with version

## Updates

```bash
# Check for updates
Right-click bundle → "Check for Updates"

# Update all
Ctrl+Shift+P → "Prompt Registry: Update All Bundles"
```

Auto-update settings in `File → Preferences → Settings → Prompt Registry`:

| Setting | Default |
|---------|---------|
| `updateCheck.enabled` | `true` |
| `updateCheck.frequency` | `daily` |
| `updateCheck.autoUpdate` | `false` |

## Uninstalling

Marketplace → Installed checkbox → Click bundle → Uninstall

## See Also

- [Sources](./sources.md) — Add prompt sources
- [Configuration](./configuration.md) — Extension settings
