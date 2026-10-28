# ADR-0009: Primitive Install Categories and Per-Target Plugin Semantics

**Status:** Accepted

## Context

The collection schema accepts 17 primitive kinds
(`packages/core/src/public/schemas/collection.schema.json`, mirrored by
`PRIMITIVE_KINDS` in `packages/core/src/domain/primitive/types.ts`): `prompt`,
`instruction`, `chat-mode`, `agent`, `skill`, `plugin`, `hook`, `mcp-server`,
`steering`, `spec`, `command`, `rule`, `output-style`, `tool`, `power`,
`knowledge`, `playbook`. How each kind is packaged and installed is encoded
per kind, in several places that disagree:

- Packaging treats only `skill` and `plugin` as directory units (a
  `skill`/`plugin` kind check in
  `packages/core/src/domain/collection/release-manifest-plan.ts`, three times:
  file collection, id derivation and the directory check). A Kiro `power` is
  therefore archived as one file of two and gets the id `POWER`, so two powers
  collide.
- User-scope install (`writeBundleSafely`,
  `packages/app/src/install/target-write.ts`, used by CLI `install`,
  `update` and `profile activate` since #526) has two placement paths that
  disagree on kind. Manifest items of the five `CopilotFileType`s (`prompt`,
  `instructions`, `chatmode`, `agent`, `skill`) go through
  `FileTreeTargetWriter.writeManifestItems`
  (`packages/app/src/writers/file-tree-writer.ts`): the item's type selects
  the route through `KIND_TO_ROUTE_KEY`, and files are renamed by item id.
  Every other bundle file, including every `plugin`, `hook`, `power` and
  `steering` file, goes through `FileTreeTargetWriter.write`, which has no
  notion of kind: the file is routed by its bundle path prefix through the
  layout's `kindRoutes` (`packages/infra/src/writers/default-layouts.json`).
- Manifest placement (`writeManifestItems`, also used by the extension's
  repository scope) knows only those five `CopilotFileType`s.
- Copilot-like repository scope (`RepositoryScopeWriter`,
  `packages/infra/src/writers/repo-scope-writer.ts`) has a hard-coded
  `getSubdirectory` switch and two copies of the same directory installer
  (`installSkillItem`, `installPluginItem`).
- Nothing in `packages/` merges configuration. `resolveMcpLayoutConfig`
  (`packages/app/src/install/layout-resolver.ts`) is exported but has no CLI
  caller. The only MCP writer is the extension's `McpServerManager`
  (`apps/vscode-extension/src/services/mcp-server-manager.ts`), which prefixes
  server names per bundle and tracks what it wrote.
- There is no support matrix. "Kind K is supported on target T" today means
  "the layout has a route for K's bundle path" (`FileTreeTargetWriter.preflight`)
  or "`getSubdirectory` returns non-null".

Running every kind on every target and scope at `be1d161` (20 bundles × 11
targets × 2 scopes) gives this picture. Plugins install on 10 of 11 targets, but
only as inert copies under `<base>/plugins/<id>/`. In all 60 plugin installs no
skill was projected, no MCP server reached a target config, no harness
registry was written, and `${PLUGIN_ROOT}` stayed unresolved. `mcp-server`
installs nowhere. `kiro` rejects `plugin` and `hook` because it has no route.
No `PLUGIN_ROOT` or `PLUGIN_DATA` handling exists in `packages/*/src` or
`apps/vscode-extension/src`.

On PR #497 the maintainer proposed grouping kinds into generic categories
(file-based, folder-based, configuration-based) so that each kind relies on a
shared flow and customises only what differs ([PR #497 comment][pr497]). This
ADR records that model, the per-target plugin semantics it needs, and the
migration from today's per-kind code.

Constraints carried in from earlier decisions and from #277:

- The legacy `.github/plugin/plugin.json` layout is not supported. A plugin is
  a directory whose root holds `plugin.json`. APH also requires `name` to
  equal the directory name, because the plugin is bundled and installed
  under that name. This is an APH packaging rule, stricter than the Agent
  Plugins spec, which does not tie `name` to the directory (enforced by
  `validateAgentPluginItem`,
  `packages/core/src/domain/plugin/agent-plugin-spec.ts`).
- Install stays all-or-nothing by default. Partial install is opt-in only
  (`install --skip-unsupported`, #550).
- `lib/` is deprecated and out of scope. Only `packages/` and the two
  deliveries matter.
- The VS Code extension is in scope of #277 but is migrated late, after the
  CLI and `packages/` layers are stable.

## Decision drivers

1. **Adding a kind must be cheap.** A new kind should be one data row plus,
   at most, a kind-specific extension, not a change in four writers.
2. **One behaviour per shape.** Install, uninstall and verify for "a file", "a
   directory" and "entries merged into a config file" should each exist once.
3. **Harness knowledge is data.** Paths and per-target differences already live
   in `default-layouts.json` and user/project layout overrides. Category
   differences per target should live there too.
4. **Plugins must be usable, not inert.** Whatever lands on disk must be read
   by the harness, with `${PLUGIN_ROOT}` resolved.
5. **Claims about harnesses must be evidenced.** Many harness behaviours are
   undocumented. The model must default to the safe option and let a target
   opt into richer behaviour with data once there is evidence.
6. **Layering holds.** Dependencies point inward (`CLI` and `Extension` →
   `app` → `infra` → `core`, ADR-0001). The extension gains no business rules.

## Alternatives considered

- **A. Per-kind fixes.** Keep coding each kind in each writer and fix the gaps
  one by one (kiro routes, power packaging, MCP merge, plugin projection).
  Smallest first step. Rejected: it adds a fifth and sixth copy of the
  directory rule and a separate config merge per kind (`mcp-server`, plugin
  `mcp.json`, config-based hooks). Every new kind and every new target
  repeats the work, which is the debt #497 targets.
- **B. Pure install categories.** Every kind maps to exactly one category and
  every category behaves identically on every target. Rejected: `hook` is a
  standalone file on Copilot and Kiro but an entry in `settings.json` on Claude
  Code and in `hooks.json` on Cursor (see the target table). A plugin is a
  directory, but making it usable needs projection that no other directory
  kind has.
- **C. Hybrid: categories as defaults, with per-target overrides and kind
  extensions.** Each kind has a default category (data, in `core`). A target's
  layout may override the category for a kind (data, in `infra`). A kind may
  add a kind-specific step on top of its category's shared behaviour (code, in
  `app`), for example plugin projection. A target's layout may also name a
  target adaptation for a kind (an `infra` adapter) for formats no category
  expresses (decision 8). **Chosen.**

## Decision

Follow-up work is named by the step labels of the
[migration plan](#migration-plan) (M1 to M9).

1. **Three install categories, each with one shared behaviour.**

   | category | unit | identity | install | uninstall | verify |
   |---|---|---|---|---|---|
   | `file` | one file | as today: the manifest item id for the five `CopilotFileType`s (file renamed `{id}.{ext}`), else the file name | route the file through the layout's `kindRoutes` and write it | remove the recorded file (the lockfile's `installedPath` when the file was renamed) | byte re-read (`verifyWrittenBytes`) |
   | `directory` | the item's directory, `dirname(item.path)`, with every file below it | the directory name | route the whole tree under one destination directory | remove exactly the recorded destination directory | byte re-read of every file |
   | `config` | entries merged into a target config file | prefixed entry name, recorded at install | read, merge, write the target file; foreign entries are preserved | remove only the entries this install recorded; keep the file | each recorded entry is present with the written value |

   All three share preflight (route or config present for the target and
   scope, no conflicting destination), rollback on failure, and the existing
   all-or-nothing default. Directory destinations are compared as whole path
   segments, so `plugins/foo` never captures `plugins/foo-extra` (the repository-scope writer's
   prefix mismatch is closed by construction). File modes from the archive are applied in the
   shared file write (M3), so `file` and `directory` kinds both get
   them.

   `config` ownership is recorded in the install record, the
   `LockfileBundleEntry` that both scopes already write (repository
   `prompt-registry.lock.json` / `prompt-registry.local.lock.json`, and the
   user-scope lockfile from `lockfilePathForTarget`,
   `packages/cli/src/framework/target.ts`). M4 adds an optional
   `configEntries: [{ path, key, name }]` to `bundleEntry` in
   `packages/core/src/public/schemas/lockfile.schema.json`. It is written
   only when an entry owns config entries, so lockfiles of bundles without
   MCP stay byte-identical, and the lockfile name and shape stay as ADR-0004
   requires. `bundleEntry` is `additionalProperties: false`; the extension's
   `LockfileManager.validate()` checks against that schema but has no
   production caller at `4d3b0ed`, so released extensions are not affected.
   Until VS Code parity, an extension rewrite of the same entry may drop the
   field. Uninstall then falls back to matching the bundle segment of the
   owned names in either name form (decision 5), which is stable
   per bundle. VS Code parity (#551) switches `McpServerManager`
   tracking to `configEntries`.

2. **Kind → category is data in `core`, with per-target overrides in layout
   data.**

   | kind | default category | notes |
   |---|---|---|
   | `prompt` | `file` | |
   | `instruction` | `file` | |
   | `chat-mode` | `file` | |
   | `agent` | `file` | Kiro's agent file format differs; that is a content concern, not a category one |
   | `skill` | `directory` | `skills/<name>/SKILL.md` plus any files ([Agent Plugins spec §7.1][spec]) |
   | `plugin` | `directory` + plugin extension | see decisions 5 and 6 |
   | `hook` | `file` | plus a target adaptation on targets whose hooks live in a settings file (decision 8) |
   | `mcp-server` | `config` | merged into the target's MCP config |
   | `steering` | `file` | |
   | `spec` | `file` | a Kiro spec is a folder ([Kiro specs][kiro-specs]); moving it to `directory` is open (O14) |
   | `command` | `file` | |
   | `rule` | `file` | |
   | `output-style` | `file` | |
   | `tool` | `file` | |
   | `power` | `directory` | answers O6 (decision 9) |
   | `knowledge` | `file` | |
   | `playbook` | `file` | |

   Collection-level `mcpServers` (not a kind) use the `config` category too.
   A target layout may declare a per-kind category override next to
   `kindRoutes`. The resolved category for (kind, target, scope) is the
   override if present, else the default.

3. **Support is derived from data, not maintained by hand.** Routing stays
   as today: by item type through `KIND_TO_ROUTE_KEY` for manifest items of
   the five `CopilotFileType`s (#526), and by bundle path prefix for every
   other file. The kind of a route is `routeKindOf(prefix)`: today's
   `routeToKind` and `ROUTE_PREFIX_KINDS`
   (`packages/app/src/writers/file-tree-writer.ts`), moved to `core` as data
   beside the kind → category table. Its `.devin/*` entries match no
   built-in `kindRoutes` key, so no built-in layout uses them; only an
   injected custom layout with `.devin/*` source prefixes could. M1 moves
   them unchanged, and removing them (after checking custom layouts) is a
   follow-up outside M1. Both placement paths end on a
   `kindRoutes` key, so the derivation below covers both. Then:

   - Kind K is supported on (target, scope) when the resolved
     layout has at least one `kindRoutes` key with `routeKindOf(key) = K`
     (for `file` and `directory`), or when the resolved `config` requirement
     is met (an MCP config), plus any kind-extension requirement (decision 6)
     and, when the layout declares a target adaptation for K, an
     implementation of that adaptation id (decision 8). At repository scope
     two more inputs apply (decision 5, O10): the install's commit mode, and
     whether the target MCP config file is already tracked by git. Both are
     known before preflight, so `preflight` and the doctor evaluate the same
     inputs and give the same answer for the same repository.
   - A bundle file's kind is the kind of the route it matches, which is what
     `preflight` and `allowedKinds` filtering already use. A file that
     matches no route is unsupported.
   - A manifest item whose declared kind differs from the kind of the route
     its path matches is routed as today and reported as a warning by
     `collection validate` (M1) and by `doctor diagnostics --primitives`
     once #548 adds it. Rejecting it would make bundles that install
     today fail, so that is not decided here.

   The per-kind category override in a layout (decision 2) is keyed by kind
   and applies to every route of that kind. This is chosen
   over a hand-maintained support matrix, which would drift from the
   layouts. `preflight` and
   `doctor diagnostics --primitives` both use the same derivation.

4. **Directory identity has one rule.** The item id of a `directory` kind is
   the name of `dirname(item.path)`, and packaging collects every file under
   it. This rule is driven by the category, so `power` gets it by changing one
   data row, and future directory kinds get it for free. Install keeps that
   name: since #526, manifest placement writes a skill to
   `<skills route>/<normalised item id>/`, and the id `bundle build` writes
   is already the directory name.

5. **Plugins are projected on every target by default.** A plugin install
   means:

   - **Plugin root.** The whole plugin directory is installed through the
     `directory` category at the target's plugin route. This is the
     `PLUGIN_ROOT` that scripts and stdio servers run from. It is not a
     discovery location.
   - **Skills.** Each immediate child of the plugin's `skills/` directory is
     projected through the `directory` category into the target's skills route
     as `<skills route>/<skill>/`, unrenamed, because a skill's `name` must
     equal its directory name ([Agent Plugins spec §7.1][spec]).
   - **MCP.** The plugin's root `mcp.json` (used only when its `$schema`
     version equals `plugin.json`'s, [spec §10.1][spec]) is projected through
     the `config` category into the target's MCP config. Owned server names
     are built by one `core` helper from `bundleId`, an optional
     `pluginName` and `serverName`. The **form** of the name is part of the
     target's MCP dialect (decision 10):
     - The default form is the extension's existing rule,
       `generatePrefixedServerName`
       (`apps/vscode-extension/src/services/mcp-config-service.ts`), moved
       to `core`: `prompt-registry:<bundleId>:<serverName>` for
       collection `mcpServers` and `mcp-server` items. Plugin servers add
       one segment: `prompt-registry:<bundleId>:<pluginName>:<serverName>`. The `prompt-registry:` prefix is an existing machine
       identifier and stays (ADR-0004). This form is evidenced only on VS
       Code, the only target the extension writes to.
     - The default form is used only when no segment contains `:`. Then
       splitting the name on `:` gives back exactly its segments, and the
       segment count tells a plugin server from a collection or
       `mcp-server` one, so the name is reversible and distinct triples
       give distinct names. When `bundleId` or `serverName` contains `:`
       (`pluginName` cannot, the plugin schema rejects it), that one name
       uses the sanitised form below, on every target. Sanitised names
       start with `prompt-registry__`, so they never equal a default-form
       name. Names whose segments contain no `:` are exactly what the
       extension writes today, so existing entries stay recognisable.
     - Whether the other targets accept `:`, and names this long, as MCP
       server keys is UNVERIFIED. Several harnesses derive tool names
       from the server name, and tool-name rules commonly allow only
       `[A-Za-z0-9_-]` within a length limit (UNVERIFIED per target). M4
       re-checks each target. Where the default is not accepted, that
       target's dialect declares the sanitised form
       `prompt-registry__<bundleId>[__<pluginName>]__<serverName>`, with
       each segment encoded as below.
     - `bundleId` is the lockfile key, not the collection id: `manifest.id`
       or an Artifactory ref id (`packages/cli/src/commands/install.ts:1202`),
       where the deployment manifest only requires a non-empty string
       (`packages/core/src/public/schemas/deployment-manifest.schema.json:21-24`;
       lockfile `bundles` keys have no pattern), or `<owner>-<repo>[-<id>]`
       for replicated bundles (`packages/core/src/domain/hub/replicate.ts:33`).
       `pluginName` may contain `.`
       (`packages/core/src/public/schemas/agent-plugins/1.0.0/plugin.schema.json:16`), and plugin `mcp.json`
       server keys are unconstrained. The helper must therefore guarantee:
       only characters the target accepts; distinct (`bundleId`,
       `pluginName`, `serverName`) triples give distinct names, up to a hash
       collision; the same output in the CLI and the extension; and, in the
       sanitised form, a bundle segment that matches exactly one encoded
       `bundleId`. In the sanitised form each segment is lowercased, every
       character outside `[a-z0-9-]` becomes `-`, and a segment this changed,
       or one that already ends in `-` plus 8 hex characters, gets `-` plus
       the first 8 hex characters of the sha256 of the original segment. So
       an unchanged segment never looks like an encoded one, and two
       different segments encode alike only on a hash collision. Encoded
       segments contain no `_`, so `__` separates them without ambiguity.
       With the `:` rule above, both forms meet these guarantees for every
       triple. M4 fixes the exact algorithm against these invariants.
     - If the target has a length limit, the part after
       `prompt-registry__<encoded bundleId>__` is cut to fit and the name
       ends with `__` plus the first 8 hex characters of the sha256 of the
       full, uncut sanitised-form name, so it stays deterministic and
       distinct triples stay distinct up to a hash collision. If that prefix
       plus the 10-character `__<hash8>` suffix exceeds the limit, the item
       is unsupported on that target.
     - `config` preflight treats two equal owned names in one install as a
       conflicting destination and rejects the bundle.
     - Uninstall removes the names recorded in `configEntries`
       (decision 1). The fallback splits each name on its form's separator
       (`:` after `prompt-registry:`, `__` after `prompt-registry__`) and
       removes it only when its bundle segment equals this bundle's
       `bundleId` in that form: raw in the default form, encoded in the
       sanitised form. On a target whose dialect uses the default form it
       checks both forms, because a name with `:` in a segment is
       sanitised there. Entries an older extension wrote for a segment
       with `:` keep their old, ambiguous name. The fallback does not find
       them for their own bundle, and may match them for a bundle whose
       `bundleId` equals their text before the first `:`. They are removed
       through the extension's own tracking, and the fallback runs only
       when `configEntries` is missing, until VS Code parity (#551)
       switches the extension to `configEntries`. This residual case is
       accepted until parity.
     - The CLI and the extension call the same helper with the same
       dialect, so they write the same names on the same target.
   - **Placeholders.** APH expands `${PLUGIN_ROOT}` to the installed plugin
     root and `${PLUGIN_DATA}` to the plugin's data directory, single pass, in
     `args`, `env` values and `cwd` only, never in `command`, `url`, headers or
     `env` keys. It adds `PLUGIN_ROOT` and `PLUGIN_DATA` to each stdio server's
     `env`, defaults `cwd` to the plugin root, and resolves `./` commands
     against it ([spec §7.2.1, §9.1, §9.2][spec]). The expansion logic is
     pure and unit-tested against the spec's examples. `${env:VAR}`
     placeholders are never resolved at install: as for every MCP write,
     they are rewritten to the dialect's `envPlaceholderStyle` by
     `rewriteEnvPlaceholders`
     (`packages/core/src/domain/mcp/env-placeholders.ts`), so secrets do
     not reach disk.
   - **`PLUGIN_DATA`.** `AppStoragePaths`
     (`packages/core/src/ports/app-storage.ts`) gains `pluginData: string`.
     This extends the ADR-0005 port, and both adapters implement it:
     `<root>/plugin-data` in `XdgAppStorage`
     (`packages/infra/src/storage/xdg-app-storage.ts`) and in the extension's
     `VsCodeAppStorage`, each under its own root. A plugin's data directory
     is `<pluginData>/<scope>/<scopeKey>/<target>/<bundleId>/<pluginName>/`, where
     `scope` is `user` or `repository`, and `target` is the install
     target's `name` (`TargetBase.name`,
     `packages/core/src/domain/install/target.ts`, unique in the CLI
     configuration). The extension, which has no named targets, uses the
     type of the target it writes to. `target`, `bundleId` and `pluginName`
     use the sanitised-form segment encoding so each is one safe path
     segment. Installing the same plugin for two targets in the same scope
     therefore gives two data directories, and uninstalling it from one
     target leaves the other's data in place. Renaming a target leaves its
     old data directory behind. `scopeKey` is `user` for user scope.
     For repository scope it is the first 16 hex characters of the sha256 of
     the canonical repository root: its real path (symlinks resolved, in the
     on-disk casing), `\` replaced by `/`, no trailing `/`, no case folding.
     The on-disk casing matters on case-insensitive file systems, where
     Node's JavaScript `fs.realpath` keeps the caller's casing; the port's
     `realpath` is implemented with `fs.realpath.native`. One pure `core`
     helper computes it from the canonical path, beside `generateSourceId`
     (`packages/core/src/domain/source-id.ts`, which already hashes with
     sha256 and truncates). The real path comes from a `realpath` operation
     that M7 adds to the `FileSystem` port
     (`packages/core/src/ports/filesystem.ts`, which has none today),
     implemented in `infra`. Both deliveries call the same helper, so they
     compute the same key for the same repository. The directory has no
     version segment, so it survives updates, and no two targets, bundles,
     scopes or repositories share one. APH
     creates it before first use and uninstall from a target removes only
     that target's directory,
     which the spec permits ([spec §9.1][spec]).
   - **Other components.** Client-specific directories (`com.<vendor>.<client>/`,
     [spec §8][spec]) and any other content are carried verbatim inside the
     plugin root and not projected. Mapping them to target locations is a
     later, data-driven extension of projection.
   - **Repository scope (O10).** Plugin MCP is supported at repository
     scope. A stdio server always carries absolute, machine-specific paths:
     `PLUGIN_DATA` lives in `AppStorage`, outside the workspace, and is set
     in its `env`. So stdio plugin servers are written only in `local-only`
     commit mode, where the MCP config file is git-excluded. If that file is
     already tracked by git, exclusion cannot keep the entries out of
     commits, and the item is unsupported. In `commit` mode, a plugin with a
     stdio server is unsupported on that target (decision 6). Remote
     (`streamable-http`, `sse`) plugin servers carry no plugin paths and are
     written in both commit modes. Collection
     `mcpServers` and `mcp-server` items have no plugin paths, are not
     affected by this support rule, and stay supported at repository scope
     (for example on copilot-cli and vscode). They are declared in the
     manifest, not shipped as files, and are merged as entries into the one
     MCP config file every install shares.
   - **Shared MCP config file (known gap).** The exclusion follows today's
     extension behaviour: any `local-only` install excludes the whole file,
     and the exclusion is removed when no APH-managed entry remains
     (`McpServerManager`, `apps/vscode-extension/src/services/mcp-server-manager.ts`).
     Mixing commit modes in one file is not detected: `commit`-mode entries
     in a file that a `local-only` install excluded are never seen by git.
     This is recorded, not changed, by this ADR (O15).
   - **Uninstall** removes the projected skill directories, the projected MCP
     entries, the plugin root and that target's `PLUGIN_DATA`, each through
     its category.
   - **Limitations (accepted).**
     - MCP entries an older extension wrote for a `bundleId` containing `:`
       keep their ambiguous default-form name. The uninstall fallback can
       miss them for their own bundle and match them for a bundle whose
       `bundleId` equals their text before the first `:`. This lasts until
       VS Code parity (#551) switches the extension to `configEntries`. (A
       `:` only in `serverName` keeps the bundle segment intact, so the
       fallback still finds those entries.)
     - Distinct triples give distinct sanitised names only up to a hash
       collision: segments the encoding changes or that already look
       encoded, and cut names, are told apart only by 8 hex characters
       (32 bits) of sha256. `config` preflight rejects an install in which
       two owned names are equal.
     - On a target with a name length limit, an item is unsupported only when
       `prompt-registry__<encoded bundleId>__` plus the 10-character
       `__<hash8>` suffix exceeds the limit. Names longer than the limit
       whose prefix and suffix fit are cut as described above.
     - Per-target `PLUGIN_DATA` directories need no migration: nothing writes
       `PLUGIN_DATA` before M7. A renamed target leaves its old data directory
       behind, and the CLI and the extension keep separate directories
       (Consequences).

6. **The plugin extension's support rule is all-or-nothing per item.** A
   plugin is supported on a target, scope and commit mode only when every
   portable component it declares (skills, MCP) can be hosted there, including the
   repository-scope rule for stdio servers (decision 5). Otherwise the
   plugin item is unsupported, and the existing default applies: the bundle
   is rejected, or the item is skipped under the opt-in `--skip-unsupported`.
   APH never installs part of a plugin by default. A projected skill whose
   destination already exists and is not owned by the same install is a
   preflight conflict and rejects the install. APH does not namespace skills
   to avoid it (O12).

7. **Plugin mode is per-target layout data: `project` now; `native` and
   `register` later.** Each target layout carries a plugin mode:

   - `project`: decision 5. Default for all 11 targets.
   - `native`: place the plugin root in a directory the harness scans, and
     let the harness expand placeholders. A target may switch to `native`
     only when its documentation shows both a scanned directory that needs no
     registry step and placeholder expansion for the Agent Plugins format.
     No supported target meets both today (see the plugin semantics table).
   - `register`: install through the harness's own CLI or registry
     (`copilot plugin install`, `kiro-cli powers install`,
     `devin plugins install --local`, VS Code `chat.pluginLocations`).
     Deferred: it needs the harness binary, mutates harness-managed state that
     the APH lockfile does not track, and cannot run in the doctor sandbox.

   The plugin route must not resolve inside a directory the harness manages
   or scans with a different meaning. The default layouts keep today's
   `plugins/` routes except where that rule is broken or may be broken:

   - claude-code user: `~/.claude/plugins/` is Claude Code's managed plugin
     root, holding `cache/`, `data/` and `installed_plugins.json`
     ([Claude Code plugin loading][cc-loading]).
   - cursor user: `~/.cursor/plugins/local/` is Cursor's scanned local-plugin
     directory, so a plugin with id `local` would land in it
     ([Cursor plugins reference][cur-ref]).
   - opencode repository: `.opencode/plugins/` holds OpenCode's JavaScript
     plugin modules ([OpenCode plugins][oc-plugins]).
   - opencode user: OpenCode's documented global directory is
     `~/.config/opencode/`, with JS plugins in `~/.config/opencode/plugins/`
     ([OpenCode plugins][oc-plugins]). APH's opencode user `baseDir` is
     `${HOME}/.opencode`, so APH writes `~/.opencode/plugins/`. Whether
     OpenCode also reads `~/.opencode/` is UNVERIFIED. If it does, the
     route collides as at repository scope; if it does not, every opencode
     user-scope route is unread and the layout needs a `baseDir` fix. The
     route is moved either way, and M7 re-checks the `baseDir`.

   M7 moves these routes:

   | target, scope | today | after M7 |
   |---|---|---|
   | claude-code, user | `~/.claude/plugins/<id>/` | `~/.claude/ai-primitives-hub/plugins/<id>/` |
   | cursor, user | `~/.cursor/plugins/<id>/` | `~/.cursor/ai-primitives-hub/plugins/<id>/` |
   | opencode, user | `~/.opencode/plugins/<id>/` | `~/.opencode/ai-primitives-hub/plugins/<id>/` |
   | opencode, repository | `.opencode/plugins/<id>/` | `.opencode/ai-primitives-hub/plugins/<id>/` |

   The segment uses the new-artifact name `ai-primitives-hub` (ADR-0004). It
   is not dotted, because the base directory is already hidden and the
   folder holds installed content, not APH state. kiro gains a `plugins/`
   route (as kiro-cli has) so that projection has a plugin root there.

8. **Hooks stay `file` until a target adaptation is evidenced and
   implemented.** Claude Code reads hooks from `settings.json`
   ([Claude Code hooks][cc-hooks]), Cursor from `hooks.json`
   ([Cursor hooks][cur-hooks]), and Devin CLI from `.devin/hooks.v1.json`
   (the whole file is the hooks object) or a `hooks` key in
   `.devin/config.json` and `~/.config/devin/config.json`
   ([Devin CLI hooks][devin-hooks]). Windsurf reportedly uses `hooks.json`
   too (search snippet only, UNVERIFIED). Today APH copies hook files into
   the layout's `hooks/` route on those targets, which installs but is not
   read as hook configuration. This stays as is, so no bundle that installs
   today starts failing, and is recorded as a known gap. Hook content is not
   portable between harnesses ([spec §8][spec]); the author targets the
   harness.

   These formats keep hooks in per-event arrays inside a settings file, which
   the generic `config` category (named entries under one root key) does not
   express. Such targets use a **target adaptation**: a per-target,
   declarative post-install step.

   - **Data.** A layout may declare, next to `kindRoutes` and the per-kind
     category override, an adaptation id per kind (for example
     `hook: claude-settings-hooks`). No adaptation is declared by default.
   - **Order.** On install, the adaptation runs after the kind's category
     strategy, on what that strategy installed, inside the same preflight and
     rollback. On uninstall, it runs first, before the category strategy
     removes the files, so the uninstall fallback below can still read them.
   - **Code.** Each id names one adapter in `infra` behind a `core`
     `TargetAdaptation` port; `app` runs it. An id the build does not
     implement makes the kind unsupported there (decision 3).
   - **Ownership.** Every entry an adaptation writes is owned like a `config`
     entry: recorded in `configEntries` (decision 1) as `{ path, key, name }`,
     with `key` and `name` defined by the adapter (M8 fixes them per
     adapter), removed on uninstall with foreign entries kept, and verified.
   - **Uninstall fallback.** In the harness file, an adaptation entry (for
     example a per-event hook array element) carries no APH-owned name, so
     the `config` name fallback does not apply. When `configEntries` is
     missing (decision 1), the adapter derives the entries again from the
     files the category strategy installed for the bundle (the lockfile
     entry's `files`) and removes, for each derived entry, one entry exactly
     equal to it. Entries it
     cannot match, for example ones edited by hand, are left in place and
     reported, and verify reports them as unowned. If a file listed in
     `files` is already missing, the adapter reports it and does not guess
     the entries it would have produced. This lasts until VS Code
     parity (#551). M8 may add a per-adapter owner marker where the harness
     format allows one.

   M8 adds the hook adaptations for claude-code, cursor and devin-cli. devin
   and windsurf are in M8's scope too, but each is gated on a recorded check
   of the harness: whether Devin Desktop (`devin`) reads the Devin CLI hook
   files, and whether Windsurf reads `hooks.json`, are both UNVERIFIED.
   Without that record the target keeps `file`.
   Devin CLI also reads Claude Code `settings.json` hooks by default
   ([Devin CLI hooks][devin-hooks]), so a hook bundle installed for both
   claude-code and devin-cli may fire twice in Devin; M8 re-checks this and
   documents the behaviour.

   MCP enablement is a further candidate. Writing an entry into the MCP
   config file installs a server, but whether the server is enabled or
   started is decided by the harness, through state the file does not hold.
   How each harness stores that state, and whether APH should set it after
   install, is open (O15). Where it is settled, it uses this same mechanism
   for every MCP entry APH writes (collection `mcpServers`, `mcp-server`
   items and plugin MCP): it runs after the `config` strategy and is owned
   and reversed like any adaptation entry. Whether its id is declared per
   kind or on the MCP dialect is settled with O15.

9. **Kiro routes and power (O3, O6).**

   - **Hooks.** Add `hooks/` to the kiro layout at both scopes, as kiro-cli has.
     Kiro IDE 1.0 and CLI V3 share standalone `.kiro/hooks/*.json` files
     ([Kiro hooks][kiro-hooks], [IDE 1.0 hooks][kiro-hooks-v1]), and the
     configuration reference lists hooks at user and project scope
     ([Kiro configuration][kiro-config]). Whether the IDE, not only the CLI,
     reads `~/.kiro/hooks/` is UNVERIFIED; the CLI V3 migration guide
     documents it for the CLI ([CLI V3 hooks migration][kiro-hooks-cli]).
   - **Plugins.** On Kiro an Agent Plugin is a power, either `plugin.json`
     or legacy `POWER.md` ([Kiro powers][kiro-powers]), and powers are
     installed through a registry step ([power installation][kiro-powers-install]).
     kiro and kiro-cli plugins therefore use `project`: skills into
     `.kiro/skills/` or `~/.kiro/skills/` ([Kiro skills][kiro-skills]), MCP into
     `.kiro/settings/mcp.json` or `~/.kiro/settings/mcp.json` (layout data;
     UNVERIFIED against Kiro docs, re-checked by M4).
   - **Power** is a `directory` kind. Both formats are directories: Agent
     Plugins format with `plugin.json` ([Kiro powers][kiro-powers],
     [creating powers][kiro-powers-create]), and legacy `POWER.md` with
     `mcp.json`, `steering/` and `hooks/` in real powers
     ([unleash-kiro-power][unleash]). Kiro lists powers at user scope only,
     `~/.kiro/powers/`, with no project scope ([Kiro configuration][kiro-config]).
     So the kiro and kiro-cli repository layouts drop their `powers/` route,
     and `power` is unsupported at repository scope on Kiro. Whether a power
     placed in `~/.kiro/powers/<name>/` loads without `kiro-cli powers install`
     is UNVERIFIED (O3a). Devin's `powers/` routes (`.devin/powers/` at both
     scopes, kept by #598) are unchanged; Devin has no documented power
     concept (UNVERIFIED) and M2 re-checks them.

10. **Each piece lives in one layer.**

    | piece | layer | anchor |
    |---|---|---|
    | `InstallCategory` (`file`, `directory`, `config`), the kind → category table, `categoryOf(kind)` | `core` | beside `PRIMITIVE_KINDS` in `packages/core/src/domain/primitive/`, or a new `packages/core/src/domain/install/category.ts` |
    | directory identity and packaging rule from the category | `core` | replaces the `skill`/`plugin` checks in `release-manifest-plan.ts` |
    | layout types: per-kind category override, per-kind target adaptation id, plugin mode, MCP dialect (path, root key, server shape, input support, env-placeholder style, server-name form) and their validation | `core` | `packages/core/src/domain/install/layout.ts` (`ScopedLayoutDef`, `McpLayoutConfig`) |
    | support derivation (decision 3) | `core` | pure function over the resolved layout and, at repository scope, the commit mode and the tracked state of the MCP config file (queried by `app` through the exclusion port) |
    | Agent Plugins MCP translation and placeholder expansion; config-entry ownership model | `core` | `packages/core/src/domain/plugin/`, `packages/core/src/domain/mcp/` |
    | ports: config file read/merge/write, file modes, `TargetAdaptation` | `core` | `packages/core/src/ports/` (`filesystem.ts`, `target-writer.ts`) |
    | named target adaptation adapters (decision 8) | `infra` | `packages/infra/src/` |
    | default layout data: routes, overrides, plugin modes, MCP dialects | `infra` | `packages/infra/src/writers/default-layouts.json` |
    | JSON and JSONC config adapter, Node file modes | `infra` | `packages/infra/src/` |
    | the three category strategies (preflight, write, rollback, remove, verify), the plugin extension composing them, running a declared target adaptation after them, `installMcpServers` | `app` | `packages/app/src/install/`, `packages/app/src/writers/file-tree-writer.ts` |
    | `routeKindOf` and `ROUTE_PREFIX_KINDS` (route prefix → kind data) | `core` | moved from `packages/app/src/writers/file-tree-writer.ts` |
    | owned MCP server names (`generatePrefixedServerName`), default form and sanitised form with per-segment encoding, selected by the dialect, sanitised whenever a segment contains `:` | `core` | moved from `apps/vscode-extension/src/services/mcp-config-service.ts` |
    | `AppStoragePaths.pluginData` | `core` port, `infra` and extension adapters | `packages/core/src/ports/app-storage.ts` (ADR-0005) |
    | `scopeKey` helper (sha256 of the canonical repository root, 16 hex) | `core` | beside `packages/core/src/domain/source-id.ts` |
    | `realpath` on the `FileSystem` port, returning the on-disk casing | `core` port, `infra` implementation (`fs.realpath.native`) | `packages/core/src/ports/filesystem.ts` |
    | `PLUGIN_DATA` directory per target and plugin | `app`, via the `AppStorage` port | decision 5 |
    | `configEntries` in the lockfile entry | `core` schema and types, written by `app` | `lockfile.schema.json`, `packages/app/src/stores/json-lockfile-store.ts` |
    | repository-scope exclusion port (`.git/info/exclude` section, and whether a path is already tracked, for O10) | `core` port, `infra` implementation | `RepositoryExclusion` (`packages/core/src/ports/repository-exclusion.ts`, since M1) gains a tracked-path query in M7; `GitInfoExclude` in `infra` implements it |
    | writer selection, flags, output | `cli` | `packages/cli/src/commands/install.ts` (`createWriterFactory`) |

    `RepositoryScopeWriter` lives in `infra` and cannot call `app`. It first
    uses the `core` category helpers to collapse its duplicated branches. Its
    placement logic is then retired in favour of the `app` strategies.
    Repository-specific behaviour is not moved to a delivery layer: git
    exclusion becomes a `core` port with an `infra` implementation (today's
    `.git/info/exclude` section management), and commit mode keeps selecting
    the lockfile file (`getLockfilePathForMode`). The `app` install and
    uninstall pipelines call both for repository scope. The CLI only selects
    the scope and passes flags, so the extension reaches the same behaviour
    through `app` (decision 11).

11. **The VS Code extension consumes the model through `app` (ADR-0001).**
    The extension already calls `FileTreeTargetWriter.writeManifestItems` for
    repository scope and `app` MCP helpers. In the late VS Code parity step (#551), its
    user and repository scope services and `McpServerManager` delegate to the
    `app` category strategies and plugin extension, the same entry points the
    CLI uses. Services gain no business rules. The extension resolves
    `PLUGIN_DATA` through its own `AppStorage` adapter (ADR-0005), and keeps
    its identifiers (`AmadeusITGroup.prompt-registry`, `promptregistry.*`,
    `prompt-registry.lock.json`) unchanged (ADR-0004). This ADR designs no
    extension code.

### Target × category behaviour

Paths are from `default-layouts.json` (user / repository). ✅ supported,
❌ unsupported (rejected by default, skippable with `--skip-unsupported`).
"Today" means the behaviour measured at `be1d161` (see Context).
#526 later moved the five `CopilotFileType`s to manifest placement, which
uses the same `kindRoutes`; the only cell it changes is `chat-mode` on
copilot-cli, now placed through the `agents/` route.
#598 later moved the devin and devin-cli routes and MCP paths to where Devin
reads them; their row shows the layouts after #598.
A cell without "→" is today's status and does not change. A cell with a
change this ADR decides reads "today → after the step", for example
`❌ today → ✅ M4`. No `config` cell is written before M4, so every MCP cell
is ❌ today, and `✅ M4` there is subject to M4's re-check described below
the table. At repository scope after M7, a plugin with a stdio MCP server
is ✅ only in `local-only` commit mode on targets with a repository-scope
MCP config (not windsurf) that git does not already track, and ❌ in
`commit` mode (O10, decision 5).

| target | `file` | `directory` | `config` (MCP) | plugin | `hook` |
|---|---|---|---|---|---|
| vscode, vscode-insiders | ✅ `~/.copilot/` / `.github/` | ✅ skills | ❌ today → ✅ M4: `${vscodeUserDir}/mcp.json` / `.vscode/mcp.json`, key `servers` | ✅ today as an inert copy → ✅ M7 `project` | ✅ `file`, `hooks/` |
| copilot-cli | ✅ (`chat-mode` placed through `agents/` since #526) | ✅ skills | ❌ today → ✅ M4: `~/.copilot/mcp-config.json` / `.mcp.json` | ✅ today as an inert copy → ✅ M7 `project` | ✅ `file`, `hooks/` ([Copilot CLI config dir][cop-config]) |
| kiro | ✅ incl. `steering`, `spec` | ✅ skills; `power` ✅ today as a single file (see Context) → M2: ✅ directory at user scope, ❌ at repository scope | ❌ today → ✅ M4: `~/.kiro/settings/mcp.json` / `.kiro/settings/mcp.json` | ❌ today, no route → ✅ M7 `project`, `plugins/` route added in M2 | ❌ today, no route → ✅ M2 `file`, `hooks/` both scopes |
| kiro-cli | ✅ incl. `steering`, `spec` | ✅ skills; `power` ✅ today as a single file → M2: ✅ directory at user scope, ❌ at repository scope | ❌ today → ✅ M4, as kiro | ✅ today as an inert copy → ✅ M7 `project` | ✅ `file`, `hooks/` |
| windsurf | ✅ | ✅ skills | user: ❌ today → ✅ M4 `~/.codeium/windsurf/mcp_config.json`; repository: ❌, no MCP config | ✅ today as an inert copy → ✅ M7 `project` | ✅ `file`; adaptation (`hooks.json`) UNVERIFIED |
| claude-code | ✅ incl. `command`, `output-style` | ✅ skills | ❌ today → ✅ M4: `~/.claude.json` / `.mcp.json` | ✅ today as an inert copy → ✅ M7 `project`, user plugin route moved | ✅ `file` today, not read as hooks → M8 adaptation (`settings.json`) |
| cursor | ✅ incl. `rule` | ✅ skills | ❌ today → ✅ M4: `~/.cursor/mcp.json` / `.cursor/mcp.json` | ✅ today as an inert copy → ✅ M7 `project`, user plugin route moved | ✅ `file` today, not read as hooks → M8 adaptation (`hooks.json`) |
| opencode | ✅ incl. `tool` | ✅ skills | ❌ today: the layout's `.opencode/mcp.json` / `mcpServers` does not match OpenCode's `opencode.json`, key `mcp`, server shape `type`, array `command`, `environment` ([OpenCode MCP][oc-mcp]) → ✅ M4 with that dialect | ✅ today as an inert copy into the JS plugin directory → ✅ M7 `project`, plugin route moved | ✅ `file`; whether OpenCode reads `hooks/` is UNVERIFIED |
| devin, devin-cli | ✅ incl. `knowledge`, `playbook`; `prompt` and `instruction` in `~/.devin/rules/` / `.devin/rules/` with `applyTo` rewritten to `trigger: glob` ([Devin rules][devin-rules]); `agent` and `chat-mode` in `~/.config/devin/agents/` / `.devin/agents/` ([Devin CLI extensibility][devin-ext]) | ✅ skills in `~/.config/devin/skills/` / `.devin/skills/` ([Devin CLI skills][devin-cli-skills]), `power` | ❌ today → ✅ M4: `~/.config/devin/mcp_config.json` / `.devin/mcp_config.json`, key `mcpServers` ([Devin MCP][devin-mcp]); the layout paths match since #598, but install writes no MCP config before M4 | ✅ today as an inert copy → ✅ M7 `project` | ✅ `file` today in `~/.devin/hooks/` / `.devin/hooks/`, not read as hooks ([Devin CLI hooks][devin-hooks]) → M8 adaptation on devin-cli; on devin after a recorded check (`~/.config/devin/config.json` / `.devin/hooks.v1.json`) |

✅ in `file` and `directory` means the listed routes exist. A kind with no
route on that target is ❌ (decision 3); for example `steering`, `rule` and
`command` have no route on vscode.

Paths without a link are APH's `default-layouts.json` values at `be1d161`; the
paths are unchanged on `4d3b0ed`. The devin and devin-cli paths are the
values after #598, each linked to the Devin page that documents it.
That the harness reads them is UNVERIFIED: this covers the MCP paths and
keys for vscode, copilot-cli, kiro, kiro-cli, windsurf, claude-code and
cursor; the skills routes on vscode, copilot-cli, claude-code and cursor;
and VS Code reading `~/.copilot/hooks/` and `.github/hooks/`. Kiro
skills ([Kiro skills][kiro-skills]) and windsurf skills, a legacy path that
still works ([Devin Desktop skills][devin-skills]), are documented. The step
that changes a cell re-checks it: M4 for `config`, M7 for skills
projection.

M4 has one outcome for every `config` cell: it writes only to a path
and dialect that are documented, or confirmed by a recorded manual check.
So it adds the opencode dialect. The devin paths need no fix, because #598
already moved both to the documented `mcp_config.json` files
([Devin MCP][devin-mcp]). A cell that is still UNVERIFIED when M4 lands is
set to unsupported in layout data, never written to a guessed path. The
same rule applies to the opencode dialect if the generic dialect model
cannot express it. Nothing regresses, because no `config` kind installs
anywhere before M4.

### Per-target plugin semantics

Baseline: a plugin is a directory with root `plugin.json`; portable v1
components are `skills/` and root `mcp.json`; install, enablement and
discovery are client-managed ([Agent Plugins spec §4–§7][spec]).

| target | native Agent Plugin support | documented discovery | `${PLUGIN_ROOT}` expanded by the harness | is APH's `<base>/plugins/<id>/` read? | mode |
|---|---|---|---|---|---|
| vscode, vscode-insiders | yes ([VS Code agent plugins][vsc-plugins]) | marketplace or install from source; Copilot CLI installs under `~/.copilot/installed-plugins/` ([VS Code agent plugins][vsc-plugins]); local paths via the experimental `chat.pluginLocations` setting, user settings only (third-party report, [vscode#303853][vsc-303853]) | not for the Agent Plugins format, per third-party reports ([vscode#336882][vsc-336882], [vscode#335006][vsc-335006]); current status UNVERIFIED | no, not a documented location | `project` |
| copilot-cli | yes ([Copilot CLI plugin reference][cop-plugins]) | `copilot plugin install`, into `~/.copilot/installed-plugins/` with CLI-managed metadata; no repository-scope plugin directory ([Copilot CLI config dir][cop-config]) | yes, plus `PLUGIN_ROOT` and `PLUGIN_DATA` in `env` ([Copilot CLI plugin reference][cop-plugins]) | no, `~/.copilot/plugins/` is not listed | `project`; `register` later |
| kiro, kiro-cli | yes, as a power ([Kiro powers][kiro-powers]) | power import or `kiro-cli powers install`, which updates a local registry ([power installation][kiro-powers-install]); user scope only ([Kiro configuration][kiro-config]) | UNVERIFIED, not mentioned in Kiro docs | no, `.kiro/plugins/` is not documented | `project`; `register` or `native` after O3a |
| claude-code | partial, per third-party reports: root `plugin.json` accepted, skills load, root `mcp.json` ignored ([claude-code#88906][cc-88906], [third-party measurement][cc-3p]); not in the compatible-clients list ([compatible clients][clients]) | managed cache and `installed_plugins.json` under `~/.claude/plugins/`, `--plugin-dir`, `CLAUDE_CODE_PLUGIN_DIRS`, or a plugin under a skills directory; project `.claude/plugins/` is not scanned ([Claude Code plugin loading][cc-loading]) | `${CLAUDE_PLUGIN_ROOT}` only ([Claude Code plugin loading][cc-loading]); `${PLUGIN_ROOT}` UNVERIFIED | no | `project` |
| cursor | yes ([Cursor plugins][cur-plugins]) | marketplace; local plugins in `~/.cursor/plugins/local/<name>/` after reload ([Cursor plugins reference][cur-ref]) | no, Cursor uses `${CURSOR_PLUGIN_ROOT}` ([Cursor plugins reference][cur-ref]) | no, only `plugins/local/` is documented | `project`; `native` is blocked by placeholder expansion |
| windsurf | no documented Cascade support ([Devin Desktop skills][devin-skills], by absence; not in [compatible clients][clients]) | n/a | n/a | no | `project` |
| opencode | no, OpenCode plugins are JavaScript modules ([OpenCode plugins][oc-plugins]) | n/a | n/a | the directory is OpenCode's JS plugin directory; whether OpenCode tolerates a non-JS directory there is UNVERIFIED | `project`, plugin route moved |
| devin-cli, devin | yes ([Devin CLI plugins][devin-plugins]) | `devin plugins install`, user level, `--local` links a folder; `.devin/plugins/` not documented ([Devin CLI plugins][devin-plugins]) | yes, with `PLUGIN_ROOT`/`PLUGIN_DATA` in `env` ([Devin CLI plugins][devin-plugins]) | no | `project`; `register` later. Since #598, APH gives `devin` (Devin Desktop, whose Devin Local agent shares the CLI harness) the same layout as `devin-cli`; whether Devin Desktop loads Agent Plugins as the CLI does is UNVERIFIED |

A native drop-in is safe only when the harness both scans a directory without a
registry step and expands the Agent Plugins placeholders. Cursor has the first
only; Copilot CLI and Devin CLI have the second only. So `project` is the
baseline everywhere.

### Open questions

- **O2 — which harnesses discover `<base>/plugins/<id>/`?** Answered: none of
  the 11 targets documents the directory APH writes today as an Agent Plugin
  location (plugin semantics table). On opencode, `.opencode/plugins/` is
  OpenCode's JavaScript plugin directory, so the route collides and moves
  (decision 7). Whether VS Code or Copilot pick up a directory placed by hand in
  `~/.copilot/installed-plugins/_direct/` without CLI metadata is UNVERIFIED;
  the docs say not to edit that state by hand ([Copilot CLI config dir][cop-config]).
- **O3 — kiro plugins and hooks.** Answered: hooks get a `hooks/` route at both
  scopes; plugins use `project` (decision 9). **O3a (open):** does a directory
  in `~/.kiro/powers/<name>/` load without the registry step? It needs a
  manual check before Kiro moves off `project`.
- **O6 — power as a directory unit?** Answered: yes, user scope only on Kiro
  (decision 9).
- **O10 — repository-scope plugin MCP with absolute paths.** Answered:
  supported, with stdio plugin servers written only in `local-only` commit
  mode (decision 5). Project-level MCP files are documented by the harnesses
  (for Copilot CLI, `.mcp.json` since
  [copilot-cli#1291][cop-1291]; [VS Code MCP configuration][vsc-mcp]). A
  workspace variable such as VS Code's or Cursor's `${workspaceFolder}`
  ([Cursor MCP][cur-mcp]) could express `PLUGIN_ROOT` in `args` and `env`
  (on Cursor, in `cwd` UNVERIFIED), but no dialect can
  express `PLUGIN_DATA`, which lives in `AppStorage` and must be an absolute
  path in each stdio server's `env` ([spec §9.1][spec]). So no stdio plugin
  server entry is safe to commit on any target. Per-dialect
  workspace-relative forms (a dialect attribute beside
  `envPlaceholderStyle`) were considered and rejected for that reason: they
  would make no stdio entry committable unless `PLUGIN_DATA` moved out of
  `AppStorage`, which decision 5 does not do.
- **O12 — projected skill name collisions.** Answered: a projected skill
  whose destination exists and is not owned by the same install is a
  preflight conflict. APH rejects the install and does not namespace the
  skill, because a skill's `name` must equal its directory name (decision 6).
- **O14 (open) — `spec` as a directory unit.** A Kiro spec is a folder
  holding `requirements.md` (or `bugfix.md`), `design.md` and `tasks.md`
  ([Kiro specs][kiro-specs]). `spec` stays `file` until the collection
  convention for spec folders is agreed, because applying the directory rule
  to a flat `specs/foo.md` would capture all of `specs/`.
- **O15 (open) — shared MCP config file and harness MCP state.** Two topics
  that no migration step owns yet. First, mixed commit modes in one
  repository MCP config file (decision 5, known gap): whether to detect
  them, and how.
  Second, MCP enable and disable, for every MCP entry APH writes, including
  collection `mcpServers`: per target, where the harness keeps that state
  outside the MCP config file (UNVERIFIED for every target), and whether a
  target adaptation (decision 8) should set it on install and clear it on
  uninstall.

The maintainers confirmed all decisions on 2026-10-28, including those
that change what installs where (decisions 6, 7 and 9, and the O10
repository-scope rule in decision 5) and what is written (decision 5's
sanitised owned names for segments with `:`, and per-target `PLUGIN_DATA`,
with the limitations listed there), and the target adaptations of
decision 8. O3a, O14 and O15, and the cells marked UNVERIFIED, stay open
research questions; the step that depends on each re-checks it.

## Consequences

- **Positive:** a new kind is one data row; a new directory or config kind
  reuses packaging, install, uninstall and verify unchanged.
- **Positive:** the repeated `skill`/`plugin` checks in the planner and the
  writers, and the two copies of the directory installer, collapse into one
  strategy. The repository-scope prefix mismatch and the power packaging
  bug are fixed by the same rule.
- **Positive:** plugins stop being inert copies: their skills go to the
  layout's skills route, their MCP servers to the layout's MCP config, and
  placeholders are resolved. Where those routes are only layout data, the
  harness reading them is UNVERIFIED until M4 and M7 re-check them.
- **Positive:** support is derived from the layouts, plus the commit mode
  and the tracked state of the MCP config file at repository scope, so the
  doctor, preflight and documentation cannot disagree with what install
  actually does.
- **Positive:** the CLI and the extension share one implementation once the
  extension delegates to `app`.
- **Negative:** projection duplicates work a native harness could do, and its
  output is invisible in the harness's own plugin UI. `native` and `register`
  remain follow-ups.
- **Negative:** the `config` category needs a per-target MCP dialect (path,
  root key, server shape, server-name form), not just `path`,
  `serversKey`, `supportsInputs` and `envPlaceholderStyle`. The opencode MCP data is wrong today
  (#598 already corrected the devin paths); M4 adds the opencode dialect and
  sets any still-unverified cell to unsupported. Owned server names may differ
  between targets (default or sanitised form), so tooling that looks for
  APH entries must use the recorded `configEntries`, not a single name
  pattern.
- **Negative:** a target adaptation is code per (target, kind), with its own
  adapter and tests. It is kept for formats the categories cannot express.
- **Negative:** `AppStoragePaths` and `lockfile.schema.json` each gain a
  field, which both deliveries must implement (ADR-0005 port, ADR-0004
  lockfile shared with the extension).
- **Negative:** `PLUGIN_DATA` lives in each client's `AppStorage`, so a plugin
  installed by the CLI and by the extension gets different data directories,
  and so does a plugin installed for two targets.
  Its MCP entries have the same names but different `PLUGIN_DATA` values.
- **Negative:** in `commit` mode, a repository-scope plugin with a stdio MCP
  server is unsupported (O10); it installs only in `local-only` mode, and
  only when git does not already track the target MCP config file.
  Repository-scope powers on Kiro become unsupported. Both installed before,
  as copies the harness did not read. Collection `mcpServers` and
  `mcp-server` items are not affected. Mixing commit modes in one MCP
  config file stays a known gap, as today: entries a `commit`-mode install
  writes into a file excluded by a `local-only` install are never seen by
  git (O15).
- **Unaffected:** all-or-nothing default and opt-in `--skip-unsupported`;
  the root-`plugin.json`-only rule (no legacy layout); bundle and manifest
  formats; the lockfile name and extension identifiers (ADR-0004); storage
  roots resolved through `AppStorage` (ADR-0005). Existing installs keep
  their recorded paths, so they uninstall cleanly after routes move.

## Migration plan

Each step is one small PR, keeps the default behaviour unless it says otherwise, and
removes its known-gap entries from `doctor diagnostics --primitives` once that
suite exists (#548). The labels in the step column (M1 to M9) are defined
here and used throughout this ADR. Steps that already have an
issue under [#277][i277] give its number; the others get one when they
start. O\* ids refer to the open questions above.

| order | step | content | depends on | value |
|---|---|---|---|---|
| 0 | **this ADR** (#549) `docs(adr)` | this ADR and its index row | — | an agreed contract |
| 1 | **M1** (#552) `refactor(core,app,infra)`: install categories, no install behaviour change | `InstallCategory`, the kind → category table with today's mapping (`power` still `file`), `categoryOf`; `routeKindOf` and `ROUTE_PREFIX_KINDS` moved to `core`; `KIND_TO_ROUTE_KEY` and `placeManifestItem`'s skill/file split (#526) expressed through the category, so manifest placement and path routing share one rule; the kind/route mismatch warning (decision 3) in `collection validate`, and in `doctor diagnostics --primitives` once #548 lands; the planner's directory rule and id rule from the category; `RepositoryScopeWriter`'s skill/plugin branches collapsed into one directory installer and its `.git/info/exclude` logic extracted behind the exclusion port; characterisation tests first | this ADR | later PRs change one place; adding a kind becomes a table row |
| 2 | **M2** `feat(core,infra)`: kiro routes and power as a directory unit | `power` → `directory` in the table; kiro `hooks/` and `plugins/` routes; kiro and kiro-cli repository `powers/` route removed; Devin `powers/` re-checked | M1 | hooks install on kiro; powers archive completely with unique ids |
| 3 | **M3** `fix`: file modes on install | modes applied in the shared file write, so every category gets them | #547; M1 preferred | installed scripts are executable |
| 4 | **M4** `feat(app,infra,cli)`: `config` category for MCP | MCP dialect in layout types and data: opencode dialect added, every `config` cell re-checked, including the server-name form, and still-unverified ones set to unsupported; JSON/JSONC adapter; `configEntries` in the lockfile entry; owned-name helper moved to `core` with the default form, the sanitised form with per-segment encoding, and the sanitised fallback for a segment with `:`; `installMcpServers` for collection `mcpServers`, ported from `McpServerManager` | M1 | collection MCP servers reach the target |
| 5 | **M5** `feat`: `mcp-server` items | items routed to the `config` strategy; support derived from the layout's MCP config | M4 | `mcp-server` installs wherever an MCP config exists |
| 6 | **M6** `feat(core)`: plugin metadata in the manifest | `version`, `author`, `license`, `keywords` on the plugin item; independent of categories, can run in parallel | — | plugin version visible to update checks |
| 7 | **M7** `feat(app)`: plugin projection | plugin extension (root, skills, MCP, placeholders, `PLUGIN_DATA`, uninstall); plugin mode `project` for all targets; plugin routes moved per decision 7 and opencode user `baseDir` re-checked; `AppStoragePaths.pluginData`; `scopeKey` helper in `core` and `realpath` on the `FileSystem` port; Copilot-like repository-scope placement moved from `RepositoryScopeWriter` to the `app` strategies; the O10 repository-scope rule (decision 5) and a tracked-path query on the exclusion port | M4, M3, M1, M2 (kiro only) | plugins are usable, not inert copies |
| 8 | **M8** (optional) `feat`: config-based hooks | `TargetAdaptation` port and its `infra` adapters; `hook` adaptations for claude-code, cursor and devin-cli, and for devin and windsurf each gated on a recorded check, all re-checked against the harness docs; re-check whether Devin also reads the claude-code adaptation's `settings.json` entries, and document the double-install behaviour | M4 | hooks fire on those targets |
| 9 | **M9** (optional, per target) `feat`: `native` or `register` mode | only with documentation or a recorded manual check for that target (for example O3a for Kiro) | M7 | the harness's own plugin UX where proven |
| late | **VS Code parity** (#551) | extension scope services and `McpServerManager` delegate to the `app` strategies (ADR-0001) | M4, M7 stable | the same files and lockfile entries from both deliveries |

Unaffected by this ADR: plugin validation in `bundle build` (#545), the
`plugin create` scaffold (#546), executable bits in archives (#547),
`doctor diagnostics --primitives` and its later cases (#548), and
`install --skip-unsupported` (#550). A separate fix for the repository-scope
prefix mismatch is subsumed by M1's directory strategy unless it lands
first as a quick fix.

## Related decisions

- [ADR-0001: Ports & Adapters Across the CLI and the VS Code Extension](./0001-ports-and-adapters-for-cli-and-extension.md)
- [ADR-0003: Primitive Index/Search/Harvest and Full Multi-Target Support In Scope](./0003-primitive-index-search-and-multi-target-in-scope.md)
- [ADR-0004: CLI-Only Rebrand — Keep Lockfile and Extension Identity Stable](./0004-cli-only-rebrand-keep-lockfile-and-extension-identity-stable.md)
- [ADR-0005: Universal, XDG-Based Application Storage Port](./0005-universal-xdg-based-app-storage.md)
- [ADR-0006: Shared Semantic Cache and Client-Owned State](./0006-shared-semantic-cache-and-client-owned-state.md)

## Sources

Harness documentation was read on 2026-10-19, the Devin CLI rules,
skills and extensibility pages on 2026-10-27, and the MCP configuration
and hooks pages cited for O10 and decision 8 on 2026-10-28. Entries marked as third-party
are reports, not vendor contracts.

- [Agent Plugins specification 1.0.0][spec]
- [Agent Plugins compatible clients, `lib/compatible-clients.ts` @ `f399975`][clients]
- [VS Code: agent plugins][vsc-plugins]
- Third-party: [microsoft/vscode#336882][vsc-336882], [#335006][vsc-335006], [#303853][vsc-303853]
- [GitHub Copilot CLI plugin reference][cop-plugins]; [configuration directory reference][cop-config]; [repository-level MCP, copilot-cli#1291][cop-1291]
- [VS Code: MCP configuration reference][vsc-mcp]
- [Claude Code: plugin loading][cc-loading]; [hooks][cc-hooks]
- Third-party: [anthropics/claude-code#88906][cc-88906]; [measurement on Claude Code 2.1.224][cc-3p]
- [Cursor: plugins][cur-plugins]; [plugins reference][cur-ref]; [hooks][cur-hooks]; [MCP][cur-mcp]
- Kiro: [powers][kiro-powers], [power installation][kiro-powers-install], [creating powers][kiro-powers-create], [hooks][kiro-hooks], [IDE 1.0 hooks][kiro-hooks-v1], [CLI V3 hooks migration][kiro-hooks-cli], [configuration][kiro-config], [skills][kiro-skills], [specs][kiro-specs]
- Legacy power example: [Unleash/unleash-kiro-power][unleash]
- OpenCode: [plugins][oc-plugins]; [MCP servers][oc-mcp]
- Devin: [CLI extensibility overview][devin-ext]; [CLI rules][devin-rules]; [CLI skills][devin-cli-skills]; [CLI plugins][devin-plugins]; [CLI MCP configuration][devin-mcp]; [CLI hooks][devin-hooks]; [Desktop (Windsurf) skills][devin-skills]
- [PR #497 maintainer comment][pr497]

[spec]: https://agent-plugins.org/specification
[clients]: https://github.com/agentplugins/agent-plugins-site/blob/f399975/lib/compatible-clients.ts
[i277]: https://github.com/AmadeusITGroup/ai-primitives-hub/issues/277
[vsc-plugins]: https://code.visualstudio.com/docs/copilot/customization/agent-plugins
[vsc-336882]: https://github.com/microsoft/vscode/issues/336882
[vsc-335006]: https://github.com/microsoft/vscode/issues/335006
[vsc-303853]: https://github.com/microsoft/vscode/issues/303853
[cop-plugins]: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference
[cop-config]: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference
[cop-1291]: https://github.com/github/copilot-cli/issues/1291
[vsc-mcp]: https://code.visualstudio.com/docs/agents/reference/mcp-configuration
[cc-loading]: https://code.claude.com/docs/en/plugins/loading
[cc-hooks]: https://code.claude.com/docs/en/hooks
[cc-88906]: https://github.com/anthropics/claude-code/issues/88906
[cc-3p]: https://startdebugging.net/2026/08/package-skills-and-an-mcp-server-as-one-agent-plugin/
[cur-plugins]: https://cursor.com/docs/plugins
[cur-ref]: https://cursor.com/docs/reference/plugins
[cur-hooks]: https://cursor.com/docs/agent/hooks
[cur-mcp]: https://cursor.com/docs/mcp
[kiro-powers]: https://kiro.dev/docs/powers.md
[kiro-powers-install]: https://kiro.dev/docs/powers/installation.md
[kiro-powers-create]: https://kiro.dev/docs/powers/create.md
[kiro-hooks]: https://kiro.dev/docs/hooks.md
[kiro-hooks-v1]: https://kiro.dev/docs/ide/whats-new-v1/hooks.md
[kiro-hooks-cli]: https://kiro.dev/docs/cli/v3/hooks-migration.md
[kiro-config]: https://kiro.dev/docs/configuration.md
[kiro-skills]: https://kiro.dev/docs/skills.md
[kiro-specs]: https://kiro.dev/docs/specs.md
[unleash]: https://github.com/Unleash/unleash-kiro-power
[oc-plugins]: https://opencode.ai/docs/plugins/
[oc-mcp]: https://opencode.ai/docs/mcp-servers/
[devin-ext]: https://docs.devin.ai/cli/extensibility
[devin-rules]: https://docs.devin.ai/cli/extensibility/rules
[devin-cli-skills]: https://docs.devin.ai/cli/extensibility/skills/overview
[devin-plugins]: https://docs.devin.ai/cli/extensibility/plugins/overview
[devin-mcp]: https://docs.devin.ai/cli/extensibility/mcp/configuration
[devin-hooks]: https://docs.devin.ai/cli/extensibility/hooks/overview
[devin-skills]: https://docs.devin.ai/desktop/cascade/skills
[pr497]: https://github.com/AmadeusITGroup/ai-primitives-hub/pull/497#issuecomment-5855276137
