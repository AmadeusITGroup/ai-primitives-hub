# Validating Collections

Validate your collection files before publishing to catch errors early.

## Quick Validation

Open the Command Palette (`Ctrl+Shift+P` on Windows/Linux or `Cmd+Shift+P` on
macOS) and run **AI Primitives Hub: Validate Collections**.

From a terminal, run `ai-primitives-hub collection validate` in the repository
root (or `--collection-file collections/<id>.collection.yml` for one file).

Both run the same checks on every `.collection.yml` file in your `collections/`
directory and print the same messages:
- The published [collection schema](./collection-schema.md), in full; see [Schema Rules](#schema-rules)
- File references (all referenced files exist)
- Duplicate IDs and names across collections
- Agent Plugin manifests of `kind: plugin` items; see [Plugin Manifests](#plugin-manifests)
- Whether each item's kind fits its path (warning); see [Kind and Path](#kind-and-path)

The command palette command writes its report to the **Collection Validator**
output channel. Duplicate IDs and names are listed under **Cross-collection errors**.
Earlier extension releases also warned about a missing `version` or `author`, a
description over 300 characters, and empty or large collections; those warnings
are no longer reported.

## What Gets Validated

| Check | Description |
|-------|-------------|
| Required fields | `id`, `name`, `description`, `items` |
| Unknown properties | Fields the [collection schema](./collection-schema.md) does not define, at the root, in items, `mcp`, `mcp.items` servers, `mcp.inputs` and `display`, are warnings |
| ID format | Lowercase letters, numbers, hyphens only |
| Lengths | `id` and `name` at most 100 characters, `description` at most 500 |
| Item paths | Valid relative paths |
| Item kinds | One of the kinds listed in the [collection schema](./collection-schema.md#item-kinds), such as `prompt`, `instruction`, `agent`, `skill` or `plugin` |
| Field types and values | Strings, booleans and string lists where the schema requires them, and the allowed values of `mcp` server `type`, `mcp.inputs` `type` and `display.ordering` |
| MCP servers | Server names use letters, digits, `_` and `-`; a `stdio` server (or one without `type`) needs `command`; an `http` or `sse` server needs `url` |
| Tags | Each tag is a string; more than 10 tags or a tag over 30 characters is a warning |
| File references | Referenced files exist |
| Duplicate IDs | No two collections share the same ID |
| Duplicate names | No two collections share the same name |
| Plugin manifests | `kind: plugin` items point to the plugin's root `plugin.json`, which passes the Agent Plugins 1.0.0 checks (also run by `bundle build`) |
| Kind and path | An item's `kind` matches the kind of the install folder its path is under (warning only) |

## Schema Rules

Collection validation enforces `collection.schema.json` as published.
Every schema violation except an unknown property is an **error**:

- A missing or empty `id`, `name` or `description`, a missing `items` or one that is not a
  list, or a missing item `path` or `kind`. An empty list (`items: []`, as `collection create`
  writes it) is valid.
- An `id` or `name` over 100 characters, or a `description` over 500 characters. Lengths
  count characters (Unicode code points), as the schema does. The number of items is not
  limited.
- A `version` that is not a string in `X.Y.Z` form; an empty `version:` key is an error.
- A field of the wrong type: `author`, item `title` / `description`, server `command` /
  `envFile` / `url`, input `description` / `default`, `display.color` / `icon` must be
  strings; `disabled`, `password` and `show_badge` must be booleans; `tags`, item `tags`,
  server `args` and input `options` must be lists of strings; server `env` and `headers`
  must map names to strings.
- An `mcp.items` server name or an `mcp.inputs` `id` other than letters, digits, `_` and `-`.
- A server `type` other than `stdio`, `http` or `sse`, an input `type` other than
  `promptString`, `pickString` or `command`, or a `display.ordering` other than
  `manual` or `alphabetical`.
- A `stdio` server, or one without `type`, without `command`; an `http` or `sse` server without `url`.

These are **warnings** and don't fail validation:

- A property the schema does not define, at the root, in an item, in `mcp`, in an
  `mcp.items` server, in an `mcp.inputs` entry or in `display`. The warning names the
  property, where it is, and the properties allowed there:

  ```text
  warning: collections/my.collection.yml: items[0]: unknown property 'name' is not in the collection schema; remove it or rename it to one of: path, kind, title, description, tags
  ```

  An `mcp.items` server name with other characters than letters, digits, `_` and `-` is
  still an error (see above).
- More than 10 tags, and a tag longer than 30 characters.

Item kinds are matched case-insensitively (`Prompt` is accepted as `prompt`), and unknown
properties are warnings: these are the two places where validation is more lenient than
the schema. The published schema still does not allow unknown fields, so editors that
validate YAML against `collection.schema.json` flag them. So does the Visual Collection
Editor, which reports them as errors and does not submit a pull request until they are
removed.

### Stricter Validation

Earlier releases of `collection validate` checked only `id`, `name`, `version`, `readme`
and item `path` / `kind`. Collections that break another schema rule now fail in both the
CLI and the command palette command, most often a missing `description`, a `name` over
100 or a `description` over 500 characters, or a field of the wrong type or value.

Fields the schema does not define, such as the root `mcpServers` and `license` some older
collections still have or an item `name`, are reported as warnings and the collection
stays valid. Move MCP servers under `mcp.items`, rename an item `name` to `title`, and
remove `license` (governed bundles take their license from the repository's
`package.json` and license file).

`ai-primitives-hub bundle build` does not run these schema checks; it checks plugin
manifests only (see [Plugin Checks in `bundle build`](#plugin-checks-in-bundle-build)).
Run `collection validate` before building.

## Plugin Manifests

Collection validation checks every `kind: plugin` item against the
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

## Kind and Path

Most targets install a file by the folder it sits in, not by its declared `kind`:
a file under `prompts/` installs as a prompt, a file under `plugins/` as part of a
plugin, a file under `.kiro/steering/` as steering. Collection validation
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

**unknown property '…' is not in the collection schema** (warning)
→ Remove the field or rename it to one of the listed properties, for example an item `name`
to `title`; see [Collection Schema](./collection-schema.md) for the allowed fields

**name / description must be at most … characters**
→ Shorten the field to 100 (`name`) or 500 (`description`) characters

**mcp.items.…: Missing required field: command / url**
→ Give a `stdio` server (or one without `type`) a `command`, and an `http` or `sse` server a `url`

**More than 10 tags (recommended max)** / **tags[…] is longer than 30 characters** (warning)
→ Keep a few short tags

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
