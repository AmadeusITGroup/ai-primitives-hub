# Migration Guide

This guide helps you migrate from deprecated project structures to the current GitHub scaffold format, and upgrade across releases that change the install files.

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

Release `0.3.0` of the `@ai-primitives-hub/*` packages (CLI included) and the extension released with it record installs in new files that both share. Upgrade both together. See the [Command Reference](./reference/commands.md#repository-install-record) and [ADR-0011](./contributor-guide/architecture/adr/0011-ai-primitives-hub-install-records.md).

### What changes

- At the git root, `prompt-registry.lock.json` becomes `ai-primitives-hub.lock.json` (committed) and `prompt-registry.local.lock.json` becomes `ai-primitives-hub.local.lock.json` (local only, in `.git/info/exclude`).
- User installs of the CLI and of every VS Code profile go to one file per machine, `ai-primitives-hub.user.lock.json` in `~/.config/ai-primitives-hub/` (`$XDG_CONFIG_HOME/ai-primitives-hub/` when set).
- Format `3.0.0` keeps one entry per bundle and tool, so a bundle installed for VS Code and for Kiro keeps both.
- Before the first change at a level, the older files are migrated: the repository files are rewritten under the new names and deleted (commit both together), the CLI's old user lockfile (`~/.config/ai-primitives-hub/ai-primitives-hub.lock.json`) is imported once and left in place, and the extension moves the current profile's user installs. Read-only commands never migrate. See [Migrating older records](./reference/commands.md#migrating-older-records).

### Bundles to reinstall

- Migrated bundles are recorded under the tool `unknown` and listed as needing a reinstall in the migration report and in `status`.
- Install one again for your tool (`ai-primitives-hub install <bundle-id> --target <name>`, or **Install** / **Update** in the extension) to replace the entry; its files are kept.
- To drop one, `ai-primitives-hub uninstall <bundle-id>` (or **Uninstall**) removes a lone `unknown` entry and keeps its files.
- The CLI's workspace-scope installs can appear once as `unknown` user-level entries; `ai-primitives-hub uninstall <bundle-id> --scope user` removes them and keeps their files.
- The extension does not move or switch the commit mode of an `unknown` bundle until it is reinstalled.

### Older releases

CLI `0.2.x` and earlier extension releases do not see the new files. A teammate on an older release creates a new `prompt-registry.lock.json`; the next change with `0.3.0` merges it in as `unknown` entries.

### CLI target selection and `init`

- `.ai-primitives-hub/target-state.json` (the last used target) is no longer read or written and can be deleted.
- Without `--target`, a command uses the only configured target. With two or more, it fails with `USAGE.MISSING_FLAG` before writing anything.
- `update` and `uninstall <bundle-id>` take the tools from the record instead: the repository record at the git root when there is one, else the user record. **Inside a git repository with no record, they act on the user level**; pass `--scope repository` or `--target`. A bundle listed only in a not-yet-migrated older file needs `--target` once. See [Choosing a target](./reference/commands.md#choosing-a-target).
- A record replay (`install --lockfile <record>`, or a bare `install`) needs no target.
- `init` no longer creates a lockfile; the first repository install creates `ai-primitives-hub.lock.json`.

### Known limitation: `profile activate`

CLI `profile activate` and `profile deactivate` still write the older files: `prompt-registry.*` for repository targets (migrated as `unknown` on the next record change), and the CLI's old user lockfile for user targets (not read at user level once imported). Reinstall those bundles with `install` to record them.

### Rolling back

Roll back per level and delivery, in this order. Never remove a new record before its bundles are restored or reinstalled.

1. Roll back both the CLI and the extension used at that level (for example `npm install -g @ai-primitives-hub/cli@0.2.1`, and the previous extension version with auto-update off), or the newer one migrates the restored file again.
2. **Repository, committed file.** Find the commit that deleted it (`git log --diff-filter=D -- prompt-registry.lock.json`), restore it (`git checkout <that-commit>^ -- prompt-registry.lock.json`), redo with the older release what changed since, then remove `ai-primitives-hub.lock.json` and commit.
3. **Repository, local-only file.** It cannot be restored. Reinstall the bundles listed in `ai-primitives-hub.local.lock.json` in local-only mode with the older release, then remove that file.
4. **Extension, user level.** The profile's user installs were removed from its storage on migration (their files stay). Reinstall the bundles listed under the editor's tool in `ai-primitives-hub.user.lock.json` with the older release.
5. **CLI, user level.** The old user lockfile was never changed, so CLI `0.2.x` keeps working with it; reinstall or uninstall with `0.2.x` what changed since the upgrade.

Once both deliveries are rolled back at user level and the bundles reinstalled, you can remove `ai-primitives-hub.user.lock.json`.

## Need Help?

- [GitHub Scaffold Documentation](https://github.com/prompt-registry/docs)
- [Collection Schema Reference](../docs/author-guide/collection-schema.md)
