# Hub Configuration Schema

This document describes the YAML schema for Prompt Registry hub configuration files.

## Overview

Hubs are centralized configurations that define bundle sources and profiles for teams or organizations. A hub configuration file allows you to share a curated set of sources and pre-configured profiles.

## Schema Version

Current schema version: Based on JSON Schema draft-07

## Root Structure

```yaml
version: "1.0.0"
metadata:
  name: "My Hub"
  description: "Hub description"
  maintainer: "Team Name"
  updatedAt: "2025-01-15T10:00:00Z"
sources:
  - id: "source-1"
    type: "github"
    # ... source configuration
profiles:
  - id: "profile-1"
    name: "Profile Name"
    # ... profile configuration
configuration:
  autoSync: true
  # ... hub configuration
```

## Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | Semantic version of the hub configuration format (e.g., `"1.0.0"`) |
| `metadata` | object | Hub metadata and descriptive information |
| `sources` | array | List of bundle sources available in this hub |

## Metadata Object

The `metadata` object contains descriptive information about the hub.

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Human-readable name of the hub (1-100 characters) |
| `description` | string | Detailed description of the hub's purpose (1-500 characters) |
| `maintainer` | string | Name or identifier of the hub maintainer (1-100 characters) |
| `updatedAt` | string | ISO 8601 timestamp of last update |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `checksum` | string | Integrity checksum (format: `sha256:abc123...` or `sha512:abc123...`) |

### Example

```yaml
metadata:
  name: "Engineering Team Hub"
  description: "Curated prompt bundles for the engineering team"
  maintainer: "Platform Team"
  updatedAt: "2025-01-15T10:30:00Z"
  checksum: "sha256:abc123def456..."
```

## Sources Array

The `sources` array defines bundle sources available in the hub.

### Required Fields per Source

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier (alphanumeric, hyphens, underscores; 1-50 chars) |
| `type` | string | Source type (see below) |
| `enabled` | boolean | Whether this source is currently active |
| `priority` | number | Priority order for source resolution (0-100, higher = higher priority) |

### Source Types

| Type | Description |
|------|-------------|
| `github` | GitHub repository releases |
| `local` | Local file system directory |
| `awesome-copilot` | GitHub-hosted YAML collections |
| `local-awesome-copilot` | Local YAML collections |
| `apm` | APM package repositories |
| `local-apm` | Local APM packages |
| `skills` | GitHub repository with skills |
| `local-skills` | Local filesystem skills directory |

### Optional Fields per Source

| Field | Type | Description |
|-------|------|-------------|
| `url` | string | URL or path to the source |
| `repository` | string | GitHub repository in `owner/repo` format |
| `branch` | string | Git branch name |
| `name` | string | Human-readable name of the source |
| `config` | object | Source-specific configuration |
| `metadata` | object | Additional source metadata |

### Config Object

| Field | Type | Description |
|-------|------|-------------|
| `branch` | string | Git branch name (for git-based sources) |
| `collectionsPath` | string | Path to collections directory (for awesome-copilot) |
| `indexFile` | string | Index file name (for awesome-copilot) |

### Source Metadata Object

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | Source description |
| `homepage` | string | Source homepage URL |
| `contact` | string | Contact information |

### Example

```yaml
sources:
  - id: "company-bundles"
    type: "github"
    repository: "myorg/prompt-bundles"
    branch: "main"
    name: "Company Bundles"
    enabled: true
    priority: 100
    config:
      branch: "main"
    metadata:
      description: "Official company prompt bundles"
      homepage: "https://github.com/myorg/prompt-bundles"

  - id: "community-collection"
    type: "awesome-copilot"
    repository: "community/awesome-prompts"
    enabled: true
    priority: 50
    config:
      collectionsPath: "collections"
      indexFile: "index.yml"
```

## Profiles Array (Optional)

The `profiles` array defines predefined bundle collections.

### Required Fields per Profile

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier (alphanumeric, hyphens, underscores; 1-50 chars) |
| `name` | string | Human-readable name (1-100 characters) |
| `description` | string | Description of the profile's purpose (1-500 characters) |
| `bundles` | array | List of bundles included in this profile (minimum 1) |

### Optional Fields per Profile

| Field | Type | Description |
|-------|------|-------------|
| `icon` | string | Icon or emoji for the profile |
| `active` | boolean | Whether this profile is currently active |
| `createdAt` | string | ISO 8601 timestamp of creation |
| `updatedAt` | string | ISO 8601 timestamp of last update |
| `path` | array | Path hierarchy for organizing in the UI |

### Bundle Object (within Profile)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Bundle identifier (1-50 chars) |
| `version` | string | Yes | Bundle version (semver or `"latest"`) |
| `source` | string | Yes | Source ID where this bundle is available |
| `required` | boolean | Yes | Whether this bundle is mandatory for the profile |

### Example

```yaml
profiles:
  - id: "frontend-dev"
    name: "Frontend Development"
    description: "Essential prompts for frontend developers"
    icon: "🎨"
    active: false
    bundles:
      - id: "react-patterns"
        version: "latest"
        source: "company-bundles"
        required: true
      - id: "css-helpers"
        version: "2.0.0"
        source: "company-bundles"
        required: false
    path:
      - "engineering"
      - "frontend"
```

## Configuration Object (Optional)

Hub-level configuration settings.

