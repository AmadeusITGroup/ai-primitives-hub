# Profiles and Hubs

## Profiles

A **Profile** groups bundles from multiple sources. Activate with one click.

### Commands

- **Create**: `Ctrl+Shift+P` → "Prompt Registry: Create Profile"
- **Activate**: Right-click profile → Activate Profile
- **Deactivate**: Right-click active profile → Deactivate Profile

### Views

- **Shared Profiles** — Full catalog from hubs
- **Favorites** — Your curated list + local profiles

Toggle with ⭐ button in Registry Explorer.

## Hubs

A **Hub** is a centralized repository of versioned profiles and sources. Share across your organization.

### First-Run Hub Selection

On first launch, Prompt Registry offers a hub selection dialog:

1. **Pre-configured Hubs** — Default hubs are verified for availability before being shown
2. **Custom Hub URL** — Import from any URL
3. **Skip** — Configure later via commands

When you select a hub:
- Hub is imported and set as active
- All sources from the hub are automatically synced
- First available profile is auto-activated
- Tree view refreshes to show hub content

### Automatic Source Addition

On first run, the extension automatically adds the **Awesome Copilot** source (`github/awesome-copilot`) as a default source. This ensures you have immediate access to community collections.

### Automatic Hub Sync

The active hub is automatically synchronized to keep it up-to-date:
- **On startup**: Hub configuration is refreshed each time VS Code starts
- **Periodic**: Hub re-syncs every 24 hours while VS Code is open
- **Manual**: Right-click hub → Sync Hub

After every hub sync (startup, periodic, or manual), all sources are automatically re-synced and the tree view refreshes with the latest bundles.

### Commands

- **Import**: `Ctrl+Shift+P` → "Prompt Registry: Import Hub"
- **Export**: `Ctrl+Shift+P` → "Prompt Registry: Export Hub Configuration"
- **Sync**: Right-click hub → Sync Hub
- **Reset First Run**: `Ctrl+Shift+P` → "Prompt Registry: Reset First Run" (re-triggers hub selector)

### Hub Config Format

```yaml
version: "1.0.0"
metadata:
  name: "Team Hub"
  description: "Shared prompt configuration"
  maintainer: "team-name"
  updatedAt: "2024-01-01T00:00:00Z"
sources:
  - id: "team-prompts"
    type: "github"
    repository: "org/prompts"
    enabled: true
    priority: 10
profiles:
  - id: "backend"
    name: "Backend Developer"
    description: "Prompts for backend development"
    bundles:
      - id: "api-design"
        version: "latest"
        source: "team-prompts"
        required: true
```

## See Also

- [Getting Started](./getting-started.md) — First-run experience
- [Sources](./sources.md) — Configure sources
- [Hub Schema](../reference/hub-schema.md) — Full schema reference
