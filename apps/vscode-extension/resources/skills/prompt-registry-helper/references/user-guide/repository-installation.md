# Repository-Level Installation

Repository-level installation allows teams to share Copilot configurations through Git. Bundles are installed in the repository's `.github/` directory structure, making them available to all team members who clone the repository.

## Installation Scopes

When installing a bundle, you can choose from three options:

| Option | Location | Visibility | Use Case |
|--------|----------|------------|----------|
| **Repository - Commit to Git** | `.github/` directories | All team members | Shared team configurations |
| **Repository - Local Only** | `.github/` directories | Only you | Personal customizations |
| **User Profile** | User config directory | All your workspaces | Personal global settings |

## Installing at Repository Scope

1. Click **Install** on any bundle in the Marketplace
2. Select an installation scope:
   - **Repository - Commit to Git (Recommended)** — Files are tracked in version control
   - **Repository - Local Only** — Files are excluded from Git via `.git/info/exclude`
   - **User Profile** — Traditional user-level installation

Repository options require an open workspace. If no workspace is open, only User Profile is available.

## Commit vs Local-Only Mode

### Commit Mode (Recommended)

Files are placed in `.github/` directories and tracked by Git:

```
your-repo/
├── .github/
│   ├── prompts/
│   │   └── my-prompt.prompt.md
│   ├── agents/
│   │   └── my-agent.agent.md
│   ├── instructions/
│   │   └── my-instructions.instructions.md
│   └── skills/
│       └── my-skill/
│           └── skill.md
└── prompt-registry.lock.json
```

**Benefits:**
- Team members get the same configurations automatically
- Version-controlled history of changes
- Works with CI/CD and code review workflows

### Local-Only Mode

Files are placed in the same `.github/` directories but excluded from Git via `.git/info/exclude`. Additionally, local-only bundles are tracked in a separate lockfile:

```
your-repo/
├── .github/
│   ├── prompts/
│   │   └── my-prompt.prompt.md       # Excluded from Git
│   └── agents/
│       └── my-agent.agent.md         # Excluded from Git
├── prompt-registry.local.lock.json   # Excluded from Git (auto-managed)
└── .git/
    └── info/
        └── exclude                   # Contains exclusion entries
```

The `.git/info/exclude` file will contain:

```
# Prompt Registry (local)
.github/prompts/my-prompt.prompt.md
.github/agents/my-agent.agent.md
prompt-registry.local.lock.json
```

**Benefits:**
- Personal customizations that don't affect the team
- Experiment with bundles before committing
- Override team configurations locally
- Installing local-only bundles never modifies the shared `prompt-registry.lock.json`

## The Lockfile

When bundles are installed at repository scope, lockfiles are created at the repository root to track installations:

| Lockfile | Purpose | Git Tracking |
|----------|---------|--------------|
| `prompt-registry.lock.json` | Committed bundles | Tracked in Git |
| `prompt-registry.local.lock.json` | Local-only bundles | Excluded from Git |

These files:

- Track installed bundles and their versions
- Record source information for reproducibility
- Store file checksums for modification detection
- Enable tools like Renovate to propose version updates (main lockfile only)

### Dual-Lockfile Architecture

Bundles are automatically stored in the appropriate lockfile based on their commit mode:

- **Commit mode** bundles go in `prompt-registry.lock.json` (shared with team)
- **Local-only** bundles go in `prompt-registry.local.lock.json` (personal, never committed)

The local lockfile is automatically added to `.git/info/exclude` when created, ensuring your personal bundle installations never accidentally get committed.

### Lockfile Structure

```json
{
  "$schema": "https://github.com/AmadeusITGroup/prompt-registry/schemas/lockfile.schema.json",
  "version": "1.0.0",
  "generatedAt": "2026-01-14T10:30:00.000Z",
  "generatedBy": "prompt-registry@1.0.0",
  "bundles": {
    "my-bundle": {
      "version": "1.2.0",
      "sourceId": "my-source",
      "sourceType": "github",
      "installedAt": "2026-01-14T10:30:00.000Z",
      "files": [
        {
          "path": ".github/prompts/my-prompt.prompt.md",
          "checksum": "abc123..."
        }
      ]
    }
  },
  "sources": {
    "my-source": {
      "type": "github",
      "url": "https://github.com/org/repo"
    }
  }
}
```

