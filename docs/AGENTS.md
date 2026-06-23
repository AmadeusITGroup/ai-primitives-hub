# Documentation Guide for AI Assistants

This file helps AI assistants understand and maintain the AI Primitives Hub documentation.

## Documentation Structure

Documentation is organized by audience:

```
docs/
├── README.md              # Navigation hub - links to all sections
├── AGENTS.md              # This file - AI guidance
├── user-guide/            # End-user documentation
├── author-guide/          # Collection creator documentation
├── contributor-guide/     # Code contributor documentation
├── reference/             # Technical specifications
└── assets/                # Images and diagrams
```

## Finding Documentation

| Audience | Directory | Topics |
|----------|-----------|--------|
| Users | `user-guide/` | Installation, marketplace, sources, profiles, troubleshooting |
| Authors | `author-guide/` | Creating collections, schemas, validation, publishing |
| Contributors | `contributor-guide/` | Dev setup, architecture, testing, coding standards |
| Developers | `reference/` | Commands, settings, APIs, schemas |

## Documentation Discovery

**Before planning or implementing features**, consult the documentation index at [`README.md`](README.md) to understand existing designs and user-facing behavior.

| Working on... | Read first |
|---------------|------------|
| Installation/update flows | `contributor-guide/architecture/installation-flow.md`, `contributor-guide/architecture/update-system.md` |
| Adapters (GitHub, Local, etc.) | `contributor-guide/architecture/adapters.md`, `reference/adapter-api.md` |
| Authentication | `contributor-guide/architecture/authentication.md` |
| UI (Marketplace, TreeView) | `contributor-guide/architecture/ui-components.md` |
| Validation logic | `contributor-guide/architecture/validation.md` |
| MCP integration | `contributor-guide/architecture/mcp-integration.md` |
| Commands or settings | `reference/commands.md`, `reference/settings.md` |
| Bundle/collection schemas | `author-guide/collection-schema.md`, `reference/hub-schema.md` |
| Testing strategy | `contributor-guide/testing.md` |

## Updating Documentation

### When to Update

Update documentation when:
- Adding new features or commands
- Changing existing behavior
- Fixing bugs that affect user-facing functionality
- Modifying configuration options

### Guidelines

1. **Keep it concise** — One clear sentence beats three vague ones.
2. **Match the audience** — User docs should avoid implementation details. Contributor docs can be technical.
3. **Update the right file** — Place content where users expect to find it based on their role.
4. **Maintain links** — When moving or renaming files, update all references.
5. **Use Mermaid diagrams** — Prefer Mermaid diagrams over ASCII diagrams for visual representations, except for file structure/tree displays where ASCII is more appropriate.
6. **Verify accuracy** — Ensure docs match the implemented behavior.

### File Placement by Change Type

| Change Type | Update These Docs |
|-------------|-------------------|
| New command | `reference/commands.md` |
| New setting | `reference/settings.md` |
| New adapter | `contributor-guide/architecture/adapters.md`, `reference/adapter-api.md` |
| Installation/update flow changes | `contributor-guide/architecture/installation-flow.md`, `contributor-guide/architecture/update-system.md` |
| UI changes | `contributor-guide/architecture/ui-components.md` |
| User-facing behavior | Relevant file in `user-guide/` |
| Schema changes | `author-guide/collection-schema.md` or `reference/hub-schema.md` |
| Repository-level installation | `user-guide/repository-installation.md` |
| Collection authoring | `author-guide/` (appropriate file) |
| Development process | `contributor-guide/` (appropriate file) |
| API or schema changes | `reference/` (appropriate file) |
| Installation/scope architecture | `contributor-guide/architecture/installation-flow.md` |

## Key Files

- **`docs/README.md`** — Navigation hub. Update when adding new documentation files.
- **`README.md` (root)** — Landing page. Keep under 150 lines. Link to docs/ for details.
- **`CONTRIBUTING.md`** — Points to contributor-guide/. Update links if files move.

## Style Notes

- Use relative links within docs/ (e.g., `../user-guide/getting-started.md`)
- Links to files outside `docs/` (e.g., `../../CONTRIBUTING.md`) are automatically resolved to GitHub blob URLs at runtime by the Docusaurus link components in `website/src/components/SmartLink.tsx` and `website/src/components/resolveLink.ts`
- Include "See Also" sections to connect related topics
- Add screenshot placeholders with descriptive alt text when UI changes
- Keep each file focused on one topic

### GitHub Pages / Docusaurus Maintenance

When adding or modifying documentation:

1. **New doc pages** must be added to the appropriate sidebar in `website/sidebars.ts`
2. **Links to root-level files** (CONTRIBUTING.md, LICENSE.txt, etc.) should use relative paths — the Docusaurus link components resolve them automatically
3. **Root README links** must use the `./` prefix (e.g., `](./CONTRIBUTING.md)`) so links stay relative to `README.md` when it is rendered by `website/src/pages/index.tsx` and resolved by `website/src/components/SmartLink.tsx`
4. **Excluding files** from the Docusaurus build: add them to `exclude` in `website/docusaurus.config.ts`
5. **Verify changes** by running `cd website && npm run build` — it must complete with no errors
