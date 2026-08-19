# Getting Started

## Prerequisites

### VS Code Extension

- VS Code 1.105+ (also runs in VS Code forks: Kiro, Windsurf)
- GitHub Copilot (for using prompts)

### CLI

- Node.js 24+
- No editor required — the CLI can target VS Code, Kiro, Windsurf, Claude Code, Copilot CLI, or Kiro CLI

## Installation

### Option A: VS Code Extension

Search "AI Primitives Hub" in VS Code Extensions (`Ctrl+Shift+X`) and click Install.

Alternatively, install directly from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=AmadeusITGroup.prompt-registry). You will be prompted to authenticate with GitHub — click Allow and sign in.

> **Kiro / Windsurf users:** The same extension works in your editor. Search for "AI Primitives Hub" in your Extensions panel. The extension auto-detects your editor and routes files to the correct directory (`.kiro/` or `.windsurf/`).

### Option B: CLI

```bash
# Initialize a project with the interactive wizard
npx ai-primitives-hub init

# Or install globally
npm install -g ai-primitives-hub
ai-primitives-hub init
```

The `init` wizard will:
1. Ask you to select your target IDE (VS Code, Kiro, Windsurf, Claude Code, Copilot CLI, Kiro CLI, etc.)
2. Configure the target in `ai-primitives-hub.yml`
3. Optionally add a hub and sources

You can also add targets later:
```bash
ai-primitives-hub target add my-vscode --type vscode
ai-primitives-hub target add my-kiro --type kiro
ai-primitives-hub target add my-claude --type claude-code
```

## First Launch: GitHub Account and Hub Selection

On first launch, AI Primitives Hub shows a welcome dialog to help you get started:

1. **GitHub Account** — If you have multiple GitHub accounts signed in to VS Code, AI Primitives Hub asks which one to use. Pick the account that has access to the hub or sources you need. If only one account is signed in, you can still add another from the same picker. Cancelling this step leaves the extension in a "Setup Not Complete" state; on the next launch you will see a "Would you like to resume?" prompt. You can also re-pick later by running the **AI Primitives Hub: Force GitHub Authentication** command (`promptregistry.forceGitHubAuth`) from the Command Palette.

2. **Hub Selector** — Choose from available hubs:
   - Pre-configured hubs (verified for availability)
   - Custom Hub URL (enter your own)
   - Skip for now (configure later)

3. **Automatic Setup** — When you select a hub:
   - The hub is imported and set as active
   - Sources defined in the hub are synced
   - The first profile is auto-activated (if available)
   - Awesome Copilot source is added automatically

4. **Ongoing Sync** — On each VS Code startup, the active hub is automatically synced to keep your configuration up-to-date.

To reset and re-trigger the first-run experience, open the Command Palette
(`Ctrl+Shift+P` on Windows/Linux or `Cmd+Shift+P` on macOS) and run
**AI Primitives Hub: Reset First Run**.

## Quick Start (5 minutes)

### Via VS Code Extension

1. **Pick GitHub Account, then Select Hub** — Choose which GitHub account to use, then pick a hub from the welcome dialog (or skip)
2. **Open Marketplace** — Click the AI Primitives Hub icon in the Activity Bar
3. **Browse** — Search or filter by tags/source
4. **Install** — Click a bundle tile → Install
5. **Use** — Prompts appear in Copilot Chat as `/<bundle-id>-<prompt-id>`

### Via CLI

```bash
# Add a source (e.g., Awesome Copilot)
ai-primitives-hub source add awesome --type awesome-copilot

# Discover available bundles
ai-primitives-hub discover

# Install a bundle to your target
ai-primitives-hub install <bundle-id> --target my-kiro

# Check status
ai-primitives-hub status
```

## Installed Files Location

File locations depend on the target IDE:

| Target | User Scope Path | Repository Scope Path |
|--------|----------------|----------------------|
| **VS Code** | `~/.config/Code/User/prompts/` (Linux) · `~/Library/Application Support/Code/User/prompts/` (macOS) · `%APPDATA%\Code\User\prompts\` (Windows) | `.github/prompts/` |
| **VS Code Insiders** | Same as VS Code but with `Code - Insiders` directory | `.github/prompts/` |
| **Kiro / Kiro CLI** | `~/.kiro/` | `.kiro/` |
| **Windsurf / Devin** | `~/.codeium/windsurf/` | `.windsurf/` |
| **Claude Code** | `~/.claude/` | `.claude/` |
| **Copilot CLI** | `~/.copilot/` | `.github/` |

> **Note:** The extension auto-detects your host editor. The CLI requires explicit `--target` or target configuration in `ai-primitives-hub.yml`.

## Add Your Own Source

### Via Extension
1. Registry Explorer → Add Source
2. Choose type: `github`, `local`, `awesome-copilot`, `local-awesome-copilot`, `apm`, `local-apm`, `skills`, `local-skills`, or `azure-devops`
3. Enter URL/path

### Via CLI
```bash
ai-primitives-hub source add my-source --type github --url https://github.com/org/repo
```

## See Also

- [Marketplace](./marketplace.md) — Browse and install bundles
- [Sources](./sources.md) — Configure prompt sources
- [Profiles and Hubs](./profiles-and-hubs.md) — Hub management
- [Troubleshooting](./troubleshooting.md) — Common issues
