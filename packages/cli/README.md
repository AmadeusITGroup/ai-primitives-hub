# @ai-primitives-hub/cli

Thin Clipanion delivery adapter over `@ai-primitives-hub/app`. Depends on
`core`, `infra`, and `app`. Commands parse arguments, call into `app`, and
format output; shared business behavior belongs in the domain and application
packages.

### Supported IDEs & CLIs

![VS Code](https://img.shields.io/badge/VS%20Code-✓-007ACC?logo=visual-studio-code&logoColor=white)
![VS Code Insiders](https://img.shields.io/badge/VS%20Code%20Insiders-✓-24b395?logo=visual-studio-code&logoColor=white)
![Kiro](https://img.shields.io/badge/Kiro-✓-FF6B35)
![Kiro CLI](https://img.shields.io/badge/Kiro%20CLI-✓-FF6B35)
![Windsurf / Devin](https://img.shields.io/badge/Windsurf%20%2F%20Devin-✓-1E90FF?logo=windsurf&logoColor=white)
![Claude Code](https://img.shields.io/badge/Claude%20Code-✓-D97757?logo=anthropic&logoColor=white)
![Copilot CLI](https://img.shields.io/badge/Copilot%20CLI-✓-24292e?logo=githubcopilot&logoColor=white)

## Supported Targets

The CLI can install and transform prompt bundles for the following target types:

| Target Type | Description |
|-------------|-------------|
| `vscode` | VS Code (user scope — `~/.config/Code/User/prompts/`) |
| `vscode-insiders` | VS Code Insiders |
| `copilot-cli` | GitHub Copilot CLI (user scope only) |
| `kiro` | Kiro IDE / Kiro CLI |
| `windsurf` | Windsurf Editor (Codeium) / Devin |
| `claude-code` | Anthropic Claude Code |

> **Note:** Kiro IDE and Kiro CLI share the same `.kiro/` directory, so the `kiro` target covers both — no separate `kiro-cli` target is needed. Similarly, Devin is a Windsurf rebrand and uses the `windsurf` target.

## Key Commands

| Command | Description |
|---------|-------------|
| `ai-primitives-hub init` | Interactive setup wizard — select IDE, configure hub, add sources |
| `ai-primitives-hub target add <name> --type <type>` | Add an install target |
| `ai-primitives-hub target types` | List all supported target types |
| `ai-primitives-hub install <bundle-id> [--target <name>]` | Install a bundle |
| `ai-primitives-hub uninstall <bundle-id> [--target <name>]` | Uninstall a bundle |
| `ai-primitives-hub update [--all] [--dry-run]` | Check or apply updates |
| `ai-primitives-hub source add/list/remove/sync` | Manage sources |
| `ai-primitives-hub hub add/use/sync/list` | Manage hubs |
| `ai-primitives-hub profile list/activate` | Manage profiles |
| `ai-primitives-hub discover/search` | Discover and search bundles |
| `ai-primitives-hub collection create/validate` | Collection scaffolding and validation |
| `ai-primitives-hub status` | Show targets, hub, index, and lockfile state |
| `ai-primitives-hub doctor` | Run diagnostics |

See [CLI User Flows](../../docs/contributor-guide/architecture/library-centric-architecture/cli-user-flows.md) for the full command hierarchy and use-case walkthroughs.

## Development

```bash
pnpm --filter @ai-primitives-hub/cli build
pnpm --filter @ai-primitives-hub/cli test
pnpm --filter @ai-primitives-hub/cli lint
```
