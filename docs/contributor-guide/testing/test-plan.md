# Manual Test Plan

Ordered plan for the manual verification a person has to perform by hand across the extension, the CLI, and the published packages.

Use it whenever that coverage is needed — a release candidate, a large refactor, a new delivery target, or an environment you have not exercised before. It also serves as the **release gate for a MAJOR release** (`X.0.0`): run every plan, sign off the table at the bottom, and treat the blocking rules there as binding.

This page sits on top of the day-to-day flows:

| Page | Scope |
|---|---|
| [Testing](../testing.md) | How to run the test suites |
| [Validation](../validation.md) | Local CI simulation, per-commit checks |
| [Releasing](../releasing.md) | Version bump and publish mechanics |
| **Manual Test Plan** (this page) | What a person verifies by hand, and the gate for a major release |

## How To Read This Page

The plans run in the order written. That order is a user journey: a tester starts with a clean machine, installs the extension, authenticates, onboards a hub, installs a bundle, manages it, upgrades, and finally validates distribution. Each plan assumes the previous one passed, so state carries forward and you are never setting up fixtures twice.

Running a subset is fine outside a major release — pick the plans that cover what changed, and check the preceding plans for state a chosen plan depends on. A major release runs all of them.

Every plan is a happy path — the flows a real user performs on a good day, described as a scenario rather than an assertion. The gate does not cover failure modes, resilience or performance.

This page does not name the automated suites that cover each area. That mapping lives in [Testing](../testing.md), and the manual run here exists to confirm the real end-to-end path rather than to re-prove logic vitest or Mocha already covers.

Run the standard build, lint and test commands before starting — see [Validation](../validation.md). This page covers only what a person has to verify by hand.

---

## TP-01 — Fresh Install and Activation

Proves the shipped artifact installs and comes up clean on a machine that has never seen the extension.

| # | Scenario | Expected result |
|---|---|---|
| 1.1 | Install the extension from the VS Code Marketplace into a brand-new VS Code profile, then reload | Extension activates; the Output channel shows a clean startup with no errors or warnings |
| 1.2 | Open the activity bar and look at the extension's container | The `AI Primitives Hub` icon is present, and both the `Marketplace` webview and the `Registry Explorer` tree render |
| 1.3 | Open the command palette and type the `AI Primitives Hub:` category | All 66 contributed commands are listed, and each one is invocable without throwing |
| 1.4 | Open the extension's settings page | All 9 `promptregistry.*` settings appear with their documented defaults |
| 1.5 | Note activation time on a workspace that already has installed bundles | No perceptible startup regression versus the previous major |

## TP-02 — First-Run Setup

Proves the onboarding experience a new user actually sees, exactly once.

| # | Scenario | Expected result |
|---|---|---|
| 2.1 | Activate for the first time with no prior state on disk | The setup/welcome flow appears and guides the user to a usable state |
| 2.2 | Complete the setup flow, then reload the window | The flow does not reappear; the state it produced is intact |
| 2.3 | Inspect the hubs seeded from `config/defaultHubs.json` | The documented default hubs are present and usable straight away |
| 2.4 | Run `Reset First Run (for Testing)` and reload | The setup flow appears again from a clean slate — this is the reset path QA relies on for the rest of the gate |

## TP-03 — Authentication

Runs before anything touches GitHub, because the hub and source plans that follow need working credentials. The credential established here carries forward through the rest of the gate.

| # | Scenario | Expected result |
|---|---|---|
| 3.1 | Configure a token via the `githubToken` setting | The token is picked up and used for GitHub API calls |
| 3.2 | Remove the setting and provide a token via the environment | The environment provider takes over transparently |
| 3.3 | Remove the environment variable and authenticate via the `gh` CLI | The CLI provider is used, following the documented precedence order |
| 3.4 | Run `Force GitHub Authentication` | The session is re-prompted and refreshed |
| 3.5 | Work behind an HTTP(S) proxy with the standard proxy environment variables set | All network calls honour the proxy |

## TP-04 — Hub Onboarding

Hubs are the entry point to content, so everything downstream depends on this plan.

