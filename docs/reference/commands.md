# Command Reference

This document lists all VS Code commands provided by the Prompt Registry extension.

## Bundle Management

| Command | Title | Description |
|---------|-------|-------------|
| `promptRegistry.viewBundle` | View Bundle Details | View detailed information about a bundle |
| `promptRegistry.updateBundle` | Update Bundle | Update a specific bundle to the latest version |
| `promptRegistry.uninstallBundle` | Uninstall Bundle | Remove an installed bundle |
| `promptRegistry.checkBundleUpdates` | Check for Bundle Updates | Check if updates are available for a bundle |
| `promptRegistry.updateAllBundles` | Update All Bundles | Update all installed bundles to their latest versions |
| `promptRegistry.manualCheckForUpdates` | Check for Updates (Manual) | Manually trigger an update check |
| `promptRegistry.enableAutoUpdate` | Enable Auto-Update | Enable automatic updates for a bundle |
| `promptRegistry.disableAutoUpdate` | Disable Auto-Update | Disable automatic updates for a bundle |

## Scope Management

Commands for managing bundle installation scope. These are available via context menu on installed bundles in the Registry Explorer.

| Command | Title | Description |
|---------|-------|-------------|
| `promptRegistry.moveToRepositoryCommit` | Move to Repository (Commit) | Move a user-scoped bundle to repository scope, tracked in Git |
| `promptRegistry.moveToRepositoryLocalOnly` | Move to Repository (Local Only) | Move a user-scoped bundle to repository scope, excluded from Git |
| `promptRegistry.moveToUser` | Move to User | Move a repository-scoped bundle to user scope |
| `promptRegistry.switchToLocalOnly` | Switch to Local Only | Change a repository bundle from commit to local-only mode |
| `promptRegistry.switchToCommit` | Switch to Commit | Change a repository bundle from local-only to commit mode |
| `promptRegistry.cleanupStaleLockfileEntries` | Clean Up Stale Repository Bundles | Remove lockfile entries where files no longer exist |

### Move to Repository

Migrates a bundle from user scope to repository scope.

**Commands:**
- `promptRegistry.moveToRepositoryCommit` — Files tracked in version control
- `promptRegistry.moveToRepositoryLocalOnly` — Files excluded via `.git/info/exclude`

**Parameters:**
- `bundleId` — The ID of the bundle to move

**Requirements:** A workspace must be open.

### Move to User

Migrates a bundle from repository scope to user scope.

**Command:** `promptRegistry.moveToUser`

**Parameters:**
- `bundleId` — The ID of the bundle to move

The bundle becomes available across all workspaces after migration.

### Switch Commit Mode

Changes how a repository-scoped bundle interacts with Git.

**Commands:**
- `promptRegistry.switchToLocalOnly` — Exclude files from Git (adds to `.git/info/exclude`)
- `promptRegistry.switchToCommit` — Track files in Git (removes from `.git/info/exclude`)

**Parameters:**
- `bundleId` — The ID of the bundle

### Clean Up Stale Repository Bundles

Removes lockfile entries where the corresponding files no longer exist in the repository.

**Command:** `promptRegistry.cleanupStaleLockfileEntries`

This is useful when bundle files have been manually deleted but the lockfile still references them. The command:
1. Scans the lockfile for bundles with missing files
2. Shows a confirmation dialog with the count of stale entries
3. Removes confirmed stale entries from the lockfile

## Source Management

| Command | Title | Description |
|---------|-------|-------------|
| `promptRegistry.addSource` | Add Source | Add a new bundle source |
| `promptRegistry.editSource` | Edit Source | Modify an existing source configuration |
| `promptRegistry.removeSource` | Remove Source | Delete a source from the registry |
| `promptRegistry.syncSource` | Sync Source | Synchronize bundles from a specific source |
| `promptRegistry.syncAllSources` | Sync All Sources | Synchronize bundles from all configured sources |
| `promptRegistry.toggleSource` | Toggle Source Enabled/Disabled | Enable or disable a source |

## Profile Management

| Command | Title | Description |
|---------|-------|-------------|
| `promptRegistry.createProfile` | Create New Profile | Create a new bundle profile |
| `promptRegistry.editProfile` | Edit Profile | Modify an existing profile |
| `promptRegistry.activateProfile` | Activate Profile | Activate a profile to install its bundles |
| `promptRegistry.deactivateProfile` | Deactivate Profile | Deactivate a profile |
| `promptRegistry.deleteProfile` | Delete Profile | Remove a profile |
| `promptRegistry.exportProfile` | Export Profile | Export a profile to a file |
| `promptRegistry.importProfile` | Import Profile | Import a profile from a file |
| `promptRegistry.listProfiles` | List All Profiles | Display all available profiles |
| `promptRegistry.toggleProfileView` | Toggle Favorites View | Switch between profile views |
| `promptRegistry.toggleProfileFavorite` | Toggle Favorite | Mark or unmark a profile as favorite |

