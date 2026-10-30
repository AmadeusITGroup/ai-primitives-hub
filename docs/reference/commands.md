# Command Reference

This document lists all VS Code commands provided by the AI Primitives Hub extension.

## Hub Replication (CLI)

`ai-primitives-hub hub replicate --source-hub owner/repo --target-root https://artifactory.example/repo`

Replication reads the source `hub-config.yml` at `--source-ref` and processes enabled `type: github` sources. A release is a candidate only when its name matches `<collectionid>-vX.Y.Z`, it contains one `deployment-manifest.yml` and one `<collectionid>.bundle.zip` (other differently named assets are allowed), and its manifest `id`/`version` match the release name. Noncompliant releases are excluded with warnings. Replication derives the stable ID `<owner>-<repo>[-<manifest.id>]` and accepts only SemVer versions. `--mode latest` (the default) selects the newest stable version for unpinned profile references, falling back to the highest prerelease only when no stable candidate exists; `--mode all` retains every verified release. A profile with any unresolved or unsupported bundle reference is excluded as a whole with a warning.

The command is metadata-only by default: it never downloads archives or publishes. Add `--publish --review` to opt into publication. Bundle objects and `index-v1.json` are written under `<target-root>/sources/replicated` and `hub-config.yml` at `<target-root>`; each object is checked with HEAD and SHA-256 before upload, and the write order is bundle objects, an immutable catalog generation, the compatibility `index-v1.json`, then `hub-config.yml`. The generated hub points to its exact catalog generation so overlapping runs cannot mix its profiles with another run's catalog. Existing objects with the same digest are resumed/skipped. Conflicting or unverifiable bundle objects fail closed by default. With `--allow-unverified-existing`, the CLI skips unverified bundles with warnings and omits them from the generated index. Any profile that references an unverified bundle is excluded as a whole. An unverifiable existing catalog generation still stops publication, with or without `--allow-unverified-existing`. Only the index and hub config may be refreshed after verified bundle publication: metadata creation uses If-None-Match and replacement requires a strong ETag with If-Match. Missing validators or concurrent-write precondition failures stop publication. GitHub reads retry transient failures with a bounded backoff; Artifactory uploads are not retried, so rerun the command to resume. When `--request-budget` is exhausted the command stops with a message to rerun with the same cache directory. Publication credentials are read from the environment variable named by `--publisher-credential-ref` (default `ARTIFACTORY_PUBLISHER_TOKEN`); `--target-credential-ref` only records the consumer reference in the generated hub config. Credentials never appear in logs, cache keys, URLs, or generated configuration.

`--cache-dir`, `--workers`, and `--request-budget` control persistent metadata/archive reuse, concurrency, and the GitHub request ceiling. Cache files are atomically written with directory mode 700 and file mode 600. No GitHub fallback client or `gh` CLI is used by production replication.

## Bundle Build (CLI)

```bash
ai-primitives-hub bundle build --collection-file collections/example.collection.yml --version 1.0.0
ai-primitives-hub bundle build --collection-file collections/example.collection.yml --version 1.0.0 --layout apm
```

`--layout aph` is the unchanged default. The experimental `--layout apm` keeps
source collection files unchanged, packages payload and evidence once under
`.apm/`, and emits root `deployment-manifest.yml` and `apm.yml`. Both manifests
are also written beside the ZIP; structured output adds `apmManifestAsset`.
Primitive paths and governed inventories are rewritten to describe the actual
archive. Matching root APM metadata is validated but never installed as a target
primitive.

