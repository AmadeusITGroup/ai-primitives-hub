# Default Hubs Configuration

This directory contains the configuration for default hubs that are offered to users during their first-time installation of the Prompt Registry extension.

## Files

- **`defaultHubs.ts`** - TypeScript module that loads and manages default hub configurations
- **`defaultHubs.json`** - JSON configuration file for defining default hubs (optional)

## How It Works

1. **Configuration Loading**:
   - The system first attempts to load hubs from `defaultHubs.json`
   - If the JSON file is not found or invalid, it falls back to hardcoded defaults in `defaultHubs.ts`

2. **Hub Verification**:
   - During first-run, each enabled hub is verified for accessibility
   - Only hubs that pass verification are shown to the user
   - Verification uses the same authentication logic as manual hub imports (includes GitHub token support)

3. **User Selection**:
   - Users see a quick-pick menu with verified hubs
   - Recommended hubs are marked with a star (⭐)
   - Users can also choose "Custom Hub URL" or "Skip for now"

## Configuration Format

### JSON Configuration (`defaultHubs.json`)

```json
{
  "defaultHubs": [
    {
      "name": "Awesome Copilot Hub",
      "description": "Official curated collection",
      "icon": "cloud",
      "reference": {
        "type": "github",
        "location": "github/awesome-copilot",
        "ref": "main"
      },
      "recommended": true,
      "enabled": true
    }
  ]
}
```

### Properties

- **`name`** (required): Display name shown in the selector
- **`description`** (required): Brief description of the hub
- **`icon`** (required): VS Code codicon name (without `$()` wrapper)
  - Examples: `cloud`, `organization`, `repo`, `globe`, `star`
- **`reference`** (required): Hub reference configuration
  - **`type`**: `"github"`, `"local"`, or `"url"`
  - **`location`**: Repository path, file path, or URL
  - **`ref`**: Git reference (branch, tag, or commit) - defaults to "main"
  - **`autoSync`**: Whether to auto-sync (optional)
- **`recommended`** (optional): Mark as recommended (shows star icon) - default: `false`
- **`enabled`** (optional): Show in first-run selector - default: `true`

## Adding New Default Hubs

### Option 1: Modify JSON (Recommended)

Edit `src/config/defaultHubs.json`:

```json
{
  "defaultHubs": [
    {
      "name": "My Custom Hub",
      "description": "Description here",
      "icon": "repo",
      "reference": {
        "type": "github",
        "location": "owner/repository",
        "ref": "main"
      },
      "enabled": true
    }
  ]
}
```

### Option 2: Modify TypeScript

Edit the `HARDCODED_DEFAULT_HUBS` array in `src/config/defaultHubs.ts`:

```typescript
const HARDCODED_DEFAULT_HUBS: DefaultHubConfig[] = [
    {
        name: 'My Custom Hub',
        description: 'Description here',
        icon: 'repo',
        reference: {
            type: 'github',
            location: 'owner/repository',
            ref: 'main'
        },
        enabled: true
    }
];
```

## Hub Verification Process

When a hub is offered during first-run:

1. **Reference Validation**: Validates the hub reference format
2. **Fetch Attempt**: Attempts to fetch `hub-config.yml` from the specified location
3. **Authentication**: For GitHub URLs, automatically includes user's GitHub token
4. **Success/Failure**: 
   - ✓ Success: Hub is shown in the selector
   - ✗ Failure: Hub is hidden from selector (logged for debugging)

## Available Icons

Common VS Code codicon names for hubs:

- `cloud` - Cloud/SaaS service
- `organization` - Organization/team
- `repo` - Repository
- `globe` - Public/internet
- `star` - Featured/special
- `book` - Documentation/learning
- `beaker` - Experimental
- `verified` - Verified/trusted

See [VS Code Codicons](https://microsoft.github.io/vscode-codicons/dist/codicon.html) for full list.

## Testing

To test hub verification locally:

```typescript
import { HubManager } from '../services/HubManager';
import { getEnabledDefaultHubs } from './defaultHubs';

const hubs = getEnabledDefaultHubs();
for (const hub of hubs) {
    const isAvailable = await hubManager.verifyHubAvailability(hub.reference);
    console.log(`${hub.name}: ${isAvailable ? '✓' : '✗'}`);
}
```

## Schema Validation

The JSON configuration is validated against `schemas/default-hubs-config.schema.json`. This ensures:

- Required fields are present
- Types are correct
- Enum values are valid (e.g., hub type must be "github", "local", or "url")

Enable schema validation in VS Code by ensuring the `$schema` property is set in `defaultHubs.json`.
