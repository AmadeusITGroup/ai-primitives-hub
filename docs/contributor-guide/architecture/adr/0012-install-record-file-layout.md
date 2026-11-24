# ADR-0012: Install Record File Layout for Every Harness and Scope

**Status:** Proposed

## Context

[ADR-0011](./0011-ai-primitives-hub-install-records.md) moved the CLI and the
extension onto shared format `3.0.0` install records, one entry per bundle and
tool. Its first layout keyed bundles and sources by ids each client chose, so
the same install looked different on two machines or in two tools, and it did
not say which hub a source came from or which MCP servers an install wrote.

Teams use several harnesses (VS Code, VS Code Insiders, Copilot CLI, Kiro,
Windsurf, Claude Code) in one repository and on one machine. Each installs
prompts, instructions, agents, skills, hooks, MCP servers and Agent Plugins from
the same hubs and sources, at repository scope (committed or local-only) and at
user scope. The record has to describe all of this the same way for every
client, so that each install traces to its hub, source and bundle, update and
uninstall add and remove exactly what an install wrote, and teammates can
replay a repository's installs. Issue #688 settles this layout; issue #689
proposed an alternative.

## Decision

### Files and scope

One file per scope. `level` sits at the root of each file, and every path in a
file is relative to its level root.

| File | Level | Paths relative to | Shared with |
|---|---|---|---|
| `ai-primitives-hub.lock.json` at the git root | `repository`, commit | git root | the team (committed) |
| `ai-primitives-hub.local.lock.json` at the git root | `repository`, local-only | git root | this clone (in `.git/info/exclude`) |
| `$XDG_CONFIG_HOME/ai-primitives-hub/ai-primitives-hub.user.lock.json` | `user` | home folder | this machine: the CLI and every editor profile |

The user file defaults to `~/.config/ai-primitives-hub/`, next to the hubs,
`active-hub.json` and `targets.yml`. A bundle installed at both scopes has one
entry in each file, under the same key.

### Structure

```text
{ $schema, version: "3.0.0", level, generatedAt, generatedBy,
  hubs:    { <hubId>:    { name, type, location, ref?, configFile? } },
  sources: { <sourceId>: { type, url, branch?, collectionsPath?, indexFile?, authMode?, credentialRef?, hubId? } },
  bundles: { <bundleKey>: { name, tools: { <tool>: <entry> } } } }

<entry> = { version, sourceType, installedAt, bundleId?, integrity?, needsReinstall?,
            files: [{ path, checksum, sourcePath?, mode? }],
            mcpServers?: [{ config, name, item?, checksum? }] }
```

The layout borrows from `pnpm-lock.yaml`: consumers point at shared facts by id,
and a key carries no version, so an upgrade changes one value.

| `pnpm-lock.yaml` | Install record |
|---|---|
| one lockfile per workspace | one file per scope |
| `importers.<path>` | `bundles.<key>.tools.<tool>` |
| package key without a version, `version` as a value | bundle key without a version, `version` as a value |
| `packages.<name@version>` shared by every importer | `sources.<id>` and `hubs.<id>` shared by every bundle |
| `resolution.integrity` | `integrity` of the bundle payload, plus a `checksum` per file |
| `pnpm prune` | unused `sources` and `hubs` entries are dropped on save |

Unlike pnpm, the record lists every file it wrote, since primitives land in
folders people edit and commit.

### Ids

Ids are built from the recorded fields, so they are the same on every machine
and in every tool, and hold no credential, version or local hub id.

- **Source id** `src:<type>:<host/path>[#<branch>][:<path>]`, where `<path>` is
  the collections folder, or an Artifactory source's index file. URLs lose their
  scheme, credentials, query and `.git`; an empty branch or path is left out.
  Example: `src:awesome-copilot:github.com/github/awesome-copilot#main:collections`.
- **Hub id** `hub:<type>:<host/path>[#<ref>][:<configFile>]`; a GitHub
  `owner/repo` gets its `github.com` host.
- **Bundle key** `<sourceId>/<name>`, where `name` is the collection, manifest
  or index id without its version. It never changes on upgrade or downgrade.
  When the hub's bundle id differs from `name`, the entry keeps it as
  `bundleId`, so commands can still find the bundle by the id the user typed.
- **Tool** keys are target types (`vscode`, `kiro`, `copilot-cli`, …), or
  `unknown` for a migrated entry whose tool could not be identified
  (`needsReinstall: true`).

Ids of an earlier readable form are rewritten on read; the next save writes the
current form.

### Rules

- **One entry per bundle and tool in a file.** Tools may hold different
  versions. Installing another version of a bundle replaces that tool's entry,
  also when the hub's id contains the version.
- **Files are owned per entry.** `files[]` lists every path written, with a
  `sha256:` checksum of the bytes on disk. `sourcePath` is the file's path in
  the bundle, so update can compare file by file when a tool renames or
  converts a file. `mode` is set only for a non-default mode, such as an
  executable hook.
- **Shared files stay while listed.** Uninstall and update remove a file only
  when no other entry at the level lists it, and keep files changed since the
  install, with a warning. Paths are compared after resolving their parent
  folders, so a symlinked folder does not hide a shared file.
