# Live Artifactory replica consumer campaign

This manually triggered campaign imports a pre-published Artifactory hub with
the CLI and the VS Code extension, activates one configured profile in each,
and verifies an installed file. It is deliberately separate from unit tests,
the default VS Code integration suite, and CI. It performs reads and installs
only into temporary directories; it does not publish to Artifactory.

The campaign tests the consumer path, so it does not call GitHub. GitHub API
endpoint configuration belongs with a future, separate replication-preview
campaign rather than being accepted here as an unused setting.

## Required settings

Set these in the repository-root `.art.env` file, in the shell that launches
the campaign, or provide the token at the hidden interactive prompt. `.art.env`
is ignored by git. Do not commit credentials or place token values in command
line arguments.

| Variable | Description |
|---|---|
| `APH_LIVE_ARTIFACTORY_ROOT` | Artifactory repository root containing the hub config. |
| `APH_LIVE_PROFILE_ID` | Profile to activate from that hub. |
| `APH_LIVE_CLI_EXPECTED_FILE` | Non-empty installed file path relative to the temporary CLI target. |
| `APH_LIVE_VSCODE_EXPECTED_FILE` | Non-empty installed file path relative to the isolated VS Code `HOME`. |
| `APH_LIVE_ARTIFACTORY_TOKEN` | Optional bearer token; omit for a publicly readable hub. |

Optional settings:

| Variable | Default | Description |
|---|---|---|
| `APH_LIVE_ARTIFACTORY_CONFIG_FILE` | `__CONFIG__/hub-config.yml` | Config path relative to the Artifactory repository root. |
| `APH_LIVE_ARTIFACTORY_CREDENTIAL_REF` | `ARTIFACTORY_READER_TOKEN` | Environment/SecretStorage label used for the bearer token. |
| `APH_LIVE_HUB_ID` | `live-artifactory-replica` | Isolated hub identifier used by both clients. |
| `APH_LIVE_ARTIFACTORY_AUTH` | `bearer` | Set to `anonymous` to skip token lookup/prompt for a public hub. |
| `APH_LIVE_SOURCE_SYNC_WAIT_MS` | `5000` | Bounded wait for the extension's initial background source sync before activation. |
| `APH_LIVE_OBSERVE_MS` | `15000` | How long the VS Code test window stays open after successful installation. |
| `APH_LIVE_ENV_FILE` | `.art.env` in repository root | Path to a dotenv-style file loaded without shell evaluation. |
| `VSCODE_EXECUTABLE_PATH` | Downloaded by the test harness | Existing VS Code executable to use for the extension-host run. |

The campaign first checks `APH_LIVE_ARTIFACTORY_TOKEN`, then the configured
credential-reference variable (default `ARTIFACTORY_READER_TOKEN`), then
prompts for a hidden token when running in a terminal. Prefer a read-only token.
For unattended runs, provide a token in the environment or set
`APH_LIVE_ARTIFACTORY_AUTH=anonymous`; the campaign never echoes token values.

Expected-file paths must be relative and remain within their respective
temporary install directories. Configure them for the selected profile and
target; the campaign does not assume a particular primitive kind or layout.

## Run

From the repository root:

```bash
pnpm run test:live:replica-consumers
```

The command builds the shared packages and extension before running. The CLI
state, target files, VS Code user data, extensions, and user HOME are isolated
under a temporary directory and removed on completion. The test harness uses the real VS Code extension host; prompt responses are
supplied by the test. During the VS Code phase it opens both Marketplace and
Registry Explorer, activates the profile, shows success notifications, and
keeps the window visible for the configured observation interval.

## Debug launch

Copy the root `.art.env.example` to `.art.env`, configure the replica and
profile, then select **Live Artifactory Replica Consumers** in Run and Debug.
It loads `.art.env` (or `APH_LIVE_ENV_FILE`), builds the packages and
extension, then launches the campaign in the integrated terminal. If no token
is configured, the terminal prompts without echoing input. The debug launch
uses the existing VS Code extension-host test harness and is not part of CI.

Because this campaign accesses configured external services, run it manually
against a staging replica and a read-only Artifactory credential. It is not
invoked by the regular unit/integration test scripts or GitHub Actions.
