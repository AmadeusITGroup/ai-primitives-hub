# Migration Guide

This guide helps you migrate from deprecated project structures to the current GitHub scaffold format, and upgrade across releases that change the files the tools write.

## Adding GitHub Releases CI to Existing Collections

If you have a repository with a `collections/` folder but no GitHub Actions workflow for publishing releases, follow these steps:

### Quick Setup

1. Run the scaffold command in your existing project directory:
   ```bash
   # From VS Code Command Palette: "AI Primitives Hub: Scaffold Project" → "GitHub"
   ```

2. Delete the generated example files:
   ```bash
   rm -rf prompts/example.prompt.md instructions/example.instructions.md agents/example.agent.md collections/example.collection.yml skills/example-skill
   ```

3. Push to main branch to trigger the first release.

### What Gets Added

- `.github/workflows/publish.yml` - Automated release workflow
- `.github/actions/` - Reusable GitHub Actions
- `scripts/` - Build and validation scripts
- `package.json` - npm dependencies for validation

## Migrating Chatmode Files to Agent Files {#chatmode-to-agent}

The `chatmode` kind has been replaced by `agent`. If your collection files reference `.chatmode.md` files or use `kind: chatmode`, follow these steps:

### Step 1: Rename Files

Rename all `.chatmode.md` files to `.agent.md`:

```bash
# Find and rename all chatmode files
find . -name "*.chatmode.md" -exec sh -c 'mv "$1" "${1%.chatmode.md}.agent.md"' _ {} \;
```

### Step 2: Update Collection YAML Files

In your collection YAML files, change:

```yaml
# Before
items:
  - kind: chatmode
    path: chatmodes/my-mode.chatmode.md

# After  
items:
  - kind: agent
    path: agents/my-mode.agent.md
```

### Step 3: Move Files to Agents Directory

If you have a `chatmodes/` directory, rename it to `agents/`:

```bash
mv chatmodes agents
```

### Step 4: Update File References

Search your codebase for any remaining references to chatmode files and update them.

## Upgrading to 0.3.0: install records {#upgrading-to-030-install-records}

