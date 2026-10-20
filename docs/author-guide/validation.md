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

## CLI Governance Validation

The existing `ai-primitives-hub collection validate` command also supports opt-in governance. `--governance` enables rule IDs, a pass/fail verdict, a 0–100 score, and provider Markdown reporting. Supplying `--policy`, `--min-score`, or `--report-path` also enables governance. Without these options, existing validation and output are unchanged.

| Option | Behavior |
| --- | --- |
| `--policy <path>` | Use this governance configuration instead of `hub-governance.yml`; a missing or invalid file fails. |
| `--min-score <number>` | Enforce a 0–100 score floor, overriding policy `minScore`. |
| `--report-path <path>` | Write the provider Markdown report. |
| `--markdown-path <path>` | Existing Markdown output; a provider report destination when governance is enabled. |
| `--collection-file <path>` | Select a collection; can be repeated. Omit for repository-wide duplicate checks. |
| `--check-releases` | Opt into `COL002` release verification and governance; contacts GitHub. |
| `--repository <owner/repo>` | GitHub repository (or URL) for release verification; does not enable network checks on its own. |
| `-o, --output <format>` | Text, JSON, YAML, or NDJSON. JSON/YAML reports are in `data`; NDJSON emits the report directly. |

Governance reuses the existing schema, file-reference, and duplicate checks, requires a non-empty author, and rejects an empty collection set. Errors always fail. The score starts at 100, loses 10 per verified error and 3 per verified warning, and is advisory unless a minimum is configured. Unverified findings do not reduce the score. Floor rules cannot be disabled or downgraded; overrides and their reasons remain visible in reports. A report-write failure also fails the command. Offline runs list the network rules they did not run (`COL002`, and `COL004` for hubs) under **Not checked**, with no score weight.

Every rule, its default severity and whether it can be configured is listed in the generated [rule catalogue](./rule-catalogue.md).

The configuration, score, and report options are also available on `ai-primitives-hub hub validate` and `ai-primitives-hub skill validate`. Governance stays offline unless explicitly requested. Hub `--governance --check-sources` enables `COL002` and `COL004` (canonical collection IDs across enabled sources). Skill governance rejects an empty skills directory.

### Running the validations

Each level is its own command. Run it on a path, or add `--base-ref`/`--head-ref` (exact commit SHAs) to validate only what a PR changed. PR mode needs full Git history (`fetch-depth: 0`); collection and primitive PR mode also need the PR head checked out.

| Level | Whole repository or path | Only what a PR changed |
| --- | --- | --- |
| Hub | `hub validate --governance [--config hub-config.yml]` | `hub validate --governance --base-ref <base> --head-ref <head> [--check-sources]` |
| Collection | `collection validate --governance [--root <dir>] [--collection-file <file>...]` | `collection validate --base-ref <base> --head-ref <head> [--root <dir>]` |
| Primitive | `primitive validate <file-or-dir>...` | `primitive validate [<dir>...] --base-ref <base> --head-ref <head>` |

In collection PR mode, a collection is validated when the PR changes its `.collection.yml`, its README or any item it references; uniqueness is still checked against every collection. In primitive PR mode, changed primitive files are validated, and a change anywhere in a skill folder re-validates its `SKILL.md`. The report's **PR scope** section lists what was validated.

### Governance configuration (`hub-governance.yml`)

A `hub-governance.yml` at the repository root is applied automatically to governance runs; `--policy <path>` replaces it. For PR-scoped hub runs (`--base-ref`/`--head-ref`) the file is read from the PR's merge base, so a PR cannot relax its own gate. The schema is `packages/core/src/public/schemas/hub-governance.schema.json`.

```yaml
minScore: 80            # optional; fail below this score
rules:
  COL003:
    enabled: false
    reason: Legacy collections without authors   # shown in every report
  AGT001:
    severity: error
```

| Rule | Raised when |
| --- | --- |
| `CFG001` | The file is not valid YAML or does not match the schema. |
| `CFG002` | A rule id is unknown, or the rule is not configurable (CFG rules). |
| `CFG003` | A floor rule (for example `COL001`, `COL002`) is disabled or downgraded. |
| `CFG004` | `minScore` or `--min-score` is not a number between 0 and 100. |

Any CFG finding fails the run and the rest of the configuration is ignored for that run.

### Primitive validation

