# Migration Guide

This guide helps you migrate from deprecated project structures to the current GitHub scaffold format.

## Adding GitHub Releases CI to Existing Collections

If you have a repository with a `collections/` folder but no GitHub Actions workflow for publishing releases, follow these steps:

### Quick Setup

1. Run the scaffold command in your existing project directory:
   ```bash
   # From VS Code Command Palette: "Prompt Registry: Scaffold Project" → "GitHub"
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

## Need Help?

- [GitHub Scaffold Documentation](https://github.com/prompt-registry/docs)
- [Collection Schema Reference](../docs/author-guide/collection-schema.md)