| # | Scenario | Expected result |
|---|---|---|
| 4.1 | Run `Import Hub` against a valid hub repository | The hub appears in the tree, populated with its profiles |
| 4.2 | Run `List Hubs` | Every imported hub is listed with accurate metadata |
| 4.3 | Run `Sync Hub` after a profile has changed upstream | New and changed profiles appear; progress is reported while it runs |
| 4.4 | Import a second hub, then `Switch Hub` between the two | The active hub changes, and both the tree and the marketplace refresh to match |
| 4.5 | Run `Export Hub Configuration`, then import the exported file into a clean profile | The hub configuration round-trips with no loss |
| 4.6 | Use `Open Hub Repository` and `Open Repository` on hub, source, profile and bundle nodes | Each opens the correct upstream URL |
| 4.7 | Run `Delete Hub` on one of the two hubs | That hub and its derived state are removed; the other hub is untouched |

## TP-05 — GitHub Sources

| # | Scenario | Expected result |
|---|---|---|
| 5.1 | Run `Add Source` for a public GitHub repository | The source is added and immediately enumerates the bundles it offers |
| 5.2 | Run `Sync Source` on it, then `Sync All Sources` | Content refreshes, progress is reported, and per-source results are visible |
| 5.3 | Sync the same source again with nothing changed upstream | ETag/cache short-circuits the fetch instead of redownloading the tree |
| 5.4 | Run `Edit Source` to change its configuration | The change persists and the next sync uses it |
| 5.5 | Run `Toggle Source Enabled/Disabled` | A disabled source disappears from marketplace results and is skipped by `Sync All Sources`; re-enabling restores it |
| 5.6 | Sync a source that ships a README and assets | The README and assets are fetched to the expected location |
| 5.7 | Add a source pointing at a **private** GitHub repository, using the credential from TP-03 | Content enumerates normally |
| 5.8 | Remove all credentials, then browse and sync the public source | Public flows work unchanged with no credentials at all |
| 5.9 | Add a GitHub source that exposes multiple collections in one repository | All collections are discovered and listed separately |
| 5.10 | Sync a source backed by a large repository tree | Completes in reasonable time and the UI stays responsive throughout |
| 5.11 | Run `Remove Source` for a source whose bundles are installed | The source is removed and the installed bundles remain intact |

## TP-06 — Marketplace Discovery

The primary way users find content before installing it.

| # | Scenario | Expected result |
|---|---|---|
| 6.1 | Open the Marketplace webview with several sources configured | Bundles render with title, description, version, source and icon |
| 6.2 | Search for a known bundle and apply the available filters | Results are relevant and update responsively |
| 6.3 | Open a bundle's details view | The webview shows description, version, contents and originating source |
| 6.4 | Switch VS Code between light, dark and high-contrast themes | Both webviews re-render correctly in each theme |
| 6.5 | Navigate and operate both webviews using only the keyboard | Every action is reachable, focus order is sensible, and controls are labelled for a screen reader |
| 6.6 | Reload the window with the marketplace open | The view restores without a blank panel or duplicated content |

## TP-07 — Bundle Installation

The core value path. Run this at user scope first; repository scope gets its own plan later.

| # | Scenario | Expected result |
|---|---|---|
| 7.1 | Install a bundle from the marketplace at `user` scope | Progress is shown, files land in the XDG-resolved user location, and the tree updates on completion |
| 7.2 | Install a bundle at `workspace` scope, then another at `project` scope | Files land in the corresponding workspace paths for each scope |
| 7.3 | Install into each supported target host app — Copilot, Claude Code, Kiro, Windsurf | Each host receives the correct per-host transform and file layout |
| 7.4 | Install a bundle that contains prompts, instructions, agents and skills together | Every primitive type is written to its correct destination |
| 7.5 | Run `View Bundle Details` on the installed bundle | Installed version, scope and source are all accurate |
| 7.6 | Install a second bundle from a different source | Both coexist; neither overwrites the other's files |

## TP-08 — Local Profiles and Favorites

| # | Scenario | Expected result |
|---|---|---|
| 8.1 | Create a profile referencing several primitives, then reload the window | The profile persists exactly as authored |
| 8.2 | Activate the profile | Its referenced primitives are applied to the workspace |
| 8.3 | Edit the profile and re-activate it | Changes take effect without a stale leftover from the previous activation |
| 8.4 | Deactivate the profile | The applied primitives are removed and unrelated files are untouched |
| 8.5 | Run `Export Profile`, then `Import Profile` on another machine or clean VS Code profile | The profile round-trips completely |
| 8.6 | Run `List All Profiles` | The listing is complete and accurate |
| 8.7 | Mark profiles with `Toggle Favorite`, then switch between `Show Favorites` and `Show All Profiles` | The filtered view is correct and the `promptRegistry.favoritesViewActive` context key drives the right title actions |
| 8.8 | Delete a profile | It disappears from the tree and from `List All Profiles` |

