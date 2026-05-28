# Scaffold Templates

This directory contains templates for different scaffold types that can be used to create new projects with the Prompt Registry extension.

## Directory Structure

```
scaffolds/
├── github/              # GitHub workflow bundle project structure
│   ├── manifest.json    # Template manifest with metadata
│   ├── prompts/         # Example prompt templates
│   ├── instructions/    # Example instruction templates
│   ├── agents/          # Example agent templates
│   ├── collections/     # Example collection templates
│   ├── workflows/       # GitHub Actions workflows
│   └── ...
├── apm/                 # APM package structure
│   └── ...
└── (future types)/      # Additional scaffold types can be added here
```

## Scaffold Types

### github

The `github` scaffold type creates a complete project structure for sharing Copilot prompts, instructions, and agents with GitHub Releases CI for automated collection publishing. This includes:

- Example files for all resource types (prompts, instructions, agents, collections)
- Validation tooling (scripts and GitHub Actions workflows)
- Package configuration with validation scripts
- Comprehensive README with documentation

**Usage:**
```typescript
import { ScaffoldCommand, ScaffoldType } from './commands/ScaffoldCommand';

const command = new ScaffoldCommand(undefined, ScaffoldType.GitHub);
await command.execute('/path/to/new-project', {
    projectName: 'My Awesome Project'
});
```

### apm

The `apm` scaffold type creates a minimal APM package structure.

## Adding New Scaffold Types

To add a new scaffold type:

1. **Create directory**: `scaffolds/your-type-name/`
2. **Add manifest.json**: Define templates with metadata
3. **Add templates**: Create template files with variable placeholders (e.g., `{{projectName}}`)
4. **Update enum**: Add new type to `ScaffoldType` enum in `ScaffoldCommand.ts`
5. **Document**: Add description to this README

### Manifest Format

Each scaffold type must include a `manifest.json` file:

```json
{
  "version": "1.0.0",
  "description": "Description of this scaffold type",
  "templates": {
    "template-id": {
      "path": "relative/path/to/template.md",
      "description": "What this template creates",
      "required": true,
      "variables": ["projectName", "other-variable"]
    }
  }
}
```

### Template Variables

Templates can use variable placeholders that will be substituted during scaffolding:

- `{{projectName}}` - Project display name (e.g., "My Project")
- `{{packageName}}` - Computed kebab-case name (e.g., "my-project")
- `{{collectionId}}` - Collection identifier (kebab-case)
- `{{githubRunner}}` - GitHub Actions runner (e.g., "ubuntu-latest", "self-hosted")
- Custom variables can be added as needed

### File Naming Conventions

- Use `.template.` prefix for files that should be renamed (e.g., `README.template.md` → `README.md`)
- Place workflows in `workflows/` - they'll be copied to `.github/workflows/`
- Scripts should be placed in root or appropriate subdirectories
