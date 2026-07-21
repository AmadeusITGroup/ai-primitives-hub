# Documentation

Documentation is Markdown organized by audience. Start with [the docs index](README.md) before changing behavior or adding a page.

```text
user-guide/         Installation, marketplace, sources, profiles, troubleshooting
author-guide/       Collection creation, schemas, validation, and publishing
contributor-guide/  Development setup, architecture, testing, and releases
reference/          Commands, settings, schemas, and adapter API
assets/             Images and diagrams
```

## Find the Right Page

| Change | Documentation |
|---|---|
| Command or setting | `reference/commands.md` or `reference/settings.md` |
| Adapter | `contributor-guide/architecture/adapters.md`, `reference/adapter-api.md` |
| Installation, scope, or update flow | `contributor-guide/architecture/installation-flow.md`, `contributor-guide/architecture/update-system.md` |
| Marketplace or tree UI | `contributor-guide/architecture/ui-components.md` and the relevant user guide |
| Validation or schema | `contributor-guide/architecture/validation.md`, `author-guide/collection-schema.md`, or `reference/hub-schema.md` |
| Authentication or MCP | the corresponding file under `contributor-guide/architecture/` |
| User-visible change | the relevant page under `user-guide/` |

## Authoring Rules

- Write for the target audience. Keep user documentation free of implementation detail; contributor and reference pages may be technical.
- Keep each page focused and concise. Use clear relative links inside `docs/` and include a `See Also` section when it helps discovery.
- Verify commands, settings, paths, and examples against the implementation.
- Use Mermaid for flow or relationship diagrams; retain ASCII only for directory trees.
- Add descriptive screenshot placeholders for UI changes when imagery is unavailable.
- Update `docs/README.md` when adding a page, and update `website/sidebars.ts` for a new Docusaurus page.
- Root README links need a `./` prefix. Links outside `docs/` use relative paths and are resolved by the website link components.

## Validation

From the repository root, build the documentation site with:

```bash
pnpm -C website run build
```

Run this after changes that affect the site navigation, links, MDX, or Docusaurus configuration.
