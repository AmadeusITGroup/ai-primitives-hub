# ADR-0011: Shared `ai-primitives-hub` Install Records for the CLI and the Extension

**Status:** Accepted

## Context

[ADR-0004](./0004-cli-only-rebrand-keep-lockfile-and-extension-identity-stable.md)
kept the repository lockfile names `prompt-registry.lock.json` /
`prompt-registry.local.lock.json` so the CLI and the extension could share
repository state. In practice they did not share it safely:

- The 2.0.0 lockfile keys entries by bundle only. An entry does not say which
  tool (target type) installed it, so installing a bundle for Kiro after
  VS Code replaced the VS Code entry and lost track of its files.
- User-level installs were recorded twice: in the CLI's single-file user
  lockfile (`~/.config/ai-primitives-hub/ai-primitives-hub.lock.json`) and in
  each VS Code profile's `globalStorage` folders. Neither delivery saw the
  other's installs.
- The CLI also kept a per-project "last used target" file
  (`.ai-primitives-hub/target-state.json`), an implicit choice that the
  extension did not share and that a record keyed by tool makes unnecessary.

[ADR-0005](./0005-universal-xdg-based-app-storage.md) decision 1 put
"installed-bundle records per scope" on the shared `AppStorage` port. The CLI
never used those per-profile folders; only the extension did.

## Decision

1. **One record format, keyed by bundle and tool.** Install records use format
   `3.0.0` (`packages/core/src/domain/install/record-types.ts`, schema
   `public/schemas/install-record.schema.json`). Each bundle holds one entry
   per tool (`vscode`, `kiro`, …) with its version, source and the files it
   wrote (checksums taken from disk). Unknown fields are kept on write.
2. **New file names, shared by both deliveries.**
   - Repository level, at the git root: `ai-primitives-hub.lock.json`
     (committed) and `ai-primitives-hub.local.lock.json` (local only, added to
     `.git/info/exclude`).
   - User level, one file per machine shared by the CLI and every VS Code
     profile: `ai-primitives-hub.user.lock.json` in the user config folder
     (`$XDG_CONFIG_HOME/ai-primitives-hub/`, by default
     `~/.config/ai-primitives-hub/`), with paths relative to the home folder.
3. **Migration of the older files.** Before the first record change at a
   level, `migrateRecords` (`packages/app/src/records/record-migration.ts`)
   moves the older stores into the new record: the `prompt-registry.*` files
   at the git root are rewritten under the new names and deleted; the CLI's
   2.0.0 user lockfile is imported once and left in place for workspace scope;
   the extension moves the current profile's user installs. Entries whose
   tool cannot be known are recorded under the tool `unknown` and listed as
   needing a reinstall. Read-only commands never migrate.
4. **The shared `AppStorage` port no longer carries per-scope installed-bundle
   folders.** `AppStoragePaths` keeps `userRecord` as its only installed-record
   path; `installed`, `userInstalled` and `profilesInstalled` move to the
   extension-only `ExtensionStoragePaths` / `ExtensionAppStorage`
   (`apps/vscode-extension/src/storage/extension-app-storage.ts`), which
   `VsCodeAppStorage` and `RegistryStorage` use. This narrows ADR-0005
   decision 1; the folders and their contents do not change.
5. **The CLI no longer uses `target-state.json`.** Without `--target`, a
   command uses the only configured target; `update` and
   `uninstall <bundle-id>` take the tools from the record.
6. **Extension identity stays.** The extension `package.json` name and
   publisher (`AmadeusITGroup.prompt-registry`) and the `promptregistry.*`
   command IDs are unchanged; ADR-0004 stays in force for them.

ADR-0004 is superseded only for the lockfile name, and ADR-0005 only for the
installed-record paths of decision 1.

## Consequences

- **Positive:** the CLI and the extension read and write the same files at
  both levels, and a bundle installed for several tools keeps every tool's
  entry and files.
- **Positive:** one user record replaces the CLI user lockfile and the
  per-profile records, so an install made in one profile or in the CLI is
  visible everywhere.
- **Positive:** the record names match the product name; the old names remain
  only as migration sources (and in the CLI's workspace scope and
  `profile activate`, see below).
- **Negative:** older releases (CLI 0.2.x, extension releases before this
  change) do not find the renamed files; both deliveries should be upgraded,
  or rolled back, together. Rolling back needs manual steps (see the
  [migration guide](../../../migration-guide.md#upgrading-to-030-install-records)).
- **Negative:** migrated entries without a known tool appear as `unknown` and
  must be reinstalled before the extension can move them or switch their
  commit mode.
- **Negative:** CLI `profile activate` and workspace scope still use the
  2.0.0 files. For repository targets, bundles `profile activate` writes
  become `unknown` entries on the next record change; for user targets they
  are not seen at user level once the old user lockfile was imported. This is
  a known follow-up.
- **Negative:** with two or more targets, more CLI commands need `--target`.

## Alternatives Rejected

- **Keep `prompt-registry.*` and change the format in place.** No migration of
  names, but the files would keep the old brand, and older releases would
  find a format they do not understand under the name they expect, instead
  of simply not finding a record.
- **Dual-write both names.** Write the new record and keep the old files up to
  date for older releases. Two sources of truth at each level: the 2.0.0 file
  cannot represent several tools per bundle, so every write would lose
  information or diverge, and deciding which file wins on read reintroduces
  the conflict this ADR removes.
- **Keep per-profile user records in the extension.** Rejected because the CLI
  cannot read VS Code `globalStorage`, so user installs would stay split.
