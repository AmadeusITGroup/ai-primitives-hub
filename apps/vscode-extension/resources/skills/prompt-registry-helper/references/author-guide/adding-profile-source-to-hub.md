# Adding Profiles and Sources to Existing Hubs

Extend existing hubs by adding new sources or profiles to the hub configuration file.

## Prerequisites

- Write access to the hub's configuration repository
- Understanding of [Hub Schema](../reference/hub-schema.md)
- Source repositories must be accessible to hub users (e.g., hosted in a public GitHub organization or one visible to your target audience)

## Adding a Source

### 1. Edit Hub Configuration

Open the hub's YAML configuration file and add a new source to the `sources` array:

Add a new source to the `sources` array:

```yaml
sources:
  # Existing sources...
  
  - id: "my-new-source"                    # Stable identity — keep unchanged once published
    type: "github"                         # Source type
    repository: "myorg/new-prompt-bundles" # Repository location
    name: "My New Source"                  # Display name
    enabled: true                          # Enable immediately
    priority: 75                           # Priority (0-100, higher = more priority)
    config:
      branch: "main"                       # Git branch
    metadata:
      description: "Additional prompt bundles for specialized workflows"
      homepage: "https://github.com/myorg/new-prompt-bundles"
```

### 3. Source Types

Choose the appropriate source type for organization we recommend github source type for versionned package:

| Type | Use Case | Required Fields |
|------|----------|-----------------|
| `github` | GitHub repository | `repository` |
| `awesome-copilot` | YAML collections | `repository` |
| `apm` | APM packages | `url` |

### 4. Priority Guidelines

Set priority based on source importance:
- **90-100**: Critical organizational sources
- **70-89**: Important team sources  
- **50-69**: Community sources
- **10-49**: Experimental sources
- **1-9**: Deprecated sources

## Renaming a Source URL

A source's `id` is its stable identity. Keep the `id` value unchanged and change only the URL — `repository` for `github` and `awesome-copilot` sources, `url` for `apm` sources:

```yaml
sources:
  - id: "ml-prompts"                              # Unchanged — this is the identity
    type: "github"
    repository: "myorg/ml-prompt-collection-v2"   # Changed — the new location
    name: "ML Prompt Collection"
    enabled: true
    priority: 80
```

Because the `id` stayed the same, users who already installed bundles from this source keep them attached: on the next hub sync, their installed bundles migrate to the renamed repository and stay updatable.

Changing an `id` means something different. It is read as removing one source and adding an unrelated one. The removed source is kept — not deleted — while installed bundles still reference it, so nothing is lost, but those bundles stay pointed at the old location and stop receiving updates from the new one.

Changing an `id` also breaks profiles, with or without a URL change. A profile bundle's `source` field names a source `id`, so every profile entry referencing the old `id` no longer resolves. That constraint already exists today; keeping the `id` stable is how you avoid it.

### Backfill Window

The registry remembers which hub declaration each installed source came from. Sources that users stored before this tracking existed do not carry that link yet — it is written on the next successful sync of the hub that owns them. If a rename lands before that sync, the pre-rename source is kept alive instead of migrated, and users see a warning in the logs naming the reason. Publish the rename in a separate commit from any other source change so users get one sync to backfill first.

## Adding a Profile

Profiles group bundles from multiple sources into themed collections.

### 1. Add Profile Entry

Add a new profile to the `profiles` array:

```yaml
profiles:
  # Existing profiles...
  
  - id: "data-science"                     # Unique identifier
    name: "Data Science Toolkit"          # Display name
    description: "Prompts for data analysis, ML, and visualization"
    icon: "📊"                             # Optional icon/emoji
    bundles:
      - id: "python-data"                  # Bundle from any source
        version: "latest"                  # Version or "latest"
        source: "my-new-source"            # Source ID
        required: true                     # Mandatory bundle
      - id: "jupyter-helpers"
        version: "2.1.0"
        source: "official-bundles"
        required: false                    # Optional bundle
    path:                                  # Optional: organize in UI
      - "development"
      - "specialized"
```

### 2. Bundle Requirements

Each bundle in a profile needs:
- **id**: Must match a bundle ID from one of the hub's sources
- **version**: Semantic version or `"latest"`
- **source**: Must reference a source ID defined in the hub
- **required**: `true` for mandatory bundles, `false` for optional

