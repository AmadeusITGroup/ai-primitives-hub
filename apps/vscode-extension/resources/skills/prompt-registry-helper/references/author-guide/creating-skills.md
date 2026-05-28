# Creating Agent Skills

This guide covers how to create and manage Agent Skills in the Prompt Registry.

## What is an Agent Skill?

Agent Skills are reusable capabilities that can be added to AI agents in GitHub Copilot. Unlike prompts or instructions that provide context, skills enable agents to perform specialized tasks by defining:

- A name and description
- Allowed tools the skill can use
- Supporting scripts and reference materials

## Skill Structure

A skill is organized in a directory with the following structure:

```
my-skill/
├── SKILL.md              # Main skill definition (required)
├── scripts/              # Utility scripts
│   └── example.py        # Script files
├── references/           # Reference materials
│   └── api-docs.md       # Documentation files
├── assets/               # Static assets
│   └── data.json         # Data files
└── README.md             # Documentation
```

## SKILL.md Format

The `SKILL.md` file is the core of a skill, containing YAML frontmatter and markdown content:

```markdown
---
name: my-skill
description: A skill that does something useful
metadata:
  license: MIT
  version: 1.0.0
  author: Your Name
allowed-tools:
  - run_in_terminal
  - read_file
  - grep_search
---

# My Skill

Description of what this skill does and when to use it.

## Usage

Instructions for using this skill...

## Examples

Example interactions demonstrating the skill...
```

### Required Frontmatter Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique identifier for the skill |
| `description` | string | Short description of the skill's purpose |

### Optional Frontmatter Fields

| Field | Type | Description |
|-------|------|-------------|
| `metadata.license` | string | License identifier (e.g., MIT, Apache-2.0) |
| `metadata.version` | string | Skill version (semver) |
| `metadata.author` | string | Author name or contact |
| `allowed-tools` | string[] | List of tools the skill can use |

## Creating a Skill with Scaffolding

The easiest way to create a new skill is using the scaffold command:

1. Open Command Palette (`Ctrl+Shift+P`)
2. Run "Prompt Registry: Scaffold Project"
3. Select "Agent Skill"
4. Choose target directory
5. Enter skill name and details

This creates a complete skill structure with example files.

## Installing Skills

### User Scope

Skills installed at user scope are available in all workspaces:

```bash
# Location: ~/.copilot/skills/
cp -r my-skill ~/.copilot/skills/
```

### Workspace Scope

Skills installed at workspace scope are only available in that workspace:

```bash
# Location: .copilot/skills/ in your project
cp -r my-skill .copilot/skills/
```

### Using Prompt Registry

Skills can be included in bundles and installed via the Prompt Registry extension. Add a skill to your collection manifest:

```yaml
id: my-collection
name: My Collection
items:
  - path: skills/my-skill/SKILL.md
    kind: skill
    name: My Skill
    description: A useful skill
```

## Allowed Tools

Skills can restrict which tools they use via the `allowed-tools` field. Common tools include:

| Tool | Description |
|------|-------------|
| `run_in_terminal` | Execute shell commands |
| `read_file` | Read file contents |
| `grep_search` | Search for patterns |
| `semantic_search` | Semantic code search |
| `list_dir` | List directory contents |
| `create_file` | Create new files |
| `replace_string_in_file` | Edit existing files |

## Best Practices

1. **Single Responsibility**: Each skill should focus on one specific capability
2. **Clear Documentation**: Provide examples and usage instructions in the markdown content
3. **Tool Minimization**: Only request the tools your skill actually needs
4. **Reusable Scripts**: Place utility scripts in the `scripts/` directory
5. **Reference Materials**: Include relevant documentation in `references/`

### Versioning & Updates

- Prompt Registry calculates the displayed version for GitHub/local skills from a **content hash**. Any change to files inside the skill directory (`SKILL.md`, `scripts/`, `references/`, `assets/`, etc.) produces a new hash so the Marketplace shows **Update** after sync.
- The optional `metadata.version` field in `SKILL.md` is still useful for humans but is not the signal that drives update detection.
- When developing locally, simply edit your files and run **Sync Source**—the installed entry refreshes automatically because local installs are symlinked to the source folder.

## Examples

### Code Review Skill

```markdown
---
name: code-review
description: Reviews code for quality, security, and best practices
allowed-tools:
  - read_file
  - grep_search
  - semantic_search
---

# Code Review Skill

This skill performs comprehensive code reviews...
```

### Test Generator Skill

```markdown
---
name: test-generator
description: Generates unit tests for code
allowed-tools:
  - read_file
  - create_file
  - run_in_terminal
---

# Test Generator Skill

This skill creates unit tests based on existing code...
```

## See Also

- [Agent Skills Specification](https://agentskills.io/specification)
- [VS Code Agent Skills Documentation](https://code.visualstudio.com/docs/copilot/customization/agent-skills)
- [Collection Schema](./collection-schema.md)
