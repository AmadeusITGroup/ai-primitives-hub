# Troubleshooting

## Debug Mode

### VS Code Extension
Enable: `"promptregistry.enableLogging": true`

View logs: `View → Output → AI Primitives Hub`

### CLI
```bash
# Run diagnostics
ai-primitives-hub doctor

# Show current status
ai-primitives-hub status

# Verbose output
ai-primitives-hub --verbose <command>
```

## Common Issues

### Bundles Not Showing in Copilot

1. Check sync completed in logs
2. Verify directory exists for your target:
   - **VS Code (macOS)**: `~/Library/Application Support/Code/User/prompts/`
   - **VS Code (Linux)**: `~/.config/Code/User/prompts/`
   - **VS Code (Windows)**: `%APPDATA%\Code\User\prompts\`
   - **Kiro / Kiro CLI**: `~/.kiro/` (user) or `.kiro/` (repository)
   - **Windsurf / Devin**: `~/.codeium/windsurf/` (user) or `.windsurf/` (repository)
   - **Claude Code**: `~/.claude/` (user) or `.claude/` (repository)
3. Restart your editor (`Ctrl+R` in VS Code)
4. Run `AI Primitives Hub: Sync All Bundles` (extension) or `ai-primitives-hub sync` (CLI)

### Installation Fails

- **Network**: Check internet connection
- **Permission**: Ensure write access to user directory
- **Invalid Bundle**: Verify bundle has valid manifest
- Check logs for `[ERROR]` messages

### Authentication Fails (404/401)

#### Via Extension
1. Check VS Code GitHub auth (bottom-left avatar)
2. Try GitHub CLI: `gh auth status`
3. Add explicit token with `repo` scope
4. Run: `AI Primitives Hub: Validate Repository Access`
5. Force refresh authentication: `AI Primitives Hub: Force GitHub Authentication`

#### Via CLI
1. Check environment: `echo $GITHUB_TOKEN` or `echo $GH_TOKEN`
2. Try GitHub CLI: `gh auth status`
3. Pass token explicitly: `ai-primitives-hub --token <token> <command>`
4. Run diagnostics: `ai-primitives-hub doctor`

### Azure DevOps Authentication Fails (401/403)

1. Verify the PAT was entered correctly when adding the source
2. Ensure the PAT has **Code (Read)** permission for the target repository
3. Check the PAT has not expired (Azure DevOps → User Settings → Personal Access Tokens)
4. Re-add the source with a fresh PAT via `AI Primitives Hub: Add Source`

### Source Connection Failed

- Verify repository URL
- Check repository visibility (public/private)
- Wait if rate-limited

### Hub Not Displaying After Selection

If you selected a hub but it doesn't appear in the Registry Explorer:

1. Check logs (`View → Output → AI Primitives Hub`) for hub sync errors
2. Verify the hub URL is reachable from your network
3. Run `AI Primitives Hub: Sync Hub` from the Command Palette
4. If the hub still doesn't appear, run `AI Primitives Hub: Reset First Run`, then reload VS Code (`Ctrl+R`)

### Hub Selector Not Shown on First Launch

If you installed the extension but were never prompted to select a hub:

1. Ensure VS Code is version 1.99.3 or above
2. Run `AI Primitives Hub: Reset First Run` from the Command Palette
3. Reload VS Code (`Ctrl+R`) — the hub selector should appear

## Useful Commands

Open the Command Palette (`Ctrl+Shift+P` on Windows/Linux or `Cmd+Shift+P` on
macOS) to access these commands:

### Diagnostic Commands
- `AI Primitives Hub: Validate Repository Access` - Test GitHub connectivity and permissions
- `AI Primitives Hub: Force GitHub Authentication` - Refresh authentication tokens
- `AI Primitives Hub: List Sources` - Show all configured sources and their status
- `AI Primitives Hub: List Installed` - Show all installed bundles

### Sync Commands
- `AI Primitives Hub: Sync All Sources` - Refresh bundle lists from all sources
- `AI Primitives Hub: Sync Source` - Refresh specific source
- `AI Primitives Hub: Sync All Bundles` - Re-sync installed bundles to Copilot

### Bundle Management
- `AI Primitives Hub: Update All Bundles` - Check and update all installed bundles
- `AI Primitives Hub: Manual Check for Updates` - Force check for bundle updates

### Nuclear Option: Complete Reset

**⚠️ WARNING: Use as last resort only!**

If all other troubleshooting steps fail, you can completely reset:

#### Extension Reset (most thorough):
1. Uninstall the AI Primitives Hub extension
2. Close your editor completely
3. Delete the extension storage directory:
   - **macOS**: `~/Library/Application Support/Code/User/globalStorage/amadeus-prompt-registry/`
   - **Linux**: `~/.config/Code/User/globalStorage/amadeus-prompt-registry/`
   - **Windows**: `%APPDATA%\Code\User\globalStorage\amadeus-prompt-registry\`
4. Restart your editor
5. Reinstall the AI Primitives Hub extension

#### CLI Reset:
1. Delete the CLI state: `rm -rf ~/.config/ai-primitives-hub/` (Linux/macOS) or `%APPDATA%\ai-primitives-hub\` (Windows)
2. Delete the project config: `rm ai-primitives-hub.yml`
3. Delete target state: `rm -rf .ai-primitives-hub/`
4. Re-run `ai-primitives-hub init`

#### Reset First Run Command (extension alternative):
- Run: `AI Primitives Hub: Reset First Run`
- Reload VS Code window (`Ctrl+R` / `Cmd+R`)

**This will completely remove:**
- All configured sources
- All installed bundles
- All profiles and settings
- Authentication tokens
- Cache data

You'll need to reconfigure everything from scratch.

## Getting Help

- [Report Issues](https://github.com/AmadeusITGroup/prompt-registry/issues)
- [Discussions](https://github.com/AmadeusITGroup/prompt-registry/discussions)
