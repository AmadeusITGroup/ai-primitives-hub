# Creating a Hub

A Hub is a versioned YAML configuration that gives a group of users the same
collection sources and optional profiles. It is useful when a team or
organization wants one maintained entry point instead of asking every user to
configure sources individually.

A Hub does not store primitive files. It points to sources that contain the
collections and groups collections from those sources into profiles.

## Choose the Right Building Block

| Need | Use |
|---|---|
| Publish prompts, instructions, agents, skills, or other primitives together | Collection |
| Make collections available from a repository or location | Source |
| Group collections for a role, team, or workflow | Profile |
| Distribute approved sources and profiles through one maintained configuration | Hub |

Create a Hub when multiple users need a shared catalog, shared role-based
profiles, or centrally maintained source configuration. A Hub is usually
unnecessary for one person installing one collection in one project.

## Plan Ownership

Before creating the file, decide:

- Who owns reviews and releases for the Hub configuration
- Which teams are expected to use it
- Which sources are approved and accessible to those users
- Whether one organization Hub or several team Hubs are easier to maintain
- How breaking source/profile changes will be communicated

The Hub repository should have normal code-review protections because a Hub
can change what users discover and activate. Do not put access tokens or other
secrets in `hub-config.yml`.

## 1. Scaffold the Configuration

The CLI can create a starting file:

```bash
ai-primitives-hub hub create \
  --name "Engineering Hub" \
  --out ./engineering-hub
```

This writes:

```text
engineering-hub/hub-config.yml
```

The command creates a skeleton, not a ready-to-publish Hub. Complete the
required `description` and `maintainer` fields before importing it.

To pre-populate a local source, pass its filesystem path:

```bash
ai-primitives-hub hub create \
  --name "Engineering Hub" \
  --out ./engineering-hub \
  --add-source ../engineering-collections
```

`--add-source` currently creates a `type: local` source whose `url` is the
resolved filesystem path. Review that generated source and add its required
`enabled` and `priority` fields. Add GitHub and other source types manually.

You can also create `hub-config.yml` manually.

## 2. Add Required Metadata and a Source

This is a minimal practical configuration:

```yaml
version: "1.0.0"

metadata:
  name: "Engineering Hub"
  description: "Approved AI primitive collections for engineering teams"
  maintainer: "Developer Experience Team"
  updatedAt: "2026-08-16T00:00:00Z" # Replace with the current ISO 8601 timestamp

sources:
  - id: "engineering-collections"
    type: "github"
    repository: "my-organization/engineering-collections"
    enabled: true
    priority: 100
    config:
      branch: "main"

profiles: []
```

Update `metadata.updatedAt` whenever you publish a meaningful Hub change.
Use a timestamp in ISO 8601 format.

The current Hub schema accepts these source types:

- `github`
- `local`
- `awesome-copilot`
- `local-awesome-copilot`
- `apm`
- `local-apm`
- `skills`

See [Hub Schema](../reference/hub-schema.md) for every field and constraint.
Source support elsewhere in the product does not automatically mean that the
same type is accepted inside a Hub configuration; the Hub schema is the
authority for Hub source types.

## 3. Add Profiles When Useful

A profile groups collections from one or more sources:

```yaml
profiles:
  - id: "backend-developer"
    name: "Backend Developer"
    description: "Shared collections for backend API development"
    icon: "🖥️"
    bundles:
      - id: "api-design"
        version: "latest"
        source: "engineering-collections"
        required: true
      - id: "python-testing"
        version: "1.2.0"
        source: "engineering-collections"
        required: false
    path:
      - "engineering"
      - "backend"
```

Each bundle's `source` must match a source ID in the same Hub. The bundle ID
and requested version must exist in that source when users synchronize and
activate the profile.

The schema accepts any string for `icon`. The extension's profile picker and
tree use emoji, so the examples use emoji for consistent rendering.

Pin a specific semantic version for stable or production profiles whose
contents should change only through a reviewed Hub update. Use `latest` when
following the newest available collection is intentional, such as during
development. A Hub sync alone does not update an already installed collection.

Use `required: true` for collections that define the profile's expected base
environment. Use optional entries for additions users may choose not to
install.

For maintenance of an existing Hub, see
[Adding Profiles and Sources to Existing Hubs](./adding-profile-source-to-hub.md).

## 4. Validate Locally