## TP-09 — Hub Profiles and Sync

The team-sharing path: profiles that come from a hub and stay in step with it.

| # | Scenario | Expected result |
|---|---|---|
| 9.1 | Run `Browse Hub Profiles`, then `View Hub Profile` on one of them | Content and metadata are correct and readable before committing to anything |
| 9.2 | Run `Activate Hub Profile` | The profile's primitives are installed and the tree reflects the active state |
| 9.3 | Run `Show Active Hub Profiles` | The list matches what is actually active on disk |
| 9.4 | Change the profile upstream, then run `Check Hub Profile for Updates` | The update is detected and flagged |
| 9.5 | Run `View Hub Profile Changes` | The diff accurately describes what would change |
| 9.6 | Run `Sync Hub Profile Now` | The profile advances to the upstream state |
| 9.7 | Make another upstream change and run `Review and Sync Hub Profile` | The review step lists each change and lets the user opt out per change |
| 9.8 | Run `View Hub Profile Sync History` | Every sync performed above is recorded in order |
| 9.9 | Run `Rollback Hub Profile` to a previous entry | The earlier state is restored exactly |
| 9.10 | Run `Clear Hub Profile Sync History`, then `Deactivate Hub Profile` | History clears without touching active state; deactivation then removes the primitives cleanly |

## TP-10 — Update Lifecycle

| # | Scenario | Expected result |
|---|---|---|
| 10.1 | Publish a newer bundle version upstream, then run `Check for Bundle Updates` | The updatable bundle is flagged in the tree with the correct `contextValue` |
| 10.2 | Run `Update Bundle` on it | The version advances and local content is replaced correctly |
| 10.3 | Make two bundles updatable, then run `Update All Bundles` | Both advance, with progress reported per bundle |
| 10.4 | Run `Enable Auto-Update` on a bundle, then `Disable Auto-Update` | The `contextValue` and the available menu entries change to match each state |
| 10.5 | Set `updateCheck.autoUpdate` to `true` and make an update available | The update installs in the background and the user is notified |
| 10.6 | Walk `updateCheck.frequency` through `daily`, `weekly` and `manual` | The scheduler honours each value and does not check outside it |
| 10.7 | Walk `updateCheck.notificationPreference` through `all`, `critical` and `none` | Notification volume matches the setting exactly |

## TP-11 — Repository Scope and Lockfile — **cannot be waived**

`prompt-registry.lock.json` is the source of truth for repository scope. A regression here corrupts state that a whole team shares through Git, so this plan gets the most attention of any in the gate.

| # | Scenario | Expected result |
|---|---|---|
| 11.1 | Install a bundle at repository scope in **commit** mode | The lockfile is created/updated with a committable entry, and the files land in the repository |
| 11.2 | Install another at repository scope in **local-only** mode | Its lockfile entry is marked local-only and is excluded from what gets committed |
| 11.3 | From a user-scope bundle, run `Move to Repository (Commit)` and then `Move to Repository (Local Only)` | Files and lockfile move together each time, and the tree `contextValue` updates to the new scope |
| 11.4 | Run `Move to User` from each repository mode | The reverse move is complete and leaves no lockfile residue |
| 11.5 | Run `Switch to Local Only`, then `Switch to Commit` | The mode flips in place without reinstalling the bundle |
| 11.6 | Commit the lockfile, clone the repository fresh elsewhere, and activate the extension | Bundles are restored from the lockfile alone, with no other local state needed |
| 11.7 | Inspect the lockfile after each operation above | It stays valid, minimal and diff-friendly — no churn unrelated to the action performed |
| 11.8 | Open a repository whose lockfile was written by the **previous major** version | Read without migration errors and without rewriting the file unnecessarily |
| 11.9 | Delete a bundle's upstream source, then run `Clean Up Stale Repository Bundles` | The stale entry is identified and removed; valid entries are left alone |

## TP-12 — Uninstall and Cleanup

The end of the bundle lifecycle, and the plan most likely to reveal file-level bugs.

| # | Scenario | Expected result |
|---|---|---|
| 12.1 | Uninstall a bundle installed at user scope | Exactly that bundle's files are removed |
| 12.2 | Uninstall one of two bundles installed side by side | The other bundle's files are untouched |
| 12.3 | Uninstall a bundle at each repository mode | Files and the matching lockfile entry are both removed |
| 12.4 | Hand-edit a file belonging to an installed bundle, then uninstall it | The local-modification warning appears and the user's choice is honoured |
| 12.5 | Add unrelated files alongside an installed bundle, then uninstall | Unrelated files are preserved |
| 12.6 | Uninstall every bundle, then inspect the target directories | No orphaned directories or empty scaffolding left behind |

