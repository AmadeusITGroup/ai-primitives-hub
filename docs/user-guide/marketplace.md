# Marketplace

Open it from the Activity Bar, or open the Command Palette (`Ctrl+Shift+P` on
Windows/Linux or `Cmd+Shift+P` on macOS) and run
**AI Primitives Hub: Focus On Marketplace View**.

## Browsing

- **Search** — Filter by name, description, tags, and indexed primitive content
- **Filter by Type** — The **Primitives** filter offers Agents, Skills, Prompts,
  MCP Servers, Instructions and Plugins; a bundle matches if it contains any
  selected type
- **Filter by Tags** — Multiple tags use OR logic
- **Filter by Source** — Show bundles from specific repositories
- **Installed Only** — Show only installed bundles

Bundle cards and the bundle details page count what a bundle contains, Agent
Plugins included: a bundle with one plugin and one prompt shows "1 Prompt" and
"1 Plugin". In the details page, items listed under **Included Prompts** carry
their type, such as "(Plugin)" or "(Instruction)". Hover an installed bundle in
the AI Primitives Hub tree view to see what it contains, for example
"Contains: 1 prompt, 1 plugin".

> Screenshot placeholder: a Marketplace card for a bundle with one Agent Plugin
> and one prompt, showing the "1 Prompt" and "1 Plugin" counts, next to the open
> **Primitives** filter with **Plugins** checked.

If no active hub is configured, the Marketplace shows a hub setup banner
even when a manually added source already provides skills or bundles.
For previously completed or interrupted setup, click **Configure Hub** to choose
a hub. The banner appears after your existing skill and bundle cards.
Adding a standalone source does not configure a hub. The banner is cleared once
a hub is active and setup is complete.
If a hub is already active but setup was interrupted, the banner acknowledges
the configured hub; click **Configure Hub** to resume setup.

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

- **Check for updates:** Right-click a bundle and select **Check for Updates**.
- **Update all:** Open the Command Palette (`Ctrl+Shift+P` on Windows/Linux or
  `Cmd+Shift+P` on macOS) and run **AI Primitives Hub: Update All Bundles**.

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