- **`integrity`** is the `sha256:` of the downloaded bundle content (each bundle
  path with its file's hash, sorted). It catches content that changed under the
  same version, such as a branch-based source.
- **MCP servers are owned like files.** `mcpServers[]` names each server an
  entry wrote into the tool's own MCP file (`.vscode/mcp.json`,
  `.kiro/settings/mcp.json`, …), with a checksum of its definition. The
  definition stays in that file; `${env:VAR}` stays unresolved and no secret is
  recorded. Uninstall removes only the servers the entry owns. Where a record
  keeps the servers, the extension's MCP tracking file is retired (it stays
  under WSL remote, which has no shared user record).
- **One hub per source.** `hubId` names the hub a source came from; a source
  added with `source add` has none. Installing a recorded source through a
  second hub is refused with `RECORD.HUB_CONFLICT` before any file is written.
- **No secrets.** Source URLs are stripped of user, password and token-like
  query parameters; hubs keep only the reference `hub add` needs, never a local
  path. `credentialRef` names a credential, never its value.
- **Writes are checked first.** Each command loads and checks every record
  file of the level before writing anything; changes to one level root are
  serialized in-process, and each file is replaced atomically. A record larger
  than 10 MB is refused.
- **Older files are migrated once.** The first change at a level moves the
  older 2.0.0 stores into the record: `prompt-registry.lock.json` and
  `prompt-registry.local.lock.json` at the git root (then deleted), and at user
  level the CLI's old user lockfile and the extension's per-profile entries
  (imported once, marked by `importedUserLockfileAt`). Entries without a known
  tool go under `unknown`. Read-only commands never migrate.

### Example (ids illustrative)

`ai-primitives-hub.lock.json`, with one collection installed for VS Code and Kiro:

```json
{
  "$schema": "https://github.com/AmadeusITGroup/ai-primitives-hub/schemas/lockfile.schema.json",
  "version": "3.0.0",
  "level": "repository",
  "generatedAt": "2026-11-20T09:00:00.000Z",
  "generatedBy": "ai-primitives-hub-cli@0.3.0",
  "hubs": {
    "hub:github:github.com/acme/hub-config#main": {
      "name": "Acme Hub", "type": "github", "location": "acme/hub-config", "ref": "main"
    }
  },
  "sources": {
    "src:awesome-copilot:github.com/github/awesome-copilot#main:collections": {
      "type": "awesome-copilot", "url": "https://github.com/github/awesome-copilot",
      "branch": "main", "collectionsPath": "collections",
      "hubId": "hub:github:github.com/acme/hub-config#main"
    }
  },
  "bundles": {
    "src:awesome-copilot:github.com/github/awesome-copilot#main:collections/python-data-science": {
      "name": "python-data-science",
      "tools": {
        "vscode": {
          "version": "1.4.0", "sourceType": "awesome-copilot", "installedAt": "2026-11-20T09:00:00.000Z",
          "integrity": "sha256:9f8e…",
          "files": [{ "path": ".github/instructions/python.instructions.md", "checksum": "sha256:…",
                      "sourcePath": "instructions/python.instructions.md" }]
        },
        "kiro": {
          "version": "1.3.0", "sourceType": "awesome-copilot", "installedAt": "2026-11-20T09:05:00.000Z",
          "integrity": "sha256:4d2c…",
          "files": [{ "path": ".kiro/steering/python.instructions.md", "checksum": "sha256:…",
                      "sourcePath": "instructions/python.instructions.md" }]
        }
      }
    }
  }
}
```

The two tools share one key and keep their own versions; the same `sourcePath`
shows that Kiro's steering file came from the bundle's instructions file.

### Not decided here

- **Per-entry `root`:** the folder a tool writes to at user scope (`~/.kiro`,
  `~/.copilot`). The schema accepts it; entries are still written relative to
  the home folder.
- **Agent Plugins:** `plugins[]` (name, version, manifest digest, root, the
  skills and MCP servers it projects) is in the schema, not yet written.
- **Profiles:** not recorded. Activation state stays in `profile-activations/`
  and the hub's `active` flag, so a deactivated profile still removes a bundle
  that `profile install` also installed.
- **Strict top level:** the schema still accepts unknown keys.
- **From #689, tracked separately:** a cross-process `mutation.lock` per file,
  `verify` statuses, MCP files following the commit or local-only choice, a
  rollout flag and an acceptance test harness.
- **Open questions in #688:** whether the user file should move to
  `$XDG_DATA_HOME` (next to the extracted bundles), and whether `integrity`
  should be required for local sources.

## Consequences

- The same install has the same keys in every file, on every machine and in
  every tool, so a client reading several files matches bundles without
  guessing, and committed records diff cleanly.
- Any client can see and refuse a change to an entry another tool owns
  (`RECORD.CLI_MANAGED`), and uninstall removes only what an entry owns,
  MCP servers included.
- A source keeps one hub; moving it to another hub means uninstalling first.
- Keys are long. The CLI and the extension show the bundle `name`, and accept
  the hub's bundle id through `bundleId`.
- Records written by earlier builds of this format are rewritten on the next
  save; older releases do not read the new files ([ADR-0011](./0011-ai-primitives-hub-install-records.md)).

## Alternatives Rejected

- **Hashed keys (`bundle-<hash>`, from #689):** stable, but unreadable in a
  diff or a code review.
- **An `instances` list per bundle (#689):** allows several versions per tool,
  which no client needs, and makes "the tool's entry" ambiguous.
- **Configured source and hub ids:** differ between machines and clients, so
  two records of the same install do not match.
- **A version in the bundle key:** an upgrade would add a key instead of
  changing a value, and leave the old one to clean up.
- **Copying MCP definitions into the record:** the tool's MCP file is the
  source of truth, and a copy could carry secrets.