### 3. Profile Organization

Use the `path` array to organize profiles in the UI:

```yaml
path:
  - "engineering"      # Top level
  - "backend"          # Sub-category
```

This creates a hierarchy: Engineering → Backend → [Profile Name]

## Testing Changes

### 1. Validate Configuration

Before committing, validate your hub configuration:

```bash
# If you have the extension installed locally
Ctrl+Shift+P → "AI Primitives Hub: Import Hub" → [Your hub URL]
```

### 2. Test Source Connectivity

Ensure new sources are accessible:
- GitHub repos are public or you have access
- HTTP URLs return valid bundle data
- Local paths exist and contain valid bundles

### 3. Verify Bundle References

Check that profile bundles exist in their specified sources:
- Bundle IDs match exactly
- Versions are available
- Sources contain the referenced bundles

## Publishing Changes

### 1. Commit and Push

```bash
git add hub.yml
git commit -m "Add data science profile and new source"
git push origin main
```

### 2. Update Hub Metadata

Update the hub's metadata section:

```yaml
metadata:
  name: "Engineering Team Hub"
  description: "Centralized prompt management for the engineering organization"
  maintainer: "Platform Team"
  updatedAt: "2025-01-15T10:30:00Z"  # Update timestamp
```

### 3. Notify Users

Users can sync the updated hub:
- Right-click hub in Registry Explorer → "Sync Hub"
- Or: `Ctrl+Shift+P` → "AI Primitives Hub: Sync Hub"

## Example: Complete Addition

Here's a complete example adding both a source and profile:

```yaml
version: "1.0.0"

metadata:
  name: "Engineering Team Hub"
  description: "Centralized prompt management for the engineering organization"
  maintainer: "Platform Team"
  updatedAt: "2025-01-15T10:30:00Z"

sources:
  # Existing sources...
  - id: "official-bundles"
    type: "github"
    repository: "myorg/prompt-bundles"
    enabled: true
    priority: 100

  # New source
  - id: "ml-prompts"
    type: "github"
    repository: "myorg/ml-prompt-collection"
    name: "ML Prompt Collection"
    enabled: true
    priority: 80
    config:
      branch: "main"
    metadata:
      description: "Machine learning and data science prompts"

profiles:
  # Existing profiles...
  
  # New profile
  - id: "ml-engineer"
    name: "ML Engineer Toolkit"
    description: "Essential prompts for machine learning engineers"
    icon: "🤖"
    bundles:
      - id: "model-training"
        version: "latest"
        source: "ml-prompts"
        required: true
      - id: "data-preprocessing"
        version: "1.5.0"
        source: "ml-prompts"
        required: true
      - id: "general-python"
        version: "latest"
        source: "official-bundles"
        required: false
    path:
      - "engineering"
      - "ml"
```

## Troubleshooting

### Source Not Loading
- Verify repository exists and is accessible
- Check branch name in config
- Ensure repository contains valid bundles

### Profile Bundles Missing
- Confirm bundle IDs exist in specified sources
- Check version availability
- Verify source is enabled and synced

### Installed Bundles Did Not Migrate After a Repository Rename
- Confirm the source's `id` is byte-identical to what you published before the rename — a changed `id` is read as remove-plus-add, so the old source is kept and its bundles stay on the old location
- Confirm exactly one source declaration carries that `id`; an ambiguous match is never guessed
- If users synced the hub for the first time only after the rename, the pre-rename source has no recorded link yet (see [Backfill Window](#backfill-window)); reverting the URL, letting users sync once, then re-applying the rename restores the migration path
- Ask users to check the extension logs: each kept-alive source is reported with the source id, how many installed bundles reference it, and the reason

### Permission Issues
- Ensure you have write access to the hub repository
- Check if the hub requires specific permissions for contributors

## See Also

- [Hub Schema Reference](../reference/hub-schema.md) — Complete schema documentation
- [Collection Schema](./collection-schema.md) — Creating new bundles
- [Profiles and Hubs Guide](../user-guide/profiles-and-hubs.md) — User perspective
- [Publishing Collections](./publishing.md) — Creating bundle sources