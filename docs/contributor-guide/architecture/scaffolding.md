# Scaffolding

Project templates for creating GitHub Copilot prompt projects.

## Components

| Component | Responsibility |
|-----------|---------------|
| **ScaffoldCommand** | Prompts user, orchestrates scaffolding |
| **TemplateEngine** | Loads, renders, copies templates |

## Scaffold Types

```typescript
export enum ScaffoldType {
    AwesomeCopilot = 'awesome-copilot',
    Apm = 'apm'
}
```

## Template Structure

**Awesome Copilot Template:**
```mermaid
graph TD
    A["templates/scaffolds/github/"]
    B["manifest.json<br/># Template metadata"]
    C["package.template.json<br/># Project package (with variables)"]
    D["README.template.md"]
    E[".gitignore"]
    F["validate-collections.js"]
    G[".vscode/"]
    H["agents/"]
    I["collections/"]
    J["instructions/"]
    K["mcp-server/"]
    L["prompts/"]
    M["schemas/"]
    N["workflows/"]
    
    A --> B
    A --> C
    A --> D
    A --> E
    A --> F
    A --> G
    A --> H
    A --> I
    A --> J
    A --> K
    A --> L
    A --> M
    A --> N
```

**APM Template:**
```mermaid
graph TD
    A["templates/scaffolds/apm/"]
    B["manifest.json"]
    C["package.template.json"]
    D["README.md.template"]
    E["apm.yml.template"]
    F["validate-apm.js"]
    G[".apm/"]
    H["workflows/"]
    
    A --> B
    A --> C
    A --> D
    A --> E
    A --> F
    A --> G
    A --> H
```

## Variable Substitution

Templates use `{{variableName}}` format (processed by `replaceVariables` utility in `src/utils/regexUtils.ts`):

| Variable | Description |
|----------|-------------|
| `{{projectName}}` | Project name |
| `{{collectionId}}` | Collection ID (kebab-case from project name) |
| `{{packageName}}` | Package name (computed from projectName, kebab-case) |
| `{{description}}` | Description (defaults to "A new APM package") |
| `{{author}}` | Author name (defaults to `$USER` env var) |
| `{{tags}}` | Tags array (formatted as JSON string) |
| `{{name}}` | Alias for packageName if not provided |

## TemplateEngine API

```typescript
class TemplateEngine {
    constructor(templateRoot: string);
    async loadManifest(): Promise<TemplateManifest>;
    async renderTemplate(name: string, context: TemplateContext): Promise<string>;
    async copyTemplate(name: string, targetPath: string | vscode.Uri, context: TemplateContext): Promise<void>;
    async scaffoldProject(targetPath: string | vscode.Uri, context: TemplateContext): Promise<void>;
    async getTemplates(): Promise<{ [key: string]: TemplateInfo }>;
}

interface TemplateContext {
    projectName: string;
    collectionId: string;
    [key: string]: any;
}
```

## Usage

```bash
Ctrl+Shift+P → "AI Primitives Hub: Scaffold Project"
```

## See Also

- [Author Guide: Creating Collections](../../author-guide/creating-source-bundle.md)
