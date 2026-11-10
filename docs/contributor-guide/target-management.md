# Target Management

Opt-in target management lets the CLI and the VS Code extension install,
update and uninstall collections for any of the 11 harness layouts at both
`user` and `repository` scope, from one shared session. A harness is selected
once; the scope is chosen per action; every installation is a lockfile record
with an opaque installation ID.

> **Status:** experimental. With the setting off, Marketplace, `target` and
> `install` keep their existing behavior and no new files are written.
> File-projection proof is not native runtime certification of each harness.

## Persisted Layout

| Data | Location |
| --- | --- |
| Repository records | `<workspace>/prompt-registry.lock.json` (committed) and `prompt-registry.local.lock.json` (local only) |
| User records | `$XDG_DATA_HOME/ai-primitives-hub/ai-primitives-hub.lock.json` |
| Harness selection and repository index | `$XDG_STATE_HOME/ai-primitives-hub/target-selection.json` |
| Payload snapshots | `$XDG_DATA_HOME/ai-primitives-hub/payloads/<payloadId>/` |
| Imports | `$XDG_DATA_HOME/ai-primitives-hub/imports.json` |
| Mutation lock | `$XDG_STATE_HOME/ai-primitives-hub/mutation.lock` |

Unset variables default to `~/.config`, `~/.local/share`, `~/.local/state` and
`~/.cache`. Selection records the harness type only:

```json
{ "workspaces": { "/work/repo": { "type": "kiro" } }, "userDefault": { "type": "vscode" }, "revision": 3 }
```

### Lockfile v3

Lockfiles hold installation records only: no payload bytes, no selection and no
revision. The schema is [`lockfile.schema.json`](../../packages/core/src/public/schemas/lockfile.schema.json)
(v3 only; the older single-target v2 format is described by
`lockfile-v2.schema.json`).

```json
{
  "$schema": "https://raw.githubusercontent.com/AmadeusITGroup/ai-primitives-hub/main/packages/core/src/public/schemas/lockfile.schema.json",
  "version": "3.0.0",
  "generatedAt": "<iso>",
  "generatedBy": "ai-primitives-hub@<version>",
  "sources": { "<sourceId>": { "type": "github", "url": "https://github.com/o/r" } },
  "bundles": {
    "<bundleKey>": {
      "sourceId": "...", "manifestId": "...", "bundleId": "<registry id>",
      "tools": { "kiro": { "instances": { "<instanceKey>": {
        "scope": "repository", "root": "<absolute at write time>", "version": "1.0.0",
        "installationId": "<opaque>", "payloadId": "<content address>", "installedAt": "<iso>",
        "files": [ { "path": ".kiro/steering/a.md", "checksum": "sha256:<hex>" } ]
      } } } }
    }
  }
}
```

Repository instances record a workspace-relative `root` (for example `.kiro`)
and workspace-relative file paths, with no absolute path, context root or commit
mode (the file name implies it), so the committed file is machine-independent
and installation IDs survive moving or re-cloning the repository. User
instances record an absolute `root` and root-relative file paths. `sources` records where each collection can be re-acquired
(`install --from <dir>` records `{ "type": "local", "url": "<directory>" }`).

A payload snapshot that is missing (for example on a fresh clone) does not hide
the installation: it is listed as unavailable, and operations that need the
bytes (project, repair) fail with an actionable "re-acquire from source" error.

A v2 repository lockfile is read-only: mutations in that workspace are refused
rather than overwriting it.

## Storage and Legacy Migration

All extension data lives under the same XDG roots as the CLI: registry
`config.json` in `$XDG_CONFIG_HOME/ai-primitives-hub/`, hubs under `hubs/`,
bundle content, installed records and tool binaries in
`$XDG_DATA_HOME/ai-primitives-hub/`, and shared application state (setup state,
migration registry, declined prompts, session files) in
`$XDG_STATE_HOME/ai-primitives-hub/`. The IDE `globalStorageUri` is read only to
detect and migrate legacy data. Per-window UI mementos that are not shared
stay in VS Code `globalState`; none of the application data does.

At activation, and from the startup checks, the extension looks for known legacy
artifacts in its IDE storage (`config.json`, hub `*.yml`/`*.meta.json`,
`activeHubId.json`, `favorites.json`, `installed/`, `bundles/`,
`profile-activations/`, `profiles/`). If found and not yet journaled, it warns
about the legacy storage with **Migrate Now** and **Later**; the prompt returns
every activation and the extension runs on XDG only until migrated. Migration
copies (never moves), transforms `activeHubId.json` to `active-hub.json`,
merges sources, profiles and favorites by id without overwriting existing XDG
data, reports conflicts, and journals the result in
`$XDG_STATE_HOME/ai-primitives-hub/migrations.json`. Source tokens stay in
SecretStorage.

