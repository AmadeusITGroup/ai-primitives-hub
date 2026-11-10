# Target Acceptance Campaign

Drives the real `ai-primitives-hub` CLI (subprocess) and a real VS Code
extension host through the scenarios in the target-management acceptance plan,
against local fixtures only. It is launched manually and is never part of the
default unit suite or CI.

## Run

```bash
pnpm run test:acceptance:targets     # builds packages and the extension, then runs the campaign
```

or use the **Target Acceptance (Isolated)** Run and Debug entry. To skip the
build, run `node apps/vscode-extension/test/run-target-acceptance.js`.

Requirements: Node 24, an installed VS Code (`VSCODE_EXECUTABLE_PATH` or a
standard install location) and a display for the native phases. Nothing is
downloaded.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `APH_ACCEPT_MODE` | `all` | `all`, `cli` or `vscode` |
| `APH_ACCEPT_PHASES` | all | comma list of native phases: `lifecycle`, `migration`, `lockfile-error`, `local-only`, `mcp`, `storage` |
| `APH_ACCEPT_KEEP` | off | `1` keeps the sandbox after a passing run (failures always keep it) |
| `VSCODE_EXECUTABLE_PATH` | auto | VS Code binary to launch |

## Boundaries

- Every process gets a fresh synthetic `HOME`, `USERPROFILE`, `APPDATA`,
  `XDG_*` roots and `TMPDIR`; no real user directory is read or written.
- Local fixtures are used, but the VS Code host itself may attempt background
  connections. These runs are not network-isolation evidence.
- The oracle (`target-model.js`) derives expected lockfile records, files on
  disk and views from an independent golden layout table, not from production
  code.
- The extension exposes its observation API (`marketplaceSnapshot()`,
  `explorerInstalled()`) only in `ExtensionMode.Test`.
- It certifies projection and delivery, not native loading of files by each
  harness, and does not certify DOM rendering or Windows hosts.
