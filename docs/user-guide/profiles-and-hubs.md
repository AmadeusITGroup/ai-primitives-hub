# Profiles and Hubs

## Profiles

A **Profile** groups bundles from multiple sources. Activate with one click.

### Commands

- **Create**: Open the Command Palette (`Ctrl+Shift+P` on Windows/Linux or
  `Cmd+Shift+P` on macOS) and run **AI Primitives Hub: Create Profile**
- **Activate**: Right-click profile → Activate Profile
- **Deactivate**: Right-click active profile → Deactivate Profile

### Views

- **Shared Profiles** — Full catalog from hubs
- **Favorites** — Your curated list + local profiles

Toggle with ⭐ button in Registry Explorer.

## Hubs

A **Hub** is a centralized repository of versioned profiles and sources. Share across your organization.

Use a Hub when a team needs one maintained catalog of approved sources and
role-based profiles. A Hub contains configuration; the collections and their
primitive files remain in the referenced sources. If you only need to publish
one collection repository, configure a source instead of creating a Hub.

### First-Run Hub Selection

On first launch, AI Primitives Hub offers a hub selection dialog:

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

Hub sync refreshes the Hub configuration and source catalog. It can reveal
added, removed, or version-changed references in an active profile, but it does
not automatically install, remove, or update collections that are already on
the user's machine. **Sync Profile** accepts the updated profile definition,
while collection installation, updates, and removal remain separate actions.

### Commands

- **Import**: Open the Command Palette (`Ctrl+Shift+P` on Windows/Linux or
  `Cmd+Shift+P` on macOS) and run **AI Primitives Hub: Import Hub**
- **Export**: Open the Command Palette (`Ctrl+Shift+P` on Windows/Linux or
  `Cmd+Shift+P` on macOS) and run
  **AI Primitives Hub: Export Hub Configuration**
- **Sync**: Right-click hub → Sync Hub
- **Reset First Run**: Open the Command Palette (`Ctrl+Shift+P` on
  Windows/Linux or `Cmd+Shift+P` on macOS) and run
  **AI Primitives Hub: Reset First Run** (re-triggers hub selector)

### Hub Config Format

```yaml
version: "1.0.0"
metadata:
  name: "Team Hub"
  description: "Shared prompt configuration"
  maintainer: "team-name"
  updatedAt: "2026-08-16T00:00:00Z" # Replace with the current ISO 8601 timestamp
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
    icon: "🛠️"
    bundles:
      - id: "api-design"
        version: "latest"
        source: "team-prompts"
        required: true
```

The schema accepts any string for `icon`; the extension's profile UI uses
emoji, so these guides use emoji consistently. Pin a semantic version when a
profile must remain stable. Use `latest` only when following the newest
available collection is intentional.

## See Also

- [Getting Started](./getting-started.md) — First-run experience
- [Sources](./sources.md) — Configure sources
- [Creating a Hub](../author-guide/creating-a-hub.md) — Author and publish a Hub
- [Hub Schema](../reference/hub-schema.md) — Full schema reference
