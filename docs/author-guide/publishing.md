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
2. **Clone** your fork and open it in VS Code with AI Primitives Hub installed
3. **Create a new collection**: open the Command Palette (`Ctrl+Shift+P` on
   Windows/Linux or `Cmd+Shift+P` on macOS) and run
   **AI Primitives Hub: Create Collection**
4. Fill in the collection metadata (id, name, description, version, author, tags) and link your primitives — see [Collection Schema](./collection-schema.md)
5. **Validate**: open the Command Palette (`Ctrl+Shift+P` on Windows/Linux or
   `Cmd+Shift+P` on macOS) and run
   **AI Primitives Hub: Validate Collections**
6. Create a new branch, commit, and open a **Pull Request** against the upstream source repository

## Publishing to Artifactory

Artifactory publishing is supported through a generic repository with a hub-owned static index. Publish the bundle manifest, ZIP archive, optional README, and an `index-v1.json` describing those objects. Every object path must be relative to the configured source root and include its exact byte size and lowercase SHA-256 digest.

Keep publication and consumption credentials separate. Publishers need repository deploy/write permission but should not retain delete permission after setup. Consumers need read permission only. Configure consumers with a credential reference rather than embedding a token in the index, URL, hub configuration, or lockfile. Qualify a publication by checking anonymous/private index access, archive download, digest and size verification, ETag refresh, traversal rejection, and reader/publisher permissions.

The CLI uses an environment variable for the configured credential reference; VS Code stores the entered token in SecretStorage. Both clients use the same source-root and integrity checks.

## Creating a New Source (GitHub Recommended)

### Setup

1. Scaffold a new repository: open the Command Palette (`Ctrl+Shift+P` on
   Windows/Linux or `Cmd+Shift+P` on macOS), run
   **AI Primitives Hub: Scaffold Project**, and choose `Awesome Copilot Project`
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

Open the Command Palette (`Ctrl+Shift+P` on Windows/Linux or `Cmd+Shift+P` on
macOS), run **AI Primitives Hub: Add Source**, choose a collection from a
GitHub repository, then provide the source name and repository link. The
remaining values can keep their defaults.
- Once source is added refresh your marketplace and search for your bundles you can install them

## Updating

1. Push a new commit in your repo
2. Users will need to sync

Users update via: Right-click bundle → "Check for Updates"

## See Also

- [Creating Collections](./creating-source-bundle.md)
- [Collection Schema](./collection-schema.md)
- [Validation](./validation.md)
