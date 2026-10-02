# Troubleshooting

## Debug Mode

Enable: `"promptregistry.enableLogging": true`

View logs: `View → Output → AI Primitives Hub`

## Common Issues

### Bundles Not Showing in Copilot

1. Check sync completed in logs
2. Verify directory exists:
   - **macOS**: `~/Library/Application Support/Code/User/prompts/`
   - **Linux**: `~/.config/Code/User/prompts/`
   - **Windows**: `%APPDATA%\Code\User\prompts\`
3. Restart VS Code (`Ctrl+R`)
4. Run `AI Primitives Hub: Sync All Bundles`

### Installation Fails

- **Network**: Check internet connection
- **Permission**: Ensure write access to user directory
- **Invalid Bundle**: Verify bundle has valid manifest
- Check logs for `[ERROR]` messages

### Authentication Fails (404/401)

1. Check VS Code GitHub auth (bottom-left avatar)
2. Try GitHub CLI: `gh auth status`
3. Add explicit token with `repo` scope
4. Run: `AI Primitives Hub: Validate Repository Access`
5. Force refresh authentication: `AI Primitives Hub: Force GitHub Authentication`

### GitHub Sign-in Stalls or Source Access Fails

Sign-in, network connectivity, and repository authorization are separate steps.
Use the exact error to choose the next action:

| Symptom | Meaning and next step |
| --- | --- |
| Sign-in timed out | VS Code did not return a GitHub session within 60 seconds. Inspect the **GitHub Authentication** Output channel and complete any browser sign-in prompt. Retry after checking the VPN/proxy connection. |
| HTTP request timed out or response interrupted | Check the network route used by VS Code, including API and asset-download hosts. This is a separate failure from waiting for a sign-in session. |
| 401 | Credentials may be invalid or expired. Run **AI Primitives Hub: Force GitHub Authentication** to request a fresh VS Code session. Cancellation or failure is reported instead of a success notification. |
| 404 | The repository, branch, file, or release may be absent, or the selected credentials may lack access to a private resource. Verify the exact source URL, selected account, repository permissions, and organization SSO authorization. A browser session succeeding does not prove the extension's token has access. |
| 403 or 429 with a rate-limit message | Respect the indicated retry delay. The client honours `Retry-After` and the primary limit reset time. Retry waits share a 60-second budget per request; if the next required wait exceeds the remaining budget, the client reports the required delay rather than retrying early. Network and sign-in time are separate from this budget. A generic 403 can instead indicate a permissions or organization-policy restriction. |

The timeout releases waiting extension operations but cannot cancel VS Code's
underlying sign-in UI. Background retries use a separate silent lookup rather
than rejoining a stuck prompt; if that also remains pending, the existing
authentication fallback is used without another wait. Forced sign-in coordinates
all source lookups so an older session cannot replace the refreshed token.

Use **Sign In Again** to start explicit recovery or **Show Logs** to open the
extension output. If VS Code still has pending sign-in requests, complete or
close the browser prompt, or choose **Reload Window**. Repeated background failures
produce one warning until authentication is explicitly reset. Logs include the
attempt, mode, duration, and outcome without tokens or provider error bodies.

If no VS Code token is available, the existing GitHub CLI fallback may be tried;
check `gh auth status` without copying access tokens into logs. An explicit source
token takes precedence over VS Code authentication, so refreshing VS Code will
not repair an expired explicit token. Likewise, a token from the wrong account
can still be a valid token and produce a 404 for a private repository.

Changing VPN profiles is evidence of a possible routing, proxy, DNS, or network
access-policy difference, not proof of an API quota problem. The shared HTTP
client does not itself configure proxy agents from VS Code settings or proxy
environment variables; behaviour also depends on the host runtime. Follow your
organization's supported network configuration and do not disable TLS checks.

When reporting a failure, include the extension and VS Code versions, action,
time, HTTP status, and sanitized **AI Primitives Hub** and **GitHub Authentication**
Output lines. If available, include `x-ratelimit-remaining`, `x-ratelimit-reset`,
`retry-after`, and `x-github-request-id`. Remove tokens, authorization headers,
proxy credentials, signed query strings, and private repository names.

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

### Bundles Stopped Updating After a Hub Renamed a Repository

When a hub changes the URL of one of its sources, installed bundles normally follow the source to its new URL automatically. If they stopped receiving updates instead, the extension could not prove which new source replaced the old one.

Nothing is lost: the pre-rename source is kept rather than deleted, so your installed bundles stay intact and keep working from where they were installed.

1. Check the logs (`View → Output → AI Primitives Hub`) — a warning names the kept source and the reason its replacement could not be determined
2. Run `AI Primitives Hub: Sync Hub` from the Command Palette to retry the migration
3. If the bundles still don't update, reinstall them from the renamed source in the Registry Explorer — run `AI Primitives Hub: List Sources` to see both the kept source and its replacement
4. Report the reason from the log to the hub author: keeping a source `id` stable while changing its `url` lets installed bundles migrate on their own

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

If all other troubleshooting steps fail, you can completely reset the extension:

1. **Complete Extension Reset** (most thorough):
   - Uninstall the AI Primitives Hub extension
   - Close VS Code completely
   - Delete the extension storage directory:
     - **macOS**: `~/Library/Application Support/Code/User/globalStorage/amadeus-prompt-registry/`
     - **Linux**: `~/.config/Code/User/globalStorage/amadeus-prompt-registry/`
     - **Windows**: `%APPDATA%\Code\User\globalStorage\amadeus-prompt-registry\`
   - Restart VS Code
   - Reinstall the AI Primitives Hub extension

2. **Reset First Run Command** (alternative):
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
