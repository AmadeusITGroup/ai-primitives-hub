# Troubleshooting

## Debug Mode

Enable: `"promptregistry.enableLogging": true`

View logs: `View → Output → Prompt Registry`

## Common Issues

### Bundles Not Showing in Copilot

1. Check sync completed in logs
2. Verify directory exists:
   - **macOS**: `~/Library/Application Support/Code/User/prompts/`
   - **Linux**: `~/.config/Code/User/prompts/`
   - **Windows**: `%APPDATA%\Code\User\prompts\`
3. Restart VS Code (`Ctrl+R`)
4. Run `Prompt Registry: Sync All Bundles`

### Installation Fails

- **Network**: Check internet connection
- **Permission**: Ensure write access to user directory
- **Invalid Bundle**: Verify bundle has valid manifest
- Check logs for `[ERROR]` messages

### Authentication Fails (404/401)

1. Check VS Code GitHub auth (bottom-left avatar)
2. Try GitHub CLI: `gh auth status`
3. Add explicit token with `repo` scope
4. Run: `Prompt Registry: Validate Repository Access`
5. Force refresh authentication: `Prompt Registry: Force GitHub Authentication`

### Source Connection Failed

- Verify repository URL
- Check repository visibility (public/private)
- Wait if rate-limited

### Hub Not Displaying After Selection

If you selected a hub but it doesn't appear in the Registry Explorer:

1. Check logs (`View → Output → Prompt Registry`) for hub sync errors
2. Verify the hub URL is reachable from your network
3. Run `Prompt Registry: Sync Hub` from the Command Palette
4. If the hub still doesn't appear, run `Prompt Registry: Reset First Run`, then reload VS Code (`Ctrl+R`)

### Hub Selector Not Shown on First Launch

If you installed the extension but were never prompted to select a hub:

1. Ensure VS Code is version 1.99.3 or above
2. Run `Prompt Registry: Reset First Run` from the Command Palette
3. Reload VS Code (`Ctrl+R`) — the hub selector should appear

## Useful Commands

Access these commands via Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

### Diagnostic Commands
- `Prompt Registry: Validate Repository Access` - Test GitHub connectivity and permissions
- `Prompt Registry: Force GitHub Authentication` - Refresh authentication tokens
- `Prompt Registry: List Sources` - Show all configured sources and their status
- `Prompt Registry: List Installed` - Show all installed bundles

### Sync Commands
- `Prompt Registry: Sync All Sources` - Refresh bundle lists from all sources
- `Prompt Registry: Sync Source` - Refresh specific source
- `Prompt Registry: Sync All Bundles` - Re-sync installed bundles to Copilot

### Bundle Management
- `Prompt Registry: Update All Bundles` - Check and update all installed bundles
- `Prompt Registry: Manual Check for Updates` - Force check for bundle updates

### Nuclear Option: Complete Reset

**⚠️ WARNING: Use as last resort only!**

If all other troubleshooting steps fail, you can completely reset the extension:

1. **Complete Extension Reset** (most thorough):
   - Uninstall the Prompt Registry extension
   - Close VS Code completely
   - Delete the extension storage directory:
     - **macOS**: `~/Library/Application Support/Code/User/globalStorage/amadeus-prompt-registry/`
     - **Linux**: `~/.config/Code/User/globalStorage/amadeus-prompt-registry/`
     - **Windows**: `%APPDATA%\Code\User\globalStorage\amadeus-prompt-registry\`
   - Restart VS Code
   - Reinstall the Prompt Registry extension

2. **Reset First Run Command** (alternative):
   - Run: `Prompt Registry: Reset First Run`
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
