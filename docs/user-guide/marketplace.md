# Marketplace

Open it from the Activity Bar, or open the Command Palette (`Ctrl+Shift+P` on
Windows/Linux or `Cmd+Shift+P` on macOS) and run
**AI Primitives Hub: Focus On Marketplace View**.

## CLI

```bash
# Discover available bundles
ai-primitives-hub discover

# Search by keyword
ai-primitives-hub search <query>

# Install a bundle
ai-primitives-hub install <bundle-id> [--target <target-name>]

# Update all bundles
ai-primitives-hub update --all

# Uninstall a bundle
ai-primitives-hub uninstall <bundle-id> [--target <target-name>]
```

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

### Via Extension
1. Click bundle tile to view details
2. Click **Install** (or **Update** if newer version exists)
3. Badge shows "✓ Installed" with version

### Via CLI
```bash
ai-primitives-hub install <bundle-id> --target my-kiro
```

## Updates

- **Check for updates:** Right-click a bundle and select **Check for Updates**.
- **Update all:** Open the Command Palette (`Ctrl+Shift+P` on Windows/Linux or
  `Cmd+Shift+P` on macOS) and run **AI Primitives Hub: Update All Bundles**.

### Via CLI

```bash
# Check for updates
ai-primitives-hub update --dry-run

# Apply updates
ai-primitives-hub update --all
```

Auto-update settings in `File → Preferences → Settings → AI Primitives Hub`:

| Setting | Default |
|---------|---------|
| `updateCheck.enabled` | `true` |
| `updateCheck.frequency` | `daily` |
| `updateCheck.autoUpdate` | `false` |

## Uninstalling

### Via Extension
Marketplace → Installed checkbox → Click bundle → Uninstall

### Via CLI
```bash
ai-primitives-hub uninstall <bundle-id> --target my-kiro
```

## See Also

- [Sources](./sources.md) — Add prompt sources
- [Configuration](./configuration.md) — Extension settings
