# Creating Collections

A **collection** groups prompts, instructions, chat modes, and agents around a role or skill set.

## Quick Start

[Create a Source or an additional Bundle](./creating-source-bundle.md)

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

`Ctrl+Shift+P` → "Prompt Registry: Scaffold Project"

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

1. Add local source: `Ctrl+Shift+P` → "Add Source" → `local-awesome-copilot`
2. Enter path to your collection directory
3. Bundles appear in Registry Explorer

## Validating

- [Validation](./validation.md)

## See Also

- [Collection Schema](./collection-schema.md) — Full YAML reference
- [Publishing](./publishing.md) — Distribute your collections