## Hub Management

| Command | Title | Description |
|---------|-------|-------------|
| `promptregistry.importHub` | Import Hub | Import a hub configuration |
| `promptregistry.listHubs` | List Hubs | Display all configured hubs |
| `promptregistry.syncHub` | Sync Hub | Synchronize with a hub |
| `promptregistry.deleteHub` | Delete Hub | Remove a hub configuration |
| `promptregistry.switchHub` | Switch Hub | Switch to a different hub |
| `promptregistry.exportHubConfig` | Export Hub Configuration | Export hub configuration to a file |
| `promptregistry.openHubRepository` | Open Hub Repository | Open the hub's repository in a browser |

## Hub Profile Management

| Command | Title | Description |
|---------|-------|-------------|
| `promptregistry.listHubProfiles` | List Hub Profiles | Display profiles from a hub |
| `promptregistry.browseHubProfiles` | Browse Hub Profiles | Browse available hub profiles |
| `promptregistry.viewHubProfile` | View Hub Profile | View details of a hub profile |
| `promptregistry.activateHubProfile` | Activate Hub Profile | Activate a hub profile |
| `promptregistry.deactivateHubProfile` | Deactivate Hub Profile | Deactivate a hub profile |
| `promptregistry.showActiveProfiles` | Show Active Hub Profiles | Display currently active hub profiles |
| `promptregistry.checkForUpdates` | Check Hub Profile for Updates | Check for updates to a hub profile |
| `promptregistry.viewProfileChanges` | View Hub Profile Changes | View changes in a hub profile |
| `promptregistry.syncProfileNow` | Sync Hub Profile Now | Immediately sync a hub profile |
| `promptregistry.reviewAndSyncProfile` | Review and Sync Hub Profile | Review changes before syncing |
| `promptregistry.viewSyncHistory` | View Hub Profile Sync History | View synchronization history |
| `promptregistry.rollbackProfile` | Rollback Hub Profile | Revert to a previous profile state |
| `promptregistry.clearSyncHistory` | Clear Hub Profile Sync History | Clear the sync history |

## Collection & Validation

| Command | Title | Description |
|---------|-------|-------------|
| `promptRegistry.createCollection` | Create New Collection | Create a new prompt collection |
| `promptRegistry.validateCollections` | Validate Collections | Validate collection YAML files including file references and duplicate detection |
| `promptRegistry.validateApm` | Validate APM Package | Validate an APM package |
| `promptRegistry.listCollections` | List All Collections | Display all collections |

## Scaffolding & Resources

| Command | Title | Description |
|---------|-------|-------------|
| `promptRegistry.scaffoldProject` | Scaffold Project | Create a new project from a template |
| `promptRegistry.addResource` | Add Resource | Add a prompt, instruction, agent, or skill |

## Settings & Configuration

| Command | Title | Description |
|---------|-------|-------------|
| `promptRegistry.exportSettings` | Export Settings | Export extension settings to a file |
| `promptRegistry.importSettings` | Import Settings | Import extension settings from a file |
| `promptRegistry.openSettings` | Open Settings | Open extension settings |

## Authentication & Access

| Command | Title | Description |
|---------|-------|-------------|
| `promptregistry.forceGitHubAuth` | Force GitHub Authentication | Force re-authentication with GitHub |

## Engagement (Feedback)

| Command | Title | Description |
|---------|-------|-------------|
| `promptRegistry.feedback` | Rate & Feedback | Submit feedback with star rating, optional comment, and issue redirect |

### Feedback Command

The unified feedback command (`promptRegistry.feedback`) provides a streamlined flow:
1. **Star Rating (1-5)** — Rate the bundle quality
2. **Optional Comment** — Add a short message about your experience
3. **Action** — Choose what to do next:
   - 📝 Report issue/suggestion — Opens GitHub Issues for detailed feedback
   - ⏭️ Skip — Submit rating and comment only

For awesome-copilot sources, terminology uses "Skill" instead of "Bundle" and version is omitted (pulled from main branch).

Feedback is stored via the EngagementService and synced to GitHub Discussions when configured.

## Utilities

| Command | Title | Description |
|---------|-------|-------------|
| `promptregistry.openItemRepository` | Open Repository | Open an item's repository in a browser |
| `promptRegistry.resetFirstRun` | Reset First Run | Reset first-run state to re-trigger hub selection dialog |

## See Also

- [Settings Reference](./settings.md) — Extension configuration options
- [Getting Started](../user-guide/getting-started.md) — Installation and first steps