| Field | Type | Description |
|-------|------|-------------|
| `autoSync` | boolean | Enable automatic synchronization with hub sources |
| `syncInterval` | number | Sync interval in seconds (60-86400) |
| `strictMode` | boolean | Enable strict validation and security checks |

### Example

```yaml
configuration:
  autoSync: true
  syncInterval: 3600
  strictMode: true
```

## Engagement Object (Optional)

Engagement features configuration for telemetry, ratings, and user feedback.

### Top-Level Fields

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Enable engagement features for this hub |
| `backend` | object | Backend configuration for engagement data storage |
| `telemetry` | object | Telemetry configuration |
| `ratings` | object | Rating configuration |
| `feedback` | object | Feedback configuration |

### Backend Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | Backend type: `file`, `github-issues`, `github-discussions`, or `api` |
| `repository` | string | Conditional | GitHub repository in `owner/repo` format (required for `github-issues` and `github-discussions`) |
| `collectionsUrl` | string | Optional | URL to `collections.yaml` mapping bundles to discussion numbers (for `github-discussions` backend) |
| `apiUrl` | string | Conditional | API endpoint URL (required for `api` backend) |

### Telemetry Object

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Enable telemetry collection |
| `anonymize` | boolean | Anonymize telemetry data |

### Ratings Object

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Enable rating features |
| `ratingsUrl` | string | URL to pre-computed `ratings.json` file (static hosting) |

### Feedback Object

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Enable feedback features |
| `requireRating` | boolean | Require rating when submitting feedback |
| `maxLength` | number | Maximum feedback comment length (100-10000) |
| `feedbackUrl` | string | URL to pre-computed `feedbacks.json` file (static hosting) |

### Example

```yaml
engagement:
  enabled: true
  backend:
    type: github-discussions
    repository: myorg/prompt-registry-hub
    collectionsUrl: https://raw.githubusercontent.com/myorg/prompt-registry-hub/main/collections.yaml
  telemetry:
    enabled: false
    anonymize: true
  ratings:
    enabled: true
    ratingsUrl: https://raw.githubusercontent.com/myorg/prompt-registry-hub/main/ratings.json
  feedback:
    enabled: true
    requireRating: false
    maxLength: 2000
    feedbackUrl: https://raw.githubusercontent.com/myorg/prompt-registry-hub/main/feedbacks.json
```

### Ratings and Feedback Data Files

The `ratingsUrl` and `feedbackUrl` fields point to static JSON files that contain pre-computed engagement data:

**ratings.json structure:**
```json
{
  "version": "1.0.0",
  "generated": "2025-01-29T10:00:00Z",
  "bundles": [
    {
      "sourceId": "awesome-copilot-official",
      "bundleId": "bundle-id",
      "upvotes": 45,
      "downvotes": 3,
      "wilsonScore": 0.89,
      "starRating": 4.5,
      "voteCount": 48,
      "confidence": "high"
    }
  ]
}
```

**Note**: The `sourceId` field is required to uniquely identify bundles across different sources. Bundle IDs alone are not globally unique.

**feedbacks.json structure:**
```json
{
  "version": "1.0.0",
  "generated": "2025-01-29T10:00:00Z",
  "bundles": [
    {
      "bundleId": "bundle-id",
      "feedbacks": [
        {
          "id": "feedback-1",
          "rating": 5,
          "comment": "Excellent bundle!",
          "timestamp": "2025-01-28T15:30:00Z",
          "version": "1.0.0"
        }
      ]
    }
  ]
}
```

These files are typically generated by automated workflows (GitHub Actions) that harvest engagement data from GitHub Discussions or other sources. See the [Engagement Guide](../user-guide/engagement.md) for details on setting up automated harvesting.

## Complete Example

```yaml
version: "1.0.0"

metadata:
  name: "Engineering Team Hub"
  description: "Centralized prompt management for the engineering organization"
  maintainer: "Platform Team"
  updatedAt: "2025-01-15T10:30:00Z"

sources:
  - id: "official-bundles"
    type: "github"
    repository: "myorg/prompt-bundles"
    name: "Official Bundles"
    enabled: true
    priority: 100
    config:
      branch: "main"

  - id: "community"
    type: "awesome-copilot"
    repository: "community/awesome-prompts"
    enabled: true
    priority: 50

profiles:
  - id: "backend-starter"
    name: "Backend Starter Kit"
    description: "Essential prompts for backend development"
    icon: "⚙️"
    bundles:
      - id: "api-design"
        version: "latest"
        source: "official-bundles"
        required: true
      - id: "testing-helpers"
        version: "1.2.0"
        source: "official-bundles"
        required: false

configuration:
  autoSync: true
  syncInterval: 3600
```

## Validation

Hub configurations are automatically validated during import and loading operations using two validation phases:

### Schema Validation
- Uses JSON Schema validation with AJV
- Validates against `schemas/hub-config.schema.json`
- Checks field types, required fields, patterns, and constraints

### Runtime Validation
- Additional business logic checks
- Validates hub references and security constraints
- Verifies source configurations and accessibility

### Manual Validation
To manually validate a hub configuration:

1. Open Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
2. Run "Prompt Registry: Import Hub"
3. The extension validates the configuration before importing

Validation errors are displayed in VS Code notifications and logged to the output channel.

## See Also

- [Profiles and Hubs Guide](../user-guide/profiles-and-hubs.md) — User guide for working with hubs
- [Collection Schema](../author-guide/collection-schema.md) — Schema for collection YAML files
- [Settings Reference](./settings.md) — Extension configuration options