**Commit the main lockfile** (`prompt-registry.lock.json`) to version control so team members can:
- See which bundles are installed
- Get prompted to enable repository bundles when opening the project
- Receive automated update PRs via Renovate

The local lockfile (`prompt-registry.local.lock.json`) is automatically excluded from Git and should not be committed.

## Moving Bundles Between Scopes

Right-click an installed bundle in the Registry Explorer to access scope management options:

### From User Scope

- **Move to Repository (Commit)** — Migrate to repository scope, tracked in Git
- **Move to Repository (Local Only)** — Migrate to repository scope, excluded from Git

### From Repository Scope

- **Move to User** — Migrate to user scope, available across all workspaces
- **Switch to Local Only** — Keep in repository but exclude from Git
- **Switch to Commit** — Keep in repository and track in Git

Moving a bundle preserves its files and version. The extension handles uninstalling from the old scope and reinstalling at the new scope.

## Team Workflow

### Setting Up Repository Bundles

1. Open your repository in VS Code
2. Install bundles using **Repository - Commit to Git**
3. Commit the `.github/` files and `prompt-registry.lock.json`
4. Push to share with your team

### Joining a Repository with Bundles

When you open a repository with a lockfile for the first time:

1. A notification appears asking if you want to enable repository bundles
2. Click **Enable** to:
   - Verify all bundles are installed
   - Download any missing bundles
   - Sync bundles to Copilot
3. Click **Don't ask again** to skip for this repository

### Updating Repository Bundles

Updates work the same as user-level bundles:

1. Check for updates via the Registry Explorer
2. Review available updates
3. Update individual bundles or all at once
4. Commit the updated files and lockfile

If you've modified bundle files locally, you'll see a warning before updating with options to:
- **Contribute Changes** — Open the bundle's repository to submit your changes
- **Override** — Replace local files with the update
- **Cancel** — Keep your local changes

## File Locations

| File Type | Repository Location |
|-----------|---------------------|
| Prompts (`.prompt.md`) | `.github/prompts/` |
| Instructions (`.instructions.md`) | `.github/instructions/` |
| Agents (`.agent.md`) | `.github/agents/` |
| Skills | `.github/skills/<skill-name>/` |
| MCP Servers | `.vscode/mcp.json` |

## Troubleshooting

### Migrating from Legacy Lockfiles

If you have an existing `prompt-registry.lock.json` with a `commitMode` field in bundle entries, no action is required. The extension handles this automatically:

- **On read**: The `commitMode` field is ignored—bundles in `prompt-registry.lock.json` are treated as committed, bundles in `prompt-registry.local.lock.json` are treated as local-only
- **On write**: New entries are written without the `commitMode` field
- **Gradual migration**: Existing entries retain the `commitMode` field until they are modified (updated, mode switched, etc.)

If you have local-only bundles in your main lockfile (with `"commitMode": "local-only"`), you can migrate them to the new local lockfile by:

1. Right-click the bundle in Registry Explorer
2. Select **Switch to Commit** (this updates the entry)
3. Select **Switch to Local Only** (this moves it to the local lockfile)

Or simply update the bundle—the new entry will be written to the correct lockfile based on its mode.

### Repository options are disabled

Repository scope requires an open workspace. Open a folder or workspace first.

### Lockfile conflicts

If multiple team members install bundles simultaneously, merge the lockfile changes like any other file. The extension will reconcile the state on next sync.

### Missing bundles after clone

When you clone a repository with a lockfile, the extension prompts you to install missing bundles. If you dismissed the prompt, you can manually install bundles from the lockfile.

### Stale lockfile entries

If you manually delete bundle files but the lockfile still references them, the extension shows a warning indicator on those bundles. Use the "Clean Up Stale Repository Bundles" command (from the Command Palette) to remove these stale entries from the lockfile.

### Local modifications warning

If you see warnings about local modifications when updating, your local files differ from the original installation. Review your changes before deciding to override.

## See Also

- [Getting Started](./getting-started.md) — Installation and first steps
- [Marketplace](./marketplace.md) — Browse and install bundles
- [Configuration](./configuration.md) — Extension settings
- [Command Reference](../reference/commands.md) — All available commands