## TP-13 — Settings

| # | Scenario | Expected result |
|---|---|---|
| 13.1 | Leave all 9 `promptregistry.*` settings at their defaults and exercise the main flows | Behaviour matches what the documentation describes as default |
| 13.2 | Set `installationScope` to `user`, `workspace` and `project` in turn and install a bundle each time | The default install target follows the setting |
| 13.3 | Turn `enableLogging` off | The Output channel goes quiet, but genuine errors are still surfaced to the user |
| 13.4 | Turn `autoCheckUpdates` off and reload | No update check runs on activation |
| 13.5 | Run `Export Settings`, then `Import Settings` into a clean VS Code profile | The full configuration round-trips |
| 13.6 | Run `Open Settings` | The extension's own settings scope opens directly |
| 13.7 | Compare `reference/settings.md` against `package.json` | Names, types, defaults and enum values match exactly |

## TP-14 — Authoring, Scaffolding and Validation

The collection-author journey, which shares the schemas the extension consumes.

| # | Scenario | Expected result |
|---|---|---|
| 14.1 | Run `Scaffold Project` in an empty workspace | The documented structure is created and immediately usable |
| 14.2 | Run `Scaffold Project` in a workspace that already has content | Existing files are left alone; nothing is clobbered |
| 14.3 | Run `Add Resource` once for each of prompt, instruction, agent and skill | Each file is created with valid frontmatter from the template |
| 14.4 | Run `Create New Collection` | A valid `deployment-manifest.yml` is produced with id, version and name |
| 14.5 | Run `Validate Collections` against that collection | It passes |
| 14.6 | Break the manifest deliberately and re-run `Validate Collections` | Errors are precise and point at the offending location |
| 14.7 | Run `Validate APM Package` on a sample package | Results are reported against `schemas/apm.schema.json` |
| 14.8 | Run `List All Collections` | The listing is complete |
| 14.9 | Open a collection, manifest and hub config in the editor | The bundled schemas provide completion and inline validation |

## TP-15 — CLI (`ai-primitives-hub`)

The second delivery layer. The bar is parity: the same operation must produce the same on-disk result as the extension.

| # | Scenario | Expected result |
|---|---|---|
| 15.1 | Run `--help` and `--version`, then a subcommand's `--help` | Help renders correctly at every level |
| 15.2 | Run `init`, then `status`, then `doctor` in a real project | Each reports the environment accurately |
| 15.3 | Run `install`, `apply`, `update` and `uninstall` for a bundle | The on-disk result matches what the extension produces for the same bundle |
| 15.4 | Exercise the `source`, `hub` and `profile` subcommands | Behaviour is at parity with the equivalent extension commands |
| 15.5 | Run `target-types`, `target-add`, `target-list` and `target-remove` | Target state is persisted and reflected correctly |
| 15.6 | Run `discover` in a real project | Recommendations are sensible for the detected context |
| 15.7 | Run `collection-create`, `collection-list`, `collection-validate`, `collection-affected`, `bundle-build`, `bundle-manifest` and `version-compute` | Correct outputs on a sample collection |
| 15.8 | Run the generators — `skill-create`, `skill-new`, `skill-validate`, `agent-create`, `hook-create`, `prompt-create`, `instruction-create`, `plugin-create`, `plugins-list` | Each produces a valid artifact |
| 15.9 | Run the index pipeline — `index-harvest`, `index-build`, `index-search`, `index-shortlist`, `index-stats`, `index-report`, `index-export`, `index-eval` | The index round-trips and search returns the expected hits |
| 15.10 | Run `config-get` and `config-list` | Output reflects real configuration |
| 15.11 | Install shell completion via `completion` for each supported shell | Completion installs and works |
| 15.12 | Build the SEA binary with `pnpm -C packages/cli run build:sea` and run it on a machine with no Node.js | The binary runs standalone |

## TP-16 — Collection Scripts (`lib`)

Published to npm independently, and consumed by collection authors and CI.