The initial APM layout packages prompts, instructions, agents/chatmodes and skills,
including skill resources, under ordinary, `.github/` or `.apm/` directories.
Nested/noncanonical native discovery and dependency/MCP translation limitations
produce warnings without dropping APH content. Unsupported kinds, empty
collections and relocation collisions fail explicitly. See
[APM layout validation](../author-guide/validation.md#experimental-aphapm-bundle-layout)
for metadata mapping and qualification limits. This CLI option does not change
the legacy npm collection builder or Artifactory replication.

## Bundle Install (CLI)

`ai-primitives-hub install [bundle-id] [--from <dir> | --source <value>] --target <target> [--skip-unsupported]`

- `--from <dir>` installs a local bundle. Without a bundle id, the manifest `id` is accepted as-is; with a bundle id, it must match the manifest.
- `--source <value>` is looked up first as a source id (or name) in the active hub, then as a hub id (the hub's profiles name the source that carries the bundle), and only then used as a GitHub `owner/repo`. When none matches, the command fails with `BUNDLE.NOT_FOUND` and names the three lookups it tried. When none matches and the active hub (or the hub named by `--source`) exists but its configuration cannot be loaded, the command fails with `HUB.LOAD_FAILED`, naming the hub and the load error.
- GitHub bundle ids may use the hub form `{owner}-{repo}-{manifestId}`, with or without a `-{version}` / `-v{version}` suffix. The repo prefix is compared case-insensitively; in this form the bundle name and any pinned version must match the manifest exactly. For compatibility, the earlier rule still applies too: an id equal to the manifest `id`, or ending in `-{manifestId}-{version}` / `-{manifestId}-v{version}` after any prefix, is accepted, so this check does not by itself confirm which repository a bundle came from. `profile activate` and `install --lockfile` (for GitHub lockfile sources) apply the same rule.
- An install is all-or-nothing by default: when the target cannot hold part of the bundle, it fails with `BUNDLE.UNSUPPORTED_CONTENT` and writes nothing. `--skip-unsupported` installs the items the target supports and lists each skipped item with its reason, in text output under `Skipped:` and in `-o json` as `data.skipped[]` (`path`, `code`, `reason`). The result has status `warning` and exits 0. When the target supports none of the bundle, the install still fails with `BUNDLE.UNSUPPORTED_CONTENT`. Skipped items are not recorded in the lockfile, so `uninstall` removes only what was installed. The flag works with `<bundle-id>`, `--from` and `--source <hub-id> --interactive`. It is refused with `--lockfile` (`USAGE.INVALID_FLAG`), because replay installs every recorded bundle in full, and has no effect with `--dry-run`. `profile activate` and `update` stay all-or-nothing: to pick up a new version of a partially installed bundle, run `install` again with `--skip-unsupported`.

### Where files land

`install`, `install --lockfile`, `profile activate` and `update` place a bundle by its manifest when the manifest's `prompts:` list names the files (`file:` and `type:`), wherever the files sit in the bundle (for example under `.github/`):

- Each item goes to the target layout's route for its type: `skill` → `skills/`, `instructions` → `instructions/`, `prompt` → `prompts/`, `agent` and `chatmode` → `agents/`. Each target maps those routes to its own folders; Kiro, for example, puts instructions and prompts in `steering/`.
- A skill's whole directory is copied to `skills/<id>/`. Any other item is renamed to `<id>.<type>.md` (for example `<id>.instructions.md`). A trailing type marker in the id is dropped first, so the id `rules.instructions` gives `rules.instructions.md`, not `rules.instructions.instructions.md`. A missing `type:` is detected from the file name and tags.
- Entries that are not files, such as `mcpServers`, are not placed this way. Entries whose `type:` is not one of the five above, and bundle files no item lists, keep the path-based routing below.
- When the target cannot place an item (its type is excluded by the target's `--allowed-kinds`, the layout has no route for it, or an earlier item already uses its destination, such as ids `alpha` and `alpha.instructions` of type `instructions`), the install fails with `BUNDLE.UNSUPPORTED_CONTENT` and writes nothing, unless `--skip-unsupported` is set, which skips the item instead (see above).
- A skill item's `file:` may name the skill directory (`skills/<name>`) or a file in it (`skills/<name>/SKILL.md`); either way only that skill's directory is copied.
- Re-installing or updating a bundle that is already in the lockfile removes the files of the previous install that the new one no longer writes (for example a `prompts/x.md` that is now placed as `prompts/x.prompt.md`), compared by installed location.

Bundles whose manifest lists no items keep path-based routing: a file is installed under the target route matching its bundle path prefix (for example `prompts/`, `skills/`), with its name unchanged.

The lockfile keeps bundle-relative `path` entries with their checksums. For items placed by the manifest it also records `installedPath`, the location relative to the target's base directory, which `uninstall` and `profile deactivate` remove. Entries without `installedPath`, including those written by earlier releases, are removed by path routing as before.

Repository-scope VS Code and Copilot CLI targets keep their own `.github/` writer and are not affected.

Files stored executable in the bundle (a committed `100755` file is archived as `0755`) are installed executable by `install`, `install --lockfile`, `profile activate` and `update`, on every target and at both scopes, including the `.github/` writer. Execute permission is added wherever read permission is granted, so the result follows your umask (`0644` becomes `0755`). Every other file keeps the default mode, and an update that ships a file as non-executable clears its execute bits. `install --from <dir>` takes the bit from the files on disk. The lockfile records no mode. On Windows, and on filesystems that do not allow the mode change (for example vfat/exFAT mounts), the mode is ignored without an error. Bundles that the hub assembles itself from `skills` and `awesome-copilot` sources record every file as non-executable, so their scripts are installed without the execute bit.

## Plugin Create (CLI)

`ai-primitives-hub plugin create <name> [--path <dir>] [--collection <id>] [--description <text>] [--version <version>] [--author <name>]`

Writes `<dir>/<name>/plugin.json` (default `plugins/<name>/plugin.json`), an Agent Plugins 1.0.0 manifest with `$schema`, `name`, `version` (default `1.0.0`), `description` (default `A <name> plugin`) and an object `author` (default: the `USER` environment variable, else `Your Name`). The manifest passes `collection validate` as written.

- `<name>` must be 1–64 characters of lowercase letters, digits, `.` and `-`, start and end with a letter or digit, and contain no `--` or `..`. An invalid name fails with `PRIMITIVE.INVALID_NAME` and a suggested valid name, and nothing is written.
- An existing `plugin.json` is never overwritten; the command fails with `PRIMITIVE.ALREADY_EXISTS`.
- `--collection <id>` adds a `kind: plugin` item to `collections/<id>.collection.yml`. The collection is read before anything is written, so a missing or unreadable collection fails with `FS.COLLECTION_UPDATE_FAILED` and writes nothing. If writing the collection fails, the files the command created are removed.

See [Plugin Items](../author-guide/collection-schema.md#plugin-items) for the plugin layout.

## Doctor Diagnostics (CLI)

`ai-primitives-hub doctor diagnostics [--primitives [--kinds <csv>] [--targets <csv>] [--scopes <csv>]] [--retain-workspace] [-v] [-o <format>]`

Without `--primitives`, the command runs an end-to-end smoke test in a throwaway workspace whose home, XDG and temp directories are sandboxed. With `--primitives`, it runs the primitive install matrix instead: fixture bundles are validated and built, then installed with `install --from` on every target type at user and repository scope, and uninstalled after a successful install. The bundles are:

- one bundle per primitive kind, including a spec-compliant Agent Plugin (root `plugin.json` with `$schema`, a nested skill, a root `mcp.json` and an executable script that uses `${PLUGIN_ROOT}`);
- two mixed-kind bundles: a portable mix (prompt, instruction, agent, skill, plugin, hook) and one with every kind. On a target that supports only some of a bundle's kinds, the expected outcome is a partial install of the supported items. The run installs with the default all-or-nothing behaviour, not the opt-in `install --skip-unsupported` ([#550](https://github.com/AmadeusITGroup/ai-primitives-hub/issues/550)), so these cases are a known gap;
- invalid plugin bundles (missing `$schema`, invalid `name`, string `author`, `plugin.json` outside the plugin root). They are never installed: each passes only when `collection validate` and `bundle build` both reject it with the documented message and no archive is written.

Beyond placement and clean uninstall, the run checks that a rejected install lists exactly the items of the kinds the target does not support, that executable files stay executable in the archive and after install (not applicable on Windows, which has no executable bit), and that an installed plugin's skills and MCP servers are projected for the target with `${PLUGIN_ROOT}` resolved.

- `--kinds`, `--targets` and `--scopes` (`user`, `repository`) take comma-separated values and narrow the cases. They are only valid with `--primitives`. A mixed bundle runs only when every kind it contains is selected. An unknown value, an empty list or a filter that matches no case fails with `USAGE.INVALID_FLAG` before anything is written.
- Each bundle and case is reported as `pass`, `known-gap` (a failure the product is known to have today, matched exactly) or `fail`. A known gap names the GitHub issue that tracks its fix, when there is one (`issue` in the JSON report). Known gaps that no longer occur are listed as unused (`[WARN]` in text output) and do not fail the run.
- A bundle's `I0` check carries the kind/route mismatch warnings of `collection validate` (see [Kind and Path](../author-guide/validation.md#kind-and-path)) as `warnings`; text output prints each one as a `warning:` line under its bundle. They do not change the outcome.
- The exit code is 0 when nothing fails, 1 otherwise. `-o json|yaml|ndjson` prints the full report; `--retain-workspace` keeps the workspace for inspection.

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

## Index & Search

| Command | Title | Description |
|---------|-------|-------------|
| `promptRegistry.searchPrimitives` | Search Primitives | Search indexed prompts, instructions, chat modes, agents, and skills |
| `promptRegistry.rebuildPrimitiveIndex` | Rebuild Primitive Index | Rebuild the shared primitive index from enabled sources, with progress in a notification and the AI Primitives Hub output channel |

Primitive search reads only a pre-built local index. It does not synchronize sources or rebuild the index. **Rebuild Primitive Index** is the explicit lifecycle operation that may access configured sources; it reports harvest, indexing, and embedding milestones in the **AI Primitives Hub** output channel and shows a completion or failure notification.

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
| `promptregistry.contributeToHub` | Contribute to Hub (Fork, Clone & Open Visual Editor) | Fork and clone the active GitHub-connected hub, check out a branch, and open `hub-config.yml` in the Visual Editor (Artifactory hubs are read-only and excluded) |
| `promptregistry.openHubVisualEditor` | Open Hub Configuration in Visual Editor | Open `hub-config.yml` in the Visual Master-Detail Custom Editor |
| `promptregistry.validateHubConfig` | Validate Hub Configuration (Sources, Catalogs & Profiles) | Run static and deep source/bundle validation on `hub-config.yml` |
| `promptregistry.touchHubUpdatedAt` | Hub Config: Update Timestamp (updatedAt) | Update `metadata.updatedAt` in `hub-config.yml` to the current ISO-8601 timestamp |
| `promptregistry.addHubSource` | Hub Config: Add Source | Guided wizard to add a source to `hub-config.yml` |
| `promptregistry.discoverHubSourceBundles` | Hub Config: Discover Source Bundles | Probe a hub source and cache its discovered bundle catalog |
| `promptregistry.addHubProfile` | Hub Config: Add Profile | Guided wizard to add a profile to `hub-config.yml` |
| `promptregistry.addHubProfileBundle` | Hub Config: Add Bundle to Profile | Pick or add a bundle to a hub profile with automatic source-type prefixing |
| `promptregistry.submitHubPullRequest` | Hub Config: Commit & Create Pull Request | Commit `hub-config.yml`, push to fork, and open a Pull Request against the upstream hub repository |
| `promptregistry.refreshHubPullRequestStatus` | Hub Config: Refresh Pull Request Status | Refresh the active Pull Request and CI check-run status |
| `promptregistry.openHubPullRequest` | Hub Config: Open Pull Request in Browser | Open the active Pull Request or upstream hub repository in the browser |

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
| `promptregistry.contributeToCollection` | Contribute to Collection (Fork, Clone & Open Visual Editor) | Fork and clone a GitHub-backed collection repository from a Marketplace tile or Explorer item, check out a branch, and open the target `.collection.yml` in the Visual Collection Editor (Artifactory sources are read-only and excluded) |
| `promptregistry.openCollectionVisualEditor` | Open Collection in Visual Editor | Open a `.collection.yml` manifest in the Visual Master-Detail Custom Editor |
| `promptregistry.openCollectionYamlBeside` | Collection: Open Split YAML View | Open the raw `.collection.yml` file in a split editor beside the Visual Collection Editor |
| `promptregistry.createNewCollectionVisual` | Collection: Create New Collection (Visual) | Create a new `.collection.yml` manifest (with starter README) and open it in the Visual Collection Editor |
| `promptregistry.duplicateCollectionVisual` | Collection: Duplicate Collection | Duplicate an existing collection under a new ID |
| `promptregistry.deleteCollectionVisual` | Collection: Delete Collection | Delete a `.collection.yml` manifest from the workspace |
| `promptregistry.addCollectionItemVisual` | Collection: Create or Add Primitive Item | Open the Visual Collection Editor on the Create/Add Primitive wizard |
| `promptregistry.scaffoldMissingCollectionFile` | Collection: Create Missing Referenced File | Scaffold a missing referenced item or README file on disk from template |
| `promptregistry.openCollectionItemFile` | Collection: Open Referenced Primitive File | Open a collection item's referenced primitive file beside the active editor |
| `promptregistry.bumpCollectionVersion` | Collection: Bump Version (Patch / Minor / Major) | Increment a collection's semantic version (`patch`, `minor`, or `major`) |
| `promptregistry.submitCollectionPullRequest` | Collection: Commit & Create Pull Request | Validate collections, stage modified `.collection.yml` and primitive files, push to fork, and open a Pull Request against upstream |
| `promptregistry.refreshCollectionPullRequestStatus` | Collection: Refresh Pull Request Status | Refresh the active collection Pull Request and CI check-run status |
| `promptregistry.openCollectionPullRequest` | Collection: Open Pull Request in Browser | Open the active collection Pull Request or upstream repository in the browser |

## Scaffolding & Resources

| Command | Title | Description |
|---------|-------|-------------|
| `promptRegistry.scaffoldProject` | Scaffold Project | Create a new project from a template |
| `promptRegistry.addResource` | Add Resource | Add a prompt, instruction, agent, or skill |

### Cross-Platform Path Handling

The scaffold command normalizes path separators to forward slashes before checking for the `templates/scaffolds` directory, ensuring correct template resolution on Windows where backslash separators are used.

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

## Utilities

| Command | Title | Description |
|---------|-------|-------------|
| `promptregistry.openItemRepository` | Open Repository | Open an item's repository in a browser |
| `promptRegistry.resetFirstRun` | Reset First Run | Reset first-run state to re-trigger hub selection dialog |

## See Also

- [Settings Reference](./settings.md) — Extension configuration options
- [Getting Started](../user-guide/getting-started.md) — Installation and first steps
