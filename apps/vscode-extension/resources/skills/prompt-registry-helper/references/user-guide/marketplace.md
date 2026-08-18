# Marketplace

Open via Activity Bar icon or `Ctrl+Shift+P` → "AI Primitives Hub: Focus On Marketplace View"

## Browsing

- **Search** — Filter by name, description, tags, and indexed primitive content
- **Filter by Type** — Prompts, Instructions, Chat Modes, Agents
- **Filter by Tags** — Multiple tags use OR logic
- **Filter by Source** — Show bundles from specific repositories
- **Installed Only** — Show only installed bundles

The marketplace builds the primitive index on demand when you search. To start a
rebuild explicitly, open the Command Palette and run **AI Primitives Hub:
Rebuild Primitive Index**. The index is also rebuilt automatically after source
syncs and bundle installation changes. `awesome-copilot` and
`awesome-copilot-plugin` sources are intentionally excluded from primitive
indexing; they remain available to the regular bundle catalog.

## Installing

1. Click bundle tile to view details
2. Click **Install** (or **Update** if newer version exists)
3. Badge shows "✓ Installed" with version

## Updates

```bash
# Check for updates
Right-click bundle → "Check for Updates"

# Update all
Ctrl+Shift+P → "AI Primitives Hub: Update All Bundles"
```

Auto-update settings in `File → Preferences → Settings → AI Primitives Hub`:

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
