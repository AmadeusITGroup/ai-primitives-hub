# Migration Guide

This guide helps you migrate from deprecated project structures to the current GitHub scaffold format.

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

## Repository-Scope Bundles Installed by Earlier Extension Versions {#repository-scope-shared-install}

The extension now installs repository-scope bundles exactly as the `ai-primitives-hub` CLI does (see [Repository-Level Installation](user-guide/repository-installation.md#same-result-as-the-cli)). Bundles already installed keep working; the differences show up as follows:

- **Prompt file names and slash commands** — a prompt file installed by an earlier version was named after its manifest entry; it now keeps its bundle file name. The installed file keeps its old name until the bundle is reinstalled or updated, which removes the old file and adds the new one: for a bundle whose `prompts/hello.prompt.md` was installed as `hello-prompt.prompt.md`, `/hello-prompt` becomes `/hello`. Update any notes or scripts that use the old slash command, and commit the renamed file for a bundle in commit mode.
- **Older lockfile entries** — entries recorded with workspace paths (`.github/prompts/…`) are still read, checked for local modifications and uninstalled; they are rewritten in the new form on the next reinstall or update.
- **Agent Plugin bundles** — plugin bundles recorded by earlier versions show the "files missing" warning in the Registry Explorer. Reinstall them to install the plugin into `.github/plugins/<plugin-name>/`.
- **Bundles the editor cannot fully install** — installed partially before, they are now rejected with nothing written; see [Bundles the Editor Cannot Install](user-guide/repository-installation.md#bundles-the-editor-cannot-install).

User-scope installs are unchanged.

## Need Help?

- [GitHub Scaffold Documentation](https://github.com/prompt-registry/docs)
- [Collection Schema Reference](../docs/author-guide/collection-schema.md)
