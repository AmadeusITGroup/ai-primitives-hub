# Validating Collections

Validate your collection files before publishing to catch errors early.

## Hub governance (CLI)

Run `ai-primitives-hub hub validate --governance -o json` to validate the hub
with an error-based verdict. Errors fail; warnings do not. Add `--report-path
hub-report.md` to write the same findings as Markdown, or `--policy policy.yml`
to select a policy instead of the discovered `hub-governance.yml`.

HUB001 validates hub syntax, schema, references and source policies and cannot
be disabled or downgraded. HUB002 reports advisories and can be disabled or
changed to an error. CFG001–CFG003 reject invalid YAML/schema, unknown rule IDs,
and attempts to weaken mandatory rules. Invalid policy is ignored and fails the run.
See the [rule catalogue](./rule-catalogue.md).

Validation is offline by default. `--check-sources` explicitly contacts enabled
sources and resolves profile references; it does not validate collection or
primitive content. Existing validation without governance flags is unchanged.

For PR scope, add `--base-ref <commit> --head-ref <commit>` (exact 40- or
64-character hexadecimal commit IDs). Git mode reads both the default policy
and an explicit `--policy` from the merge base, so a PR cannot relax its own gate.
Explicit paths must resolve within the repository and exist at the merge base;
missing or outside-repository policies fail with CFG001. Without Git refs,
including scope-file mode, policies are read from the working tree.
Alternatively use `--scope-file scope.json`
with `schemaVersion: 1`, `sourceIds` and `profileIds` arrays. Both scoped modes
require `--governance`; automatic GitHub App setup is not supported there.
Scoped source checks support remote github, awesome-copilot and skills sources
only and never execute local/APM code. `--verbose` sends redacted progress to stderr.

No consumer workflow is installed. The existing skill validator remains unchanged.

## CLI governance validation

Run `ai-primitives-hub collection validate --governance` for collection rule IDs,
an error-based verdict and a Markdown report. `--policy <path>` or `--report-path
<path>` also enables governance. Without these flags, legacy validation is unchanged.
Use `--root <dir>` to select a repository and repeat `--collection-file <path>`
to select collections. `--markdown-path` remains supported, including with governance.

COL001 requires unique IDs and names; COL003 requires authors; COL005 checks structure
and referenced files; COL006 reports advisories. Empty collection selections fail.
COL001, COL002 and COL005 are mandatory; configurable overrides and reasons remain
visible in reports. Any error (including unverified errors) or report-write failure
fails the command; warnings alone pass. Reports have no scores.

### Source checks

`--check-releases --repository owner/repo` enables COL002 and checks published
non-draft, non-prerelease releases with a standalone deployment manifest and ZIP or
TAR.GZ asset. `--check-sources [--config hub-config.yml]` enables COL004, comparing
candidate collection IDs with the authoritative `.config/sources/collection-index.yml`,
relative to the directory containing the selected hub config. COL004 does not scan
other sources or contact their APIs.
Supply `--repository owner/repo` to identify the candidate's source; it must match
exactly one enabled source URL in that config. Same-source updates pass; another
source's registered ID or an unregistered ID fails. An unresolved source identity,
missing index, invalid schema, duplicate YAML keys, or unknown source reference
is an unverified error, never an empty registry or a fallback to remote scanning.
Unrequested checks are shown as **Not run**.
Hub validation does not run collection rules.

#### Central collection registry

Maintain the hub config and its index in the same config registry repository.
Place the index at `.config/sources/collection-index.yml` relative to the directory
containing the selected hub config:

```yaml
# .config/sources/collection-index.yml
schemaVersion: 1
collections:
  python-tools:
    sourceId: developer-tools
  snow-explorer:
    sourceId: servicenow-tools
```

`schemaVersion` is the number `1`, not a string. `collections` is a mapping
keyed by canonical collection ID, not a list or runtime bundle ID. Each value
contains only `sourceId`, referencing a source declared in the selected hub config.
Use `collections: {}` for an empty registry. Keep keys alphabetically ordered for
reviewable diffs; lookup speed does not depend on file ordering.

The index is parsed once per run into an in-memory map: loading is O(n), with
average O(1) ownership lookups for each candidate. One file supports thousands
of registrations without fetching thousands of source catalogs. Disabled sources
retain their ID reservations; deleting a collection does not automatically release
its ID. Deregistration and ownership transfers require explicit registry review.

For source-repository PRs, CI must check out the **trusted config registry at a
pinned commit**, outside the PR checkout, and pass its hub config with `--config`.
Do not let the source PR supply or rewrite its own authoritative registry.
For config-registry PRs, an in-repository config and its index at
`.config/sources/collection-index.yml` relative to the config's directory are read
from the exact `--head-ref`, ignoring uncommitted changes. Protect those registry
changes with review and validate against the latest base before merging (or use
a merge queue); parallel registrations can otherwise race. Periodic reconciliation
with source repositories can detect drift, but is separate from this fast gate.

### PR validation

Add `--base-ref <commit> --head-ref <commit>` to validate collections whose manifest,
README or referenced item changed. Full Git history and the PR head checkout are
required. Both default and explicit policies are read from the merge base;
missing explicit policies or paths outside the repository fail with CFG001.
Repository-local uniqueness (COL001) still uses every collection as context.
COL004 checks the selected candidates against the full central registry. Enabled GitHub sources
added or modified in the hub config are downloaded from their configured branch;
their collections are validated, with source-qualified paths in the report. Source
download failures block validation. `--check-releases` checks their publication.
Unchanged sources and non-GitHub source types are not downloaded in this mode.
Collection finding paths and PR scope paths use forward slashes on every platform,
including Windows, so changed-file filtering and reports use the same paths.
Deleted referenced files also select their collections for validation. Skills track
both the declared entry file and files within their directory, so deleting the
entry file still reports COL005 even when supporting files remain.

### Governance configuration (`hub-governance.yml`)

The repository-root policy is discovered automatically; `--policy <path>` replaces
it. Each `rules` entry can specify `enabled`, `severity` and an explanatory `reason`.
CFG001 rejects unreadable or malformed YAML/schema, CFG002 rejects unknown or
non-configurable rule IDs, and CFG003 rejects disabling or downgrading floor rules.
Invalid configuration fails the run and its overrides are ignored.

### External workflow consumption

External consumers invoke the CLI, consume structured output (`-o json|yaml|ndjson`),
and preserve its exit status when publishing `--report-path` Markdown. Exit code 0
means pass; 1 means validation or report writing failed. Credentials, publication,
PR comments and merge gating belong to the consumer. No governance workflow or
action integration is shipped; the collection-validation action remains unchanged.

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