`ai-primitives-hub primitive validate <path>...` checks skills, agents, prompts, instructions and MCP server definitions. Paths can be files or directories (searched recursively). The kind comes from the file name (`SKILL.md`, `*.agent.md`, `*.prompt.md`, `*.instructions.md`, `mcp.json`, `*.mcp.json`); use `--kind` to override it. It accepts `--policy`, `--min-score`, `--report-path` and `-o`.

| Rule | Checks |
| --- | --- |
| `SKL001` | Agent Skills specification: frontmatter, `name` matches the folder, `description` length. Error. |
| `AGT001` | `*.agent.md`, frontmatter with a non-empty `description`, `tools` as a list of strings. |
| `PRM001` | `*.prompt.md`, frontmatter with a non-empty `description`, a valid `agent` or `mode` (`ask`, `edit`, `agent`). |
| `INS001` | `*.instructions.md`, frontmatter `applyTo` as a relative glob or list of globs. |
| `MCP001` | JSON with servers under `servers` or `mcpServers`, each with a `command` or `url`, string-valued `env`/`headers`, and every `${input:id}` declared in `inputs`. |
| `MCP002` | No literal secrets in `env`, `headers` or `args`; use `${input:...}` or `${env:...}`. |

`AGT001`, `PRM001`, `INS001`, `MCP001` and `MCP002` are new and report as warnings; they will become errors in a later release. Each level is its own command: `hub validate` does not run collection or primitive rules. Its report shows Hub validation plus the two hub-wide collection checks (`COL002` published release, `COL004` ID unique across the hub), which need `--check-sources`.

For Hub source governance, add `--verbose` to see per-source inventory progress and timestamped GitHub request, retry, and backoff events on stderr. Diagnostics show source IDs, hostnames, request categories, attempts, and statuses, but omit URLs, credentials, response bodies, and signed query parameters. JSON stdout remains machine-readable. Without `--verbose`, these progress diagnostics are not emitted.

Each HTTP request has a deadline (20 seconds by default, including redirects and the full response body); transport errors are retried with backoff. When evidence still cannot be read, source governance records it as unverified, with the reason, rather than treating the source as empty. These changes require a CLI release containing them, not the earlier published CLI 0.1.0.

For PR-scoped hub runs, the sources a PR changed are read in full; every other enabled source is read only for its collection IDs (one release per tag family, for example `my-collection-v1.2.0` and `my-collection-v1.1.0` share `my-collection`). Sources are read eight at a time, and the whole hub-wide read has a five-minute limit; sources still unread at the limit are reported as unverified rather than leaving the job hanging.

### Source checks

For `COL002`, use collection `--check-releases --repository owner/repo`. A published release must be neither a draft nor a prerelease and must include a standalone deployment manifest declaring the collection identity/version and a ZIP or TAR.GZ archive asset. Every release page is inspected; a matching published release establishes existence, not compliance with every requested version.

For `COL004`, Hub `--governance --check-sources` compares raw collection IDs from Awesome Copilot definitions and canonical IDs from GitHub release manifests. Multiple versions within one source do not collide; matching IDs across different enabled sources do. Non-collection sources (skills, APM, local deployment bundles, Azure DevOps bundles) are excluded from this collection inventory. Unreadable or malformed inventory data is not treated as empty success.

Unavailable release evidence or incomplete inventories produce unverified errors: the gate fails without a score penalty. Local-only collection definitions without a verifiable GitHub publication target cannot pass requested release verification. Run remote checks in a separate approved/authenticated job for private sources; never provide source credentials to untrusted fork input.

## Existing GitHub Action

The existing `github-actions/validate-collections` action keeps its previous behavior when invoked without governance inputs. Enable governance with `governance: 'true'`, or supply `policy-path`, `min-score`, or `report-path`. Optional `collection-file` selects one collection in governance mode. The action exposes `verdict`, `score`, and `exit-code`, writes a job summary, and fails after reporting a failing result. It does not post PR comments.

To enable `COL002` in this action, set `check-releases: 'true'` and `repository: owner/repo`. An optional explicit `source-token` is used only for that requested check; ambient `GITHUB_TOKEN`/`GH_TOKEN` values are not inherited. The reusable workflow also accepts Hub `check-sources`, collection `check-releases`/`repository`, and an optional guarded `source-token` secret.

Use a provider release/immutable commit containing these additions; earlier releases do not support them. See [provider governance](https://github.com/AmadeusITGroup/ai-primitives-hub/blob/main/.github/scripts/hub-governance/README.md) for policy rules, standard CLI workflow steps, release requirements, and optional PR comment reporting. The reusable workflow invokes the standard CLI directly; there is no separate custom governance action.

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
