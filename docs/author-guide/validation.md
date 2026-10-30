# Validating Collections

Validate your collection files before publishing to catch errors early.

## Quick Validation

Open the Command Palette (`Ctrl+Shift+P` on Windows/Linux or `Cmd+Shift+P` on
macOS) and run **AI Primitives Hub: Validate Collections**.

Validates all `.collection.yml` files in your `collections/` directory, including:
- Schema validation (required fields, formats)
- File reference checking (all referenced files exist)
- Duplicate detection (no duplicate IDs or names across collections)

From a terminal, run `ai-primitives-hub collection validate` in the repository
root (or `--collection-file collections/<id>.collection.yml` for one file).
The CLI also checks plugin manifests, described in [Plugin Manifests](#plugin-manifests),
and that each item's kind fits its path, described in [Kind and Path](#kind-and-path).

## What Gets Validated

| Check | Description |
|-------|-------------|
| Required fields | `id`, `name`, `description`, `items` |
| ID format | Lowercase letters, numbers, hyphens only |
| Item paths | Valid relative paths |
| Item kinds | One of the kinds listed in the [collection schema](./collection-schema.md#item-kinds), such as `prompt`, `instruction`, `agent`, `skill` or `plugin` |
| File references | Referenced files exist |
| Duplicate IDs | No two collections share the same ID |
| Duplicate names | No two collections share the same name |
| Plugin manifests | `kind: plugin` items point to the plugin's root `plugin.json`, which passes the Agent Plugins 1.0.0 checks (CLI `collection validate` and `bundle build`) |
| Kind and path | An item's `kind` matches the kind of the install folder its path is under (CLI `collection validate`, warning only) |

## Plugin Manifests

`ai-primitives-hub collection validate` checks every `kind: plugin` item against the
[Agent Plugins 1.0.0 specification](https://agent-plugins.org/specification). The item
path must be the plugin's root manifest, for example `plugins/my-plugin/plugin.json`:
the directory that contains `plugin.json` is the plugin, and the whole directory is
bundled. A plugin scaffolded with `ai-primitives-hub plugin create` passes these checks; see
[Plugin Items](./collection-schema.md#plugin-items).

These problems are **errors** and fail validation:

- The item path does not end in `plugin.json`, or `plugin.json` sits at the repository root.
- `plugin.json` is not a readable file, is not valid JSON, or is not a JSON object.
- `$schema` is missing or is not exactly `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`.
- `name` is missing, or is not 1–64 characters of lowercase letters, digits, `.` and `-`
  that start and end with a letter or digit and contain no `--` or `..`.
- `author` is not an object with optional string fields `name`, `email` and `url`.
- `version`, `description`, `homepage`, `repository` or `license` is not a string, or
  `keywords` is not an array of strings.
- `name` differs from the plugin directory name. This is an AI Primitives Hub packaging
  rule rather than a spec requirement: the plugin is bundled and installed under its
  directory name, so the two must agree.

These problems are **warnings** and don't fail validation, because clients ignore them:

- Top-level fields the specification doesn't define (put client-specific data under `extensions`).
- `extensions` that is not an object, or an `extensions` entry that is not an object.

Skills and `mcp.json` inside a plugin are not validated yet.

### Plugin Checks in `bundle build`

`ai-primitives-hub bundle build` runs the same checks, with the same messages, before it
packages anything. It checks the **committed** revision, because that is what the bundle
contains (it checks the working tree only when it falls back to a legacy bundle because
no license file is committed):

- An error stops the build with `error[PLUGIN.INVALID_MANIFEST]`, lists every plugin
  error, and writes no ZIP or `deployment-manifest.yml`.
- Warnings are reported and the bundle is built.

Fixes you have not committed are not seen. Commit `plugin.json` and rebuild, or run
`collection validate` to check the working tree first.

## Experimental APH/APM Bundle Layout

The CLI can build a single-copy dual-manifest ZIP without editing the collection:

```bash
ai-primitives-hub bundle build \
  --collection-file collections/example.collection.yml \
  --version 1.0.0 --layout apm
```

The default remains `--layout aph`. Governed builds still use the committed
revision; the existing missing-license fallback still uses the working tree and
reports its warning. `bundle manifest` alone retains its existing layout; use the
manifests emitted by `bundle build --layout apm` with the corresponding ZIP.

The APM layout contains two root manifests and one `.apm/` container:

```text
deployment-manifest.yml
apm.yml
.apm/
  agents/
  instructions/
  prompts/
  skills/
  LICENSE
  README.md
  metadata/source/
```

Only files the original release plan carries are included. License, README and
source evidence above apply to governed builds; legacy builds do not invent that
evidence. Payload bytes, executable modes and skill directory resources are
preserved. Existing `.github/` and `.apm/` prefixes are normalized, not nested;
collisions stop the build. Governed item/projection paths, README/provenance
references and the complete SHA-256 inventory match the new archive. A legacy
README supplied only as an external release asset retains that external reference.

APM `name` uses the collection ID, not its display name. Version, description,
author, license, repository and tags project into APM fields. The supported
`x-aph` extension retains the display name and all APH metadata, including item
details, environments, provenance and inventory. Its inventory excludes
`apm.yml` itself to avoid a circular content hash; the authoritative deployment
manifest inventories that file as metadata with its actual size and digest.
Dependency/MCP declarations remain in APH metadata and are not fabricated as
APM dependencies; the build warns when native translation is unavailable.
More complete metadata increases archive size even without duplicate payloads.

APH requires a companion root `apm.yml` to be valid YAML with the same package
name/collection ID and version. Governed archives must inventory it as `metadata`;
unlisted, tampered or installable-role companions are rejected. It is not
passed to target writers, while unexpected nested files remain subject to normal
unsupported-content checks.

Qualified native compatibility starts with flat `prompts/*.prompt.md`,
`instructions/*.instructions.md`, `agents/*.agent.md` and
`skills/<name>/SKILL.md`, including skill resources and their `.github/` or
`.apm/` source forms. APH-supported nested paths are kept, not flattened or
dropped. Native APM 0.35.0 silently omits nested instructions and prompts;
the builder warns about those paths, noncanonical locations, deeper skill roots
and untranslated dependencies/MCP, while preserving APH manifest-driven placement.
Warnings produce status `warning` and exit 0 so authors can choose their native
APM strategy without breaking their existing APH distribution. Legacy chatmodes
are also retained, with a warning when their path or filename does not match
native APM agent discovery. Other primitive kinds, empty collections and path
collisions still fail explicitly with
`BUNDLE.APM_UNSUPPORTED_CONTENT` in this initial opt-in mode.
Cross-directory links affected by prefix normalization need separate
qualification; this mode does not rewrite primitive content.

The investigation compares APH installation outputs for VS Code Copilot,
Copilot CLI, Kiro and Kiro CLI with the default archive, including existing
rejection behavior. APM 0.35.0 local dependency installation on the Copilot
target retains all four primitive types and binary skill resources for the
qualified flat fixtures; nested instruction/prompt omissions are recorded as
limitations rather than claimed as native compatibility. That is not qualification of native
Artifactory registry resolution, every target, extension UI workflows or
update/replay/uninstall. APM's default Copilot compilation can intentionally
omit `AGENTS.md` when installed instructions already cover it; a forced
instruction compilation is used separately to verify compiled content.

## Kind and Path

Most targets install a file by the folder it sits in, not by its declared `kind`:
a file under `prompts/` installs as a prompt, a file under `plugins/` as part of a
plugin, a file under `.kiro/steering/` as steering. `ai-primitives-hub collection validate`
warns when an item's `kind` differs from the kind of the folder its path matches:

```text
warning: collections/my.collection.yml: items[0] plugins/my-plugin/skills/review/SKILL.md: kind "skill" differs from the kind "plugin" of the install route "plugins/" that this path matches
```

The item is still valid, but on those targets it is not installed as the kind you
declared. Move the file to the folder of its kind (for a skill, `skills/<name>/SKILL.md`)
or declare the kind of the folder it is in. Paths outside every known install folder
are not checked. The check is not run for an invalid `kind`, which is already an error.

## Common Errors

**Missing required field**
→ Add the missing `id`, `name`, `description`, or `items` field

**Invalid ID format**
→ Use only lowercase letters, numbers, and hyphens (e.g., `my-collection`)

**Invalid item kind**
→ Use one of the kinds listed in the [collection schema](./collection-schema.md#item-kinds)

**File not found**
→ Check that the path in `items[].path` points to an existing file

**Duplicate collection ID**
→ Each collection must have a unique ID across the repository

**Duplicate collection name**
→ Each collection must have a unique name across the repository

**Plugin item path must point to the plugin's root plugin.json**
→ Set `items[].path` to `plugins/<name>/plugin.json`, not to the directory or another file

**Plugin: missing required field "$schema"**
→ Add `"$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"` to `plugin.json`

**Plugin: "name" must be 1-64 characters …**
→ Use a lowercase name such as `my-plugin` or `acme.tools`

**Plugin: "author" must be an object**
→ Replace `"author": "Jane"` with `"author": { "name": "Jane" }`

**Plugin name "…" must match its directory "…"**
→ Rename the plugin directory or the `name` field so they are equal, and keep
`plugin.json` directly in the plugin directory

**Plugin: unknown top-level field "…" is ignored** (warning)
→ Remove the field or move client-specific data under `extensions`

**kind "…" differs from the kind "…" of the install route "…"** (warning)
→ Move the file under the folder of its declared kind, or change `kind` to match its folder; see [Kind and Path](#kind-and-path)

## See Also

- [Collection Schema](./collection-schema.md) — Full YAML reference
- [Creating Collections](./creating-source-bundle.md) — Getting started
