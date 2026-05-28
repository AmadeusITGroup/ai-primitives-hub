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
  
  - id: "my-new-source"                    # Unique identifier
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
Ctrl+Shift+P → "Prompt Registry: Import Hub" → [Your hub URL]
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
- Or: `Ctrl+Shift+P` → "Prompt Registry: Sync Hub"

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

### Permission Issues
- Ensure you have write access to the hub repository
- Check if the hub requires specific permissions for contributors

## See Also

- [Hub Schema Reference](../reference/hub-schema.md) — Complete schema documentation
- [Collection Schema](./collection-schema.md) — Creating new bundles
- [Profiles and Hubs Guide](../user-guide/profiles-and-hubs.md) — User perspective
- [Publishing Collections](./publishing.md) — Creating bundle sources