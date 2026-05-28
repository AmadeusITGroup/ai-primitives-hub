# Publishing Collections

## Choosing Where to Publish

Before publishing, decide where your collection should live:

### Publish to an existing shared source

Best when your organization already maintains a central collection repository.

- **Pros:** Less setup — no source creation needed; immediate visibility to all hub users
- **Cons:** You follow the repository's review process; ownership is per-author per-collection

### Publish to your own source

Best when you want full control over the review and release cycle.

- **Pros:** Independent review and release cycle; source can be scoped per team or project
- **Cons:** Initial setup required (create repo, link to hub); users must add your source or it must be added to a hub

## Contributing to an Existing Source

If you're contributing a collection to a source you don't own:

1. **Fork** the source repository on GitHub
2. **Clone** your fork and open it in VS Code with Prompt Registry installed
3. **Create a new collection**: `Ctrl+Shift+P` → "Prompt Registry: Create Collection"
4. Fill in the collection metadata (id, name, description, version, author, tags) and link your primitives — see [Collection Schema](./collection-schema.md)
5. **Validate**: `Ctrl+Shift+P` → "Prompt Registry: Validate Collections"
6. Create a new branch, commit, and open a **Pull Request** against the upstream source repository

## Creating a New Source (GitHub Recommended)

### Setup

1. Scaffold a new repository: `Ctrl+Shift+P` → "Prompt Registry: Scaffold Project" → `Awesome Copilot Project`
2. Choose an empty folder where the repository should be bootstrap
3. Update the content of different folder and collections files
4. Validate your collection [Validation](./validation.md)
5. Create a new repository in your github organization
6. Do the initial commit and push to your new repository

### Update the content of your collection

```yaml
id: my-collection
name: My Collection
version: 1.0.0
description: What this collection does
```

### Users Install Via

```bash
Ctrl+Shift+P → "Add Source" → Collection from Github repository → Name of the source → Link to your repository you just published → remaining can remain as default
```
- Once source is added refresh your marketplace and search for your bundles you can install them

## Updating

1. Push a new commit in your repo
2. Users will need to sync

Users update via: Right-click bundle → "Check for Updates"

## See Also

- [Creating Collections](./creating-source-bundle.md)
- [Collection Schema](./collection-schema.md)
- [Validation](./validation.md)