Legacy v2 repository lockfiles are migrated separately: see `lockfile migrate`
above and the extension's **Migrate Lockfile** command.

## Installed Manifest Boundary

An installed record retains its actual archive manifest. The shared
`InstalledManifest` type accepts the historical build-spec manifest, minimal
legacy release manifests and governed release manifests. Display consumers use
`readInstalledManifest` for checked metadata and prompt descriptions; versioned
releases use canonical `items`, including an empty inventory.

## CLI

The target-management commands require `experimental.targetManagement: true` in
the CLI config (`$XDG_CONFIG_HOME/ai-primitives-hub/config.yml`):

```yaml
experimental:
  targetManagement: true
```

With the gate on:

```bash
ai-primitives-hub target list                          # 11 harnesses, selected marker, configured overrides
ai-primitives-hub target use <type|name> [--global]    # harness only
ai-primitives-hub target current [-o json]             # { type, selection: workspace|user-default }
ai-primitives-hub install --from <dir> --scope user|repository [--target <type|name>]
ai-primitives-hub install <bundle> --source <id> --scope user|repository
ai-primitives-hub update --from <dir> (--installation-id <id> | <bundle> --scope <s>)
ai-primitives-hub uninstall (<bundle> --scope <s> | --installation-id <id>)
ai-primitives-hub installed [-o json]                  # both scopes, selected harness
ai-primitives-hub lockfile inspect <file>              # read-only view of a legacy v2 lockfile
```

Mutations require `--scope` (or `--installation-id` where allowed); the
selection never carries a scope. `--dry-run` previews a plan and `--apply-plan
<hash>` applies a previewed one. A configured `targets[]` entry is a harness
override: `target use <name>` selects its type and its `path` applies to
user-scope installs; several entries for one harness are reported by
`target list`. A legacy v2 repository lockfile blocks mutations in that
workspace until it is migrated.

With the gate off, `target add/list/remove/types`, `install`, `update` and
`uninstall` behave as before; `target use`, `target current` and `installed`
fail with a message naming `experimental.targetManagement`, and no new state is
written.

The workspace is the nearest ancestor containing `.git` (directory or file),
otherwise the current directory (`--workspace-root` overrides).

## Extension (VS Code)

Enable the application setting `promptregistry.experimental.runtimeTargetManagement`
(default off) from the **Configure Target Management** command. Enabling
registers the target command set and a `Target: <harness>` status item;
disabling disposes them. No reload is needed.

- The selector asks for the harness only. A single folder is used implicitly,
  no folder means the user default, and only a multi-root workspace asks which
  folder.
- Marketplace cards show separate Repository and User controls. Each control
  selects a version for that scope; Repository also offers tracked or Local
  Only installation. Installed rows expose Update and Uninstall for that exact
  scope/version. The Explorer's item commands carry the selected installation
  ID, so duplicate installations cannot make an update ambiguous.
- MCP declarations are merged into the selected harness's MCP config by the
  extension's MCP manager. Its per-config tracking metadata owns those server
  entries separately from the v3 prompt-file receipts; update replaces a
  collection's old server set and uninstall removes only its managed entries.
  This covers `mcpServers`/`mcpInputs` deployment-manifest fields, not generic
  `mcp-server` item projection.
- Install, update, project and uninstall show a JSON preview before
  confirmation; cancelling is read-only and a changed selection requires a new
  preview.

Selections are shared when both clients use the same workspace root; pass
`--workspace-root` to the CLI when you open a nested folder in the editor.

## Acceptance Campaign

A manually launched campaign drives the real CLI and a real VS Code extension
host against local fixtures. See the
[acceptance campaign guide](../../apps/vscode-extension/test/acceptance/README.md).

## Not Supported

- The CLI target-management surface still rejects MCP server declarations.
- Plugin, hook, power and config projection (rejected before mutation).
- Profiles and scheduled updates for target-managed installations.
- Durable crash journaling and non-cooperative-writer TOCTOU safety
  (in-process rollback only; multi-file publication is not crash-atomic).
- Automatic migration of legacy v2 lockfiles and legacy storage.

## See Also

- [Testing guide](testing.md)
- [ADR index](architecture/adr/adr-index.md)