Release `0.3.0` of the `@ai-primitives-hub/*` packages (CLI included), and the extension release published with it, record installs in new files that the CLI and the extension share. Upgrade both together. Details are in the [Command Reference](./reference/commands.md#repository-install-record); the decision is [ADR-0011](./contributor-guide/architecture/adr/0011-ai-primitives-hub-install-records.md).

### What changes

- **New names.** At the git root, `prompt-registry.lock.json` becomes `ai-primitives-hub.lock.json` (committed) and `prompt-registry.local.lock.json` becomes `ai-primitives-hub.local.lock.json` (local only, kept in `.git/info/exclude`).
- **One user record.** User-level installs of the CLI and of every VS Code profile go to one file per machine, `ai-primitives-hub.user.lock.json` in `~/.config/ai-primitives-hub/` (`$XDG_CONFIG_HOME/ai-primitives-hub/` when set). See [User install record](./reference/commands.md#user-install-record).
- **Format `3.0.0`.** One entry per bundle and tool, so a bundle installed for VS Code and for Kiro keeps both entries and their files.
- **Migration.** Before the first change at a level, the older files are moved into the new record: the repository files are rewritten under the new names and deleted (commit the new file and the deletion together), the CLI's old user lockfile (`~/.config/ai-primitives-hub/ai-primitives-hub.lock.json`) is imported once and left in place, and the extension moves the current profile's user installs. Commands that only read never migrate. See [Migrating older records](./reference/commands.md#migrating-older-records).

### Bundles to reinstall

- The older files do not say which tool installed a bundle, so bundles migrated from them are recorded under the tool `unknown`. They are listed as needing a reinstall in the migration report and in `status`.
- To clear one, install it again for your tool (`ai-primitives-hub install <bundle-id> --target <name>`, or **Install** / **Update** in the extension). The `unknown` entry is replaced and its files are kept.
- To drop one instead, `ai-primitives-hub uninstall <bundle-id>` (or **Uninstall** in the extension) removes an `unknown` entry that is the bundle's only entry and keeps its files, naming them.
- The CLI's old user lockfile also lists the CLI's workspace-scope installs, and cannot tell them apart. They can appear once as `unknown` user-level entries. A plain `ai-primitives-hub uninstall <bundle-id> --scope user` removes them and keeps their files; workspace scope keeps using the old file.
- The extension does not move or switch the commit mode of an `unknown` bundle until it is reinstalled.

### Older releases

CLI `0.2.x` and extension releases before this change only know the `prompt-registry.*` files and the CLI's old user lockfile. After migration they find no repository record and do not see installs recorded in the new files. A teammate who installs with an older release creates a new `prompt-registry.lock.json`; the next change with `0.3.0` merges it in, its new bundles as `unknown` entries.

### CLI target selection

- `.ai-primitives-hub/target-state.json` (the last used target) is no longer read or written. It is left on disk and can be deleted; while it is there, the missing-target hint says it is no longer used.
- Without `--target`, a command uses the only configured target. With two or more targets, `--target` is required, and the command fails with `USAGE.MISSING_FLAG` listing them before writing anything.
- Exceptions: `update` and `uninstall <bundle-id>` take the tools from the record and use each tool's configured target. They act on the level the default rule selects: the repository record at the git root of the current folder when there is one (`ai-primitives-hub.*` or an older `prompt-registry.*` file), else the user record. **Inside a git repository with neither file, they act on the user level.** Pass `--scope repository` or `--target` to act on the repository. The `Record:` line of the output names the level used. For `update` only, `--lockfile` picks the level before `--scope` and the default rule; `uninstall --lockfile` is the lockfile mode and needs a target. When that record has no entry for the action, `--target` is required as above. Only entries already in the install record decide: a bundle listed only in an older file that has not been migrated yet (`prompt-registry.*`, or the CLI's old user lockfile) does not, so on the first run after the upgrade pass `--target` once; that run migrates the level. When the record has other entries, `update` reports such bundles as failed.
- A record replay (`install --lockfile <record>`, or a bare `install`) needs no target, as before.

### `init`

`init` no longer creates a lockfile. The first repository install creates `ai-primitives-hub.lock.json`; until then, `status` and a bare `install` in that repository use the user record.

### Known limitation: `profile activate`

CLI `profile activate` (and `profile deactivate`) still use the older files, to be fixed in a follow-up:

- For repository targets they write `prompt-registry.lock.json` or `prompt-registry.local.lock.json`. The next record change in that repository migrates those bundles as `unknown` entries to reinstall.
- For user targets they write the CLI's old user lockfile. Once the user record has imported that file (at the first user-level change), it is not read again at user level, so those bundles do not appear in user-level `status`, `update` or `uninstall`. Reinstall them with `install` to record them.

### Rolling back

Roll back per level and delivery, in this order. Never remove a new record before its bundles are restored or reinstalled.

1. **First roll back both the CLI and the extension used at that level** (for example `npm install -g @ai-primitives-hub/cli@0.2.1`, and the previous extension version from the Extensions view with auto-update turned off for it). Otherwise the next record change of the newer one migrates the restored file again.
2. **Repository, committed file.** Restore `prompt-registry.lock.json` from git (`git log --diff-filter=D -- prompt-registry.lock.json` finds the commit that deleted it; `git checkout <that-commit>^ -- prompt-registry.lock.json`). Restoring brings back the state before the upgrade, so redo with the older release what changed since (install or update again, uninstall again). Then remove `ai-primitives-hub.lock.json` and commit.
3. **Repository, local-only file.** It cannot be restored: it was excluded from git and deleted by the migration. Reinstall those bundles in local-only mode with the older release (they are listed in `ai-primitives-hub.local.lock.json`), then remove `ai-primitives-hub.local.lock.json`.
4. **Extension, user level.** The profile's user installs were removed from the extension's storage when they were migrated (their files stay) and cannot be restored. Reinstall them with the older release; they are listed in `ai-primitives-hub.user.lock.json` under the editor's tool.
5. **CLI, user level.** The old user lockfile was never changed, so CLI `0.2.x` keeps working with it. It does not show user installs made after the upgrade, and still lists bundles uninstalled since; reinstall or uninstall those with `0.2.x`.

When both deliveries are rolled back at user level and the bundles reinstalled, you can remove `ai-primitives-hub.user.lock.json`; older releases do not read it.

## Need Help?

- [GitHub Scaffold Documentation](https://github.com/prompt-registry/docs)
- [Collection Schema Reference](../docs/author-guide/collection-schema.md)
