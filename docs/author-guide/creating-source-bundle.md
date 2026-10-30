# Creating Collections

A **collection** groups prompts, instructions, chat modes, and agents around a role or skill set.

## Quick Start

[Create a Source or an additional Bundle](./creating-source-bundle.md)

## Visual Collection Editor & One-Click GitHub Collaboration

You can create, edit, and contribute to collections visually without hand-editing YAML or frontmatter:

1. **From a Marketplace Collection Tile or Registry Explorer Item**:
   - Click the **✏️ Contribute / Edit Collection** button on any GitHub-backed collection card in the Marketplace (or in the Bundle Details panel), or right-click a bundle/source in the Registry Explorer and select **Contribute to Collection (Fork, Clone & Open Visual Editor)** (`promptregistry.contributeToCollection`).
   - The extension verifies your GitHub account access, forks and clones the repository (or attaches to your local checkout), creates a feature branch from `upstream/<defaultBranch>`, and opens `collections/<collectionId>.collection.yml` in the **Visual Collection Editor**. *(Note: Artifactory sources are read-only promoted replicas and do not expose contribution actions.)*
2. **Dedicated `Collections Editor` Sidebar View**:
   - Opening any workspace with `collections/*.collection.yml` activates the **Collections Editor** view in the AI Primitives Hub sidebar, showing workspace-wide validation status, all detected collections, their items (with file existence badges), MCP servers/inputs, and active Pull Request status.
3. **Visual CRUD & Friendly Primitive Content Editing**:
   - Edit collection metadata, bump semantic versions (`+Patch`, `+Minor`, `+Major`), configure display preferences and `README.md`, manage MCP servers/inputs, and reorder or add items.
   - Click **✨ + Create New Primitive** to scaffold a new `prompt`, `instruction`, `agent`, `skill`, `plugin`, or `hook` and link it to the collection in one click.
   - Select any item to edit its YAML frontmatter (`name`, `description`, `applyTo`, `tools`, `model`) and Markdown body (or `plugin.json`) in a visual form, while keeping a synchronized **⇄ Split YAML View** open beside the editor.
4. **Commit & Create Pull Request**:
   - Click **🚀 Commit & Create PR** (`promptregistry.submitCollectionPullRequest`) to validate collections, stage all modified `.collection.yml` and primitive files, push to your fork, and open/track a Pull Request against the upstream repository.

## Project Structure

```
my-collection/
├── collections/
│   └── my-collection.collection.yml    # Manifest
├── prompts/
│   └── *.prompt.md
├── instructions/
│   └── *.instructions.md
├── agents/
│   └── *.agent.md
└── README.md
```

## Collection Manifest

```yaml
id: my-collection                    # lowercase, numbers, hyphens
name: My Collection
description: What this collection does
tags: [productivity, coding]
items:
  - path: prompts/task-helper.prompt.md
    kind: prompt                     # prompt | instruction | chat-mode | agent
  - path: instructions/standards.instructions.md
    kind: instruction
```

See [Collection Schema](./collection-schema.md) for full reference.

## Resource Types

| Type | Extension | Purpose |
|------|-----------|---------|
| Prompt | `.prompt.md` | Reusable prompt templates |
| Instruction | `.instructions.md` | System guidelines |
| Agent | `.agent.md` | Autonomous task patterns |

## Scaffolding a Project

Open the Command Palette (`Ctrl+Shift+P` on Windows/Linux or `Cmd+Shift+P` on
macOS) and run **AI Primitives Hub: Scaffold Project**.

### 1. Select project type

| Option | Description |
|--------|-------------|
| **GitHub** | GitHub-based prompt library with CI/CD workflows |
| **APM Package** | Distributable prompt package (`apm.yml`) |
| **Agent Skill** | Single skill with `SKILL.md` |

### 2. Select target directory

A folder picker opens. The scaffolded files are written into this directory.

### 3. Enter project details

All types ask for:

| Prompt | Default |
|--------|---------|
| Project name | `example` |
| GitHub Actions runner type | `ubuntu-latest`, `self-hosted`, or custom label |

Then type-specific questions follow:

**GitHub** — organization details:

| Prompt | Example |
|--------|---------|
| Author name | `Your Name or Team Name` |
| GitHub organization/username | `your-org` |
| Organization name (for LICENSE) | `Your Organization` |
| Security contact email | `security@yourorg.com` |
| Legal contact email | `legal@yourorg.com` |
| Organization policy URL (optional) | `https://yourorg.com/policies` |

**APM Package / Agent Skill** — project metadata:

| Prompt | Default |
|--------|---------|
| Description | *(none)* |
| Author name | `$USER` env variable |
| Tags (comma separated) | APM: `apm, prompts` / Skill: `skill, prompts` |

### 4. What gets created

**GitHub** — a full repository structure including `collections/`, `prompts/`, `instructions/`, `agents/`, `skills/`, GitHub Actions workflows, community files (LICENSE, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT), and VS Code workspace settings.

**APM Package** — `apm.yml`, `package.json`, example prompts/instructions under `.apm/`, and a validation workflow.

**Agent Skill** — a `<project-name>/` subdirectory containing `SKILL.md`, `README.md`, example scripts, and `references/`/`assets/` directories.

After scaffolding, `npm install` runs automatically and you're offered to open the new folder.

### Skill wizard (existing projects)

If you pick **Agent Skill** and the workspace already contains a `collections/` or `skills/` directory, a simplified wizard runs instead:

1. Enter skill name (lowercase, numbers, hyphens)
2. Enter skill description
3. Optionally select a collection to add the skill to
4. The skill is created under `skills/<name>/` and optionally linked in the collection manifest

## Testing Locally

1. Open the Command Palette (`Ctrl+Shift+P` on Windows/Linux or `Cmd+Shift+P`
   on macOS), run **AI Primitives Hub: Add Source**, and choose
   `local-awesome-copilot`.
2. Enter path to your collection directory
3. Bundles appear in Registry Explorer

## Validating

- [Validation](./validation.md)

## See Also

- [Collection Schema](./collection-schema.md) — Full YAML reference
- [Publishing](./publishing.md) — Distribute your collections
