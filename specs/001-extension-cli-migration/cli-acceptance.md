# CLI Acceptance Baseline

## Product Position

The CLI is a first-class interface for users who prefer terminal workflows. It must call shared application use cases rather than duplicating the extension install pipeline.

## Required Commands

| Command Area | Expected Capability |
|--------------|---------------------|
| `install` | Install local or remote bundles for a target and scope. |
| `update` | Update installed bundles without corrupting existing files or lockfiles. |
| `uninstall` | Remove installed bundles and clean state consistently. |
| `validate` | Validate collections, bundles, manifests, layouts, and target compatibility. |
| `list` | List configured sources, bundles, targets, or installs as supported by the slice. |
| `inspect` | Show bundle or install details in human-readable and JSON modes. |
| `doctor` | Diagnose environment, proxy, TLS, schema, and configuration issues when diagnostics are ported. |

## Output Requirements

- Human-readable output is concise and actionable.
- JSON output is stable enough for scripts.
- Errors go to stderr.
- Invalid input exits non-zero.
- Repository-scope safety diagnostics are redacted and do not print secret values.

## Target And Scope Requirements

- CLI commands must accept explicit target and scope where the operation needs them.
- Remote install paths must use the same shared writer factory as local installs.
- Unsupported target/resource combinations must fail with actionable diagnostics unless a command explicitly supports partial installs.

## Test Requirements

- Parser and help output tests.
- Local install success tests with fixture bundles.
- Remote install regression tests proving shared writer use.
- Invalid input and unsupported target tests.
- JSON output stability tests.
- Repository-scope secret-safe install tests.