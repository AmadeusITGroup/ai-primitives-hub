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

The `ai-primitives-hub` CLI installs at repository scope too, into the same files (see [Repository install record](../reference/commands.md#repository-install-record)).

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
└── ai-primitives-hub.lock.json
```

**Benefits:**
- Team members get the same configurations automatically
- Version-controlled history of changes
- Works with CI/CD and code review workflows

### Local-Only Mode

Files are placed in the same `.github/` directories but excluded from Git via `.git/info/exclude`. Local-only bundles are recorded in a separate file:

```
your-repo/
├── .github/
│   ├── prompts/
│   │   └── my-prompt.prompt.md         # Excluded from Git
│   └── agents/
│       └── my-agent.agent.md           # Excluded from Git
├── ai-primitives-hub.local.lock.json   # Excluded from Git (auto-managed)
└── .git/
    └── info/
        └── exclude                     # Contains exclusion entries
```

The `.git/info/exclude` file will contain:

```
# Prompt Registry (local)
.github/prompts/my-prompt.prompt.md
.github/agents/my-agent.agent.md
ai-primitives-hub.local.lock.json
```

**Benefits:**
- Personal customizations that don't affect the team
- Experiment with bundles before committing
- Override team configurations locally
- Installing local-only bundles never modifies the shared `ai-primitives-hub.lock.json`

## The Install Record

Repository installs are recorded at the git root, in files shared by the VS Code extension and the CLI:

| File | Purpose | Git Tracking |
|------|---------|--------------|
| `ai-primitives-hub.lock.json` | Committed bundles | Tracked in Git |
| `ai-primitives-hub.local.lock.json` | Local-only bundles | Excluded from Git |

The local-only file is added to `.git/info/exclude` when it is created. A record file is deleted when its last bundle is removed. The records keep each bundle's version, tool, source (never credentials) and file checksums, used to detect local edits before an update.

### Format 3.0.0

Each bundle has one entry per tool (`vscode`, `kiro`, …), so installing it for a second tool, from another editor or the CLI, keeps the first. File paths are relative to the git root.

```json
{
  "$schema": "https://github.com/AmadeusITGroup/ai-primitives-hub/schemas/lockfile.schema.json",
  "bundles": {
    "my-bundle": {
      "tools": {
        "vscode": {
          "files": [
            { "checksum": "sha256:<64 hex digits>", "path": ".github/skills/my-skill/SKILL.md" }
          ],
          "installedAt": "2026-01-14T10:30:00.000Z",
          "sourceId": "my-source",
          "sourceType": "github",
          "version": "1.2.0"
        }
      }
    }
  },
  "generatedAt": "2026-01-14T10:30:00.000Z",
  "generatedBy": "ai-primitives-hub-cli@0.3.0",
  "level": "repository",
  "sources": {
    "my-source": { "type": "github", "url": "https://github.com/org/repo" }
  },
  "version": "3.0.0"
}
```

The extension changes only the entries of the editor it runs in; other tools' entries are read-only, with the CLI command to change them.

**Commit `ai-primitives-hub.lock.json`**, not `ai-primitives-hub.local.lock.json`.

### User-level installs

User Profile installs go to one `ai-primitives-hub.user.lock.json` per machine in `~/.config/ai-primitives-hub/` (`$XDG_CONFIG_HOME/ai-primitives-hub/` when set), shared by the CLI and every VS Code profile, with paths relative to your home folder. See [User install record](../reference/commands.md#user-install-record).

### Older `prompt-registry` files

Releases before 0.3.0 used `prompt-registry.lock.json` and `prompt-registry.local.lock.json`. Before the first install, update or uninstall in the repository, they are moved into the new files and deleted; commit both together. Migrated bundles are listed as needing a reinstall (tool `unknown`): install or update them to record them for your tool, keeping their files. See [Migrating older records](../reference/commands.md#migrating-older-records) and [Upgrading to 0.3.0](../migration-guide.md#upgrading-to-030-install-records).

## Moving Bundles Between Scopes

Right-click an installed bundle in the Registry Explorer to access scope management options:

### From User Scope

- **Move to Repository (Commit)** — Migrate to repository scope, tracked in Git
- **Move to Repository (Local Only)** — Migrate to repository scope, excluded from Git

### From Repository Scope

- **Move to User** — Migrate to user scope, available across all workspaces
- **Switch to Local Only** — Keep in repository but exclude from Git
- **Switch to Commit** — Keep in repository and track in Git

Moving a bundle preserves its files and version. The extension handles uninstalling from the old scope and reinstalling at the new scope. Bundles listed as needing a reinstall cannot be moved or switched until they are reinstalled.

## Team Workflow

### Setting Up Repository Bundles

1. Open your repository in VS Code
2. Install bundles using **Repository - Commit to Git**
3. Commit the `.github/` files and `ai-primitives-hub.lock.json`
4. Push to share with your team

### Joining a Repository with Bundles

When the install record names sources or hubs you have not configured, a notification says how many and which credentials they need. Add them (**Add Source**, or import the hub) before installing the recorded bundles.

To restore the recorded bundles from the command line, run a bare `ai-primitives-hub install` in the repository; it reinstalls each recorded tool that has a configured target, at its recorded version.

### Updating Repository Bundles

Updates work the same as user-level bundles:

1. Check for updates via the Registry Explorer
2. Review available updates
3. Update individual bundles or all at once
4. Commit the updated files and `ai-primitives-hub.lock.json`

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

### Repository options are disabled

Repository scope requires an open workspace. Open a folder or workspace first.

### Install record conflicts

If multiple team members install bundles simultaneously, merge `ai-primitives-hub.lock.json` like any other file. A record that cannot be read after the merge stops the next change with a `RECORD.*` error naming the file, and nothing is written; fix the file and try again.

### Bundles listed as needing a reinstall

These came from an older `prompt-registry` file. Install or update the bundle to record it for your tool, or uninstall it to drop the entry (its files are kept).

### Stale record entries

If you manually delete bundle files but the record still lists them, the extension shows a warning indicator on those bundles. Use the "Clean Up Stale Repository Bundles" command (from the Command Palette) to remove these entries from the record.

### Local modifications warning

If you see warnings about local modifications when updating, your local files differ from the original installation. Review your changes before deciding to override.

## See Also

- [Getting Started](./getting-started.md) — Installation and first steps
- [Marketplace](./marketplace.md) — Browse and install bundles
- [Configuration](./configuration.md) — Extension settings
- [Command Reference](../reference/commands.md) — All available commands
- [Migration Guide](../migration-guide.md#upgrading-to-030-install-records) — Upgrading to 0.3.0
