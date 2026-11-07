# ADR-0011: Shared `ai-primitives-hub` Install Records for the CLI and the Extension

**Status:** Accepted

## Context

[ADR-0004](./0004-cli-only-rebrand-keep-lockfile-and-extension-identity-stable.md)
kept `prompt-registry.lock.json` so the CLI and the extension could share
repository state, but the 2.0.0 lockfile keys entries by bundle only: installing
a bundle for a second tool replaced the first tool's entry. User installs were
split between the CLI's user lockfile and each VS Code profile's storage, and
the CLI kept a per-project last used target (`.ai-primitives-hub/target-state.json`)
that the extension did not share.

## Decision

- Install records use format `3.0.0` (`packages/core/src/domain/install/record-types.ts`):
  one entry per bundle and tool, with version, source and on-disk file checksums.
- At the git root: `ai-primitives-hub.lock.json` (committed) and
  `ai-primitives-hub.local.lock.json` (local only, in `.git/info/exclude`). At
  user level: one `ai-primitives-hub.user.lock.json` per machine in
  `$XDG_CONFIG_HOME/ai-primitives-hub/`, shared by the CLI and every profile.
- Before the first change at a level, `migrateRecords` moves the older files in.
  Entries without a known tool go under `unknown`. Read-only commands never migrate.
- `AppStoragePaths` keeps only `userRecord`; the per-profile installed-bundle
  folders move to the extension-only `ExtensionAppStorage` (narrows ADR-0005).
- The CLI drops `target-state.json`: without `--target` it uses the only
  configured target; `update` and `uninstall <bundle-id>` use the record's tools.
- The extension name, publisher and `promptregistry.*` command IDs are unchanged.

## Consequences

- Both deliveries share one set of files, and a bundle keeps every tool's entry.
- Older releases do not find the new files, so upgrade or roll back both
  together; rollback has manual steps ([migration guide](../../../migration-guide.md#upgrading-to-030-install-records)).
- Migrated `unknown` entries must be reinstalled before the extension moves them.
- CLI `profile activate` and workspace scope still write the 2.0.0 files.
- With two or more targets, more CLI commands need `--target`.

## Alternatives Rejected

- **Change the format under the old names:** older releases would misread it.
- **Dual-write old and new files:** the 2.0.0 file cannot hold several tools per
  bundle, so the two would diverge.
- **Keep per-profile user records:** the CLI cannot read VS Code `globalStorage`.