| # | Scenario | Expected result |
|---|---|---|
| 16.1 | Install the package from a clean `npx` and run each of the 11 bins with `--help` | Every bin is present and self-documenting |
| 16.2 | Run `validate-collections` and `validate-skills` against valid input | Both pass |
| 16.3 | Run the same two against deliberately invalid input | Failures are precise and located |
| 16.4 | Run `build-collection-bundle`, `generate-manifest` and `compute-collection-version` twice on the same input | Output is deterministic and reproducible |
| 16.5 | Run `detect-affected-collections` against a real diff | The affected set is correct |
| 16.6 | Run `publish-collections` in dry-run mode | Nothing is published |
| 16.7 | Run `list-collections`, `create-skill`, `hub-release-analyzer` and `hub-ownership-analyzer` | Each produces the expected report or artifact |
| 16.8 | Run the `github-actions/validate-collections` action against a sample repository | Passes and fails as expected — note this action has no test suite of its own |

## TP-17 — Upgrade and Migration from the Previous Major — **cannot be waived**

This is the plan that decides whether existing users survive the release. Run it against real state, not a fixture.

| # | Scenario | Expected result |
|---|---|---|
| 17.1 | Install the **previous major**, then build up real state — hubs, sources, profiles, favorites, installed bundles at user and repository scope | A representative starting point exists on disk |
| 17.2 | Install this release over the top and activate | Migrations run once and complete without error |
| 17.3 | Inspect all the state from 17.1 | Hubs, sources, profiles, favorites and installed bundles all survive intact; nothing is silently dropped |
| 17.4 | Check the source-id normalization migration specifically | Legacy source ids are normalized and every reference to them is updated |
| 17.5 | Reload the window and activate again | The migration does not re-run and is provably idempotent |

## TP-18 — Publish and Distribution

Run against a pre-release tag first, then the real one.

| # | Scenario | Expected result |
|---|---|---|
| 18.1 | Trigger the `Publishing` workflow on a pre-release tag | Every job completes green |
| 18.2 | Review the VS Code Marketplace listing | Correct version, README, icon and categories |
| 18.3 | Review the Open VSX listing | Same |
| 18.4 | Install from each marketplace into a clean VS Code | Works end to end |
| 18.5 | Download the GitHub release installation bundle and run `install.sh`, then `install.bat` on Windows | Both install successfully |
| 18.6 | Verify the checksums and SLSA provenance attached to the release | Both verify |
| 18.7 | Confirm the rollback path | The previous version is still installable, and the procedure is written down |

## TP-19 — Documentation and Release Notes

Last, because it documents everything the earlier plans confirmed.

| # | Scenario | Expected result |
|---|---|---|
| 19.1 | Compare `reference/commands.md` and `reference/settings.md` against `package.json` | Both match exactly |
| 19.2 | Review the user guide pages for every changed behaviour | Updated to match the shipped build |
| 19.3 | Build the docs site with `pnpm -C website run build` | Clean build; new pages registered in `docs/README.md` and `website/sidebars.ts` |
| 19.4 | Read the release notes end to end | Every breaking change is listed with a migration note |
| 19.5 | Check version references in `README.md` | Updated by `version:bump:major` |
| 19.6 | Regenerate the bundled helper skill references via `copy-skill-references` | Reflect the current `docs/` tree |

---

## Sign-Off — Major Release Gate

When this plan is used as the gate for a major release, it ships only once every row is signed. Record this table in the release issue.

| Order | Area | Plans | Owner | Result | Date |
|---|---|---|---|---|---|
| 1 | Install and onboarding | TP-01, TP-02 | | | |
| 2 | Authentication | TP-03 | | | |
| 3 | Hubs and sources | TP-04, TP-05 | | | |
| 4 | Discovery | TP-06 | | | |
| 5 | Install lifecycle | TP-07, TP-12 | | | |
| 6 | Profiles | TP-08, TP-09 | | | |
| 7 | Updates | TP-10 | | | |
| 8 | Repository scope and lockfile | TP-11 | | | |
| 9 | Settings and authoring | TP-13, TP-14 | | | |
| 10 | CLI and collection scripts | TP-15, TP-16 | | | |
| 11 | Upgrade and migration | TP-17 | | | |
| 12 | Publish and distribution | TP-18 | | | |
| 13 | Documentation | TP-19 | | | |

Blocking rules:

- Any failure in TP-11 or TP-17 blocks the release outright.
- Failures elsewhere are either fixed or recorded as a known issue in the release notes, with an owner and a target release.

## See Also

- [Testing](../testing.md) — running the suites
- [Validation](../validation.md) — local validation commands
- [Releasing](../releasing.md) — version bump and publish mechanics
- [Architecture: Validation](../architecture/validation.md) — how validation is implemented