Import the file as a local Hub. A local reference must point to the YAML file,
not only its directory:

```bash
ai-primitives-hub hub add \
  --type local \
  --location ./engineering-hub/hub-config.yml \
  --id engineering-hub \
  --no-use \
  --no-sync
```

Then inspect the saved entry:

```bash
ai-primitives-hub hub list
```

After testing, remove that imported entry if it is no longer needed:

```bash
ai-primitives-hub hub remove engineering-hub
```

The current CLI import runs the shared runtime checks, including required
metadata, basic source shape, path traversal, and profile source references.
It does not currently apply the full Hub JSON Schema.

In the VS Code extension, run **AI Primitives Hub: Import Hub** and select the
local `hub-config.yml` file. The extension applies JSON Schema and runtime
validation. Use this path for full schema validation and fix all errors before
publishing.

Validation confirms the configuration shape. Also test behavior:

- Every enabled source is reachable by the intended users.
- Collection IDs and versions referenced by profiles exist.
- Private repositories are accessible through the supported authentication
  flow.
- Activating a profile installs only the expected collections.
- Source priorities produce the intended result when sources overlap.

## 5. Publish on GitHub

For a GitHub Hub reference, `hub-config.yml` must be at the repository root.
The default branch/ref is `main`.

```text
engineering-hub/
├── README.md
└── hub-config.yml
```

Here, `engineering-hub/` represents the root of its own GitHub repository.
Do not publish `hub-config.yml` inside another nested subdirectory of that
repository.

Commit and push the configuration:

```bash
git add hub-config.yml README.md
git commit -m "Create engineering AI primitives Hub"
git push origin main
```

Add a repository README that states:

- The Hub's audience and purpose
- Its maintainers
- How changes are reviewed
- How users import it
- How users report unavailable sources or broken profiles

## 6. Import the Published Hub

Using the CLI:

```bash
ai-primitives-hub hub add \
  --type github \
  --location my-organization/engineering-hub \
  --ref main
```

By default, the CLI imports the Hub, makes it active, and synchronizes it.
Use `--no-use` or `--no-sync` when those automatic actions are not wanted.

Using the extension:

1. Open the Command Palette (`Ctrl+Shift+P` on Windows/Linux or
   `Cmd+Shift+P` on macOS).
2. Run **AI Primitives Hub: Import Hub**.
3. Choose the GitHub or URL option.
4. Enter the repository or direct HTTPS reference requested by the dialog.
5. Confirm that the expected sources and profiles appear.

## 7. Maintain the Hub

For each change:

1. Edit `hub-config.yml` through a reviewed pull request.
2. Update `metadata.updatedAt`.
3. Validate the changed file locally.
4. Verify referenced sources, collection IDs, and versions.
5. Merge and notify users when the change affects active profiles.

Users can fetch the latest configuration with:

```bash
ai-primitives-hub hub sync engineering-hub
```

or by using **Sync Hub** in the extension. Hub synchronization refreshes the
Hub configuration and its source catalog. Bundle update behavior is managed
separately. For an already active profile, Hub sync can expose added, removed,
or version-changed bundle references, but it does not automatically install,
remove, or update those collections. **Sync Profile** accepts the updated
profile definition, but it also does not install bundles. Users manage bundle
installation, updates, and removal through their separate commands.

## Troubleshooting

### GitHub Hub cannot be imported

- Confirm that `hub-config.yml` is at the repository root.
- Confirm the repository is written as `owner/repository`.
- Pass `--ref` if the file is not on `main`.
- For a private repository, verify the user's GitHub authentication can read
  it.

### Local Hub reports file not found

Pass the complete file path:

```text
./engineering-hub/hub-config.yml
```

Do not pass only `./engineering-hub`.

### Configuration validation fails

- Fill every required metadata field with a non-empty value.
- Give each source an `id`, supported `type`, `enabled`, and `priority`.
- Keep IDs unique.
- Ensure every profile bundle references a source defined in the Hub.
- Use semantic versions or `latest` for profile bundle versions.

## See Also

- [Profiles and Hubs](../user-guide/profiles-and-hubs.md) — User operations
- [Hub Schema](../reference/hub-schema.md) — Complete field reference
- [Adding Profiles and Sources to Existing Hubs](./adding-profile-source-to-hub.md)
- [Creating Collections](./creating-source-bundle.md)
- [Publishing Collections](./publishing.md)
