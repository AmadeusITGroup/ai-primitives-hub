# AI Primitives Hub Full Test Plan

All 19 plans covering the manual verification surface across the extension, the CLI, and the published packages.

**This page is not the release gate — [Golden Path Test Cases](./golden-path.md) is.** Run the golden path for every release. Come here when a PR touches a specific area and you want something concrete to run, or when the whole surface needs reviewing end to end.

| Page | Scope |
|---|---|
| [Golden Path Test Cases](./golden-path.md) | The three mandatory scenarios — start here |
| [Testing](../testing.md) | How to run the automated suites |
| [Validation](../validation.md) | Local CI simulation, per-commit checks |
| [Releasing](../releasing.md) | Version bump and publish mechanics |
| **Full Test Plan** (this page) | Area-by-area manual coverage |

## Relationship To The Golden Path

Rows marked **⭐** are part of the golden path. The [golden path page](./golden-path.md) is the lightweight run sheet for those — three chained scenarios with the setup they need, and nothing else. Coverage detail lives here, not there; here the ⭐ rows also sit in their home plan so an area-focused run does not miss them.

| Golden scenario | Plans it draws on |
|---|---|
| G1 — Collection user | TP-01, TP-04, TP-05, TP-07 |
| G2 — Collection author | TP-14, TP-05 |
| G3 — Update | TP-10 |

## Reading The Automation Column

Every scenario carries the automation that already covers it, so manual effort lands where it is actually needed rather than re-proving what vitest and Mocha already assert. Growing this coverage is tracked in [#370](https://github.com/AmadeusITGroup/ai-primitives-hub/issues/370).

| Marker | Meaning | How to treat it |
|---|---|---|
| 🟢 **Auto** | The logic is asserted by a test suite | Quick confirmation. First thing to drop when short on time |
| 🟡 **Partial** | Automation covers the logic, but not the real host, network, filesystem or rendering | Focus on the named gap, not the logic |
| 🔴 **Manual** | No automated coverage exists | **Full attention.** These justify the whole page |

Suite paths are relative to `apps/vscode-extension/` for `test/…`, and to the repository root for `packages/…` and `lib/…`.

A useful shortcut: if a plan is entirely 🟢, running it is a smoke test. If it contains 🔴 rows, those rows are the plan.

**Step-level breakdowns.** TP-07, TP-11 and TP-17 each carry a `Coverage breakdown` section decomposing every scenario into the individual assertions behind it, as `[x]` covered or `[ ]` gap. Those three were done first because they carry the release risk — TP-11 and TP-17 are the non-waivable plans, and TP-07 is the core value path. The remaining plans currently document coverage at suite level only; extending them is tracked in [#370](https://github.com/AmadeusITGroup/ai-primitives-hub/issues/370).

### 🟢 almost always means "green against a fake"

Before treating a 🟢 as settled, check **what the suite talks to**. Very little here touches a real network, filesystem or editor:

| Double | Where | What it hides |
|---|---|---|
| **`nock`** — canned HTTP | 11 suites, including every extension `test/e2e/**` | Real GitHub redirects, rate limits, auth challenges, pagination, archive layout, ETag behaviour |
| **Fake ports** — injected `HttpClient`/`TokenProvider`, `InMemoryFileSystem` | `packages/*` (19 suites use `InMemoryFileSystem`) | No real HTTP, no real disk: path casing, permissions, symlinks, partial writes |
| **Mocked `vscode`** — `test/mocha.setup.js` intercepts `require('vscode')` | Everything outside `test/suite/**` | Activation order, webview lifecycle, context keys, real auth providers |
| **Real filesystem** — `os.tmpdir()`, or a repo-local temp dir | ~25 extension and CLI suites, e.g. `user-scope-service`, `repository-scope-service`, `mcp-config-service`, `scaffold-command` | Nothing, at the fs layer. Still one platform and one host per run |

Practical consequence: the install and update flows are 🟢 largely on the strength of `nock` plus a mocked `vscode`, so **they have never run against real GitHub inside a real editor**. Host path routing is the happier case — it is asserted against a real filesystem.

When closing a gap for [#370](https://github.com/AmadeusITGroup/ai-primitives-hub/issues/370), a new test that fakes the very boundary carrying the risk buys little. Prefer real-fs or contract tests where the risk is I/O.

---

## Host Coverage — VS Code and Kiro

The extension does not just *install for* Kiro and VS Code — it **runs inside both**. Kiro is a VS Code fork, so the same VSIX is loaded by both editors and has to behave correctly in each. Every plan below that touches the filesystem or the UI is therefore run twice: once with the extension running in VS Code, once with it running in Kiro.

**Nothing is tested in Kiro.** The extension runs there fine — Kiro is a VS Code fork and loads the same build — but no automated suite exercises it, because `test/runExtensionTests.js` calls `runTests()` without a `version` option and so always launches VS Code.

That does **not** mean Kiro behaviour is untested. Be precise about the split, because it changes where manual effort is worth spending:

| Kiro concern | Status |
|---|---|
| Path routing (`.kiro/`, `steering/` folding, skills dirs, git-exclude, unsync) | ✅ Covered against a real temp filesystem — `test/services/repository-scope-service.test.ts` (`Host-Aware Destinations`), `test/services/user-scope-service.test.ts` |
| Layout config for the `kiro` target | ✅ `packages/infra/test/stores/layout-config-store.test.ts`, `packages/app/test/writers/file-tree-writer.test.ts` |
| Signal → target mapping | ✅ `packages/infra/test/host-app/host-app-target.test.ts` |
| Activation, UI, webviews, settings **inside Kiro** | ❌ Not tested there — manual only |
| The real `appName`/`uriScheme` a shipped Kiro build reports | ❌ Untested — the one input that decides whether the `vscode` fallback fires |

> Worth knowing while reading the rest of this page: the harness also never reads the `VSCODE_VERSION` environment variable, even though the CI matrix sets it to `stable` and `insiders`. Both matrix legs currently exercise the same default build, so "tested on Insiders" is not something this document can rely on.

### How the host is detected

`resolveHostApp` (in `packages/infra/src/host-app/host-app-target.ts`) matches the lowercased combination of `vscode.env.appName` and `vscode.env.uriScheme` against ordered rules:

| Signal contains | Resolved target |
|---|---|
| `kiro` | `kiro` |
| `windsurf` or `devin` | `windsurf` |
| `insiders` | `vscode-insiders` |
| anything else | `vscode` (the default `.github/` layout) |

**The failure mode to watch for:** detection falls back to `vscode` when a host is unrecognized. In Kiro that fallback is silent and wrong — content lands in `.github/` instead of `.kiro/`. The extension logs the resolved target on every detection (`[host-app] detectHostApp: appName="…", uriScheme="…" -> …`), so the Output channel is the fastest way to confirm the host was identified correctly.

`packages/infra/test/host-app/host-app-target.test.ts` asserts the signal→target mapping for known inputs. What it cannot assert is what `appName` and `uriScheme` a real Kiro build actually reports — which is precisely the input that decides whether the fallback fires.

### Which plans run per host

| Plan | VS Code | Kiro | Note |
|---|---|---|---|
| TP-01 Fresh install and activation | ✅ | ✅ | Host detection happens here |
| TP-02 First-run setup | ✅ | ✅ | |
| TP-06 Marketplace discovery | ✅ | ✅ | Webview theming differs between the two editors |
| TP-07 Bundle installation | ✅ | ✅ | Different destinations and different kind routing |
| TP-08 / TP-09 Profiles | ✅ | ✅ | Activation writes primitives to the host layout |
| TP-11 Repository scope and lockfile | ✅ | ✅ | Host detection decides `.github/` vs `.kiro/` |
| TP-12 Uninstall and cleanup | ✅ | ✅ | |
| TP-15 CLI | ✅ | ✅ | Via explicit `kiro` and `vscode` targets, not detection |
| TP-17 Upgrade and migration | ✅ | ✅ | |
| TP-03, TP-04, TP-05, TP-10, TP-13, TP-14, TP-16, TP-18, TP-19 | ✅ | — | Host-agnostic; run once unless your change touches host handling |

Claude Code and Windsurf are **install targets**, not hosts that run this extension — Claude Code is a CLI and never loads it. Cover them through TP-07 and the CLI's explicit target flags.

## How To Read This Page

The plans run in the order written — a user journey where state carries forward, so you are not rebuilding fixtures for every case. Running a subset is normal: pick the plans covering what changed, and check the preceding plans for state a chosen plan depends on.

Every plan is a happy path. Failure modes, resilience and performance are out of scope; they belong in automation.

---

## TP-01 — Fresh Install and Activation

Run the whole plan twice — once in **VS Code**, once in **Kiro**.

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| ⭐ 1.1 | Install the **compiled extension** into a brand-new VS Code profile, reload, and confirm it runs | Activates; Output channel shows a clean startup with no errors | 🟡 `test/suite/integration-scenarios.test.ts` activates in a real VS Code host |
| ⭐ 1.2 | Install the same build into a clean **Kiro** profile, then reload | Activates identically; no errors caused by the fork | 🔴 **No test covers Kiro — verify manually** |
| ⭐ 1.3 | In each host, read the `[host-app] detectHostApp:` line in the Output channel | Resolves to `vscode` in VS Code and `kiro` in Kiro — **not** the `vscode` fallback while running in Kiro | 🟡 `packages/infra/test/host-app/host-app-target.test.ts` covers the mapping. **The signals Kiro really reports are untested** |
| 1.4 | Open the command palette and type the `AI Primitives Hub:` category | All 66 contributed commands listed and invocable in both hosts | 🟡 `test/suite/integration-scenarios.test.ts` asserts registration for **6 scope commands only** (`syncAllSources`, `moveToUser`, `moveToRepositoryCommit`, `moveToRepositoryLocalOnly`, `switchToLocalOnly`, `switchToCommit`) — the file is otherwise placeholders. **The other 60 commands are unverified** |
| 1.5 | Open the extension's settings page | All 9 `promptregistry.*` settings appear with documented defaults | 🟡 `test/config/package-configuration.test.ts` covers **only the 4 `updateCheck.*` settings**. `autoCheckUpdates`, `installationScope`, `enableLogging`, `githubToken` and `updateCheck.cacheTTL` are unasserted |

## TP-02 — First-Run Setup

Run in both **VS Code** and **Kiro**.

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| ⭐ 2.1 | Activate for the first time with no prior state | Setup flow appears and leads to a usable state | 🟢 `test/services/setup-state-manager.test.ts`, `test/e2e/setup-state-flows.test.ts` |
| 2.2 | Complete it, then reload | Does not reappear; the state it produced is intact | 🟢 `test/services/setup-state-manager.test.ts` (+ `.property.test.ts`) |
| 2.3 | Inspect hubs seeded from `config/defaultHubs.json` | Documented default hubs present and usable | 🟡 Seeding logic covered by `test/e2e/setup-state-flows.test.ts`. **The shipped `defaultHubs.json` content is not validated against reachable hubs** |
| 2.4 | Run `Reset First Run (for Testing)` and reload | Setup flow reappears from a clean slate | 🟢 `test/services/setup-state-manager.test.ts` |
| 2.5 | Compare the setup flow between the two hosts | Wording and steps make sense in Kiro too — no VS Code-only terminology that misleads a Kiro user | 🔴 Copy review; nothing automated |

## TP-03 — Authentication

Runs before anything touching GitHub. The credential established here carries forward.

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| ⭐ 3.1 | Configure a token via the `githubToken` setting | Picked up and used for GitHub API calls | 🟢 `packages/infra/test/auth/default-token-provider.test.ts` |
| 3.2 | Remove the setting, provide a token via the environment | Environment provider takes over transparently | 🟢 `packages/infra/test/auth/env-token-provider.test.ts` |
| 3.3 | Remove that, authenticate via the `gh` CLI | CLI provider used, per the documented precedence | 🟢 `packages/infra/test/auth/gh-cli-token-provider.test.ts`, `composite-token-provider.test.ts` |
| 3.4 | Run `Force GitHub Authentication` | Session re-prompted and refreshed | 🔴 Depends on the real VS Code auth provider; not mockable in our suites |

## TP-04 — Hub Onboarding

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| ⭐ 4.1 | `Import Hub` against a valid hub repository | Hub appears in the tree, populated with its profiles | 🟢 `packages/app/test/registry/hub-manager.test.ts`, `packages/infra/test/hub/hub-resolver.test.ts` |
| 4.2 | `List Hubs` | Every hub listed with accurate metadata | 🟢 `packages/infra/test/stores/hub-store.test.ts` |
| 4.3 | `Sync Hub` after an upstream change | New and changed profiles appear, progress reported | 🟢 `packages/app/test/registry/load-hub-sources.test.ts`, `source-sync-queue.test.ts` |
| 4.4 | Import a second hub, then `Switch Hub` | Active hub changes; tree and marketplace both refresh | 🟡 `packages/infra/test/stores/active-hub-store.test.ts` covers the switch; **the coordinated UI refresh only partly, via `test/ui/ui-source-sync-refresh.test.ts`** |
| 4.5 | `Export Hub Configuration`, then import into a clean profile | Round-trips with no loss | 🟡 `packages/infra/test/hub/validate-hub-config.test.ts` validates the shape. **The export→import round-trip is not asserted end to end** |
| 4.6 | `Open Hub Repository` / `Open Repository` on hub, source, profile and bundle nodes | Each opens the correct upstream URL | 🔴 Opens an external browser; not automatable in-process |
| 4.7 | `Delete Hub` | That hub and its derived state removed; others untouched | 🟢 `packages/app/test/registry/hub-manager.test.ts`, `packages/infra/test/stores/hub-store.test.ts` |

## TP-05 — Sources

Golden coverage is the **GitHub** adapter only. The awesome-copilot, APM, skills and local-path variants are exercised here when your change touches them, and otherwise rely on `packages/infra/test/adapters/**`.

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| ⭐ 5.1 | `Add Source` for a public GitHub repository | Added, immediately enumerates its bundles | 🟢 `test/commands/source-commands.test.ts` (`addSource`: prompts, URL validation, GitHub and local types), `packages/infra/test/adapters/github-adapter.test.ts` |
| 5.2 | `Add Source` for an awesome-copilot source | Added, enumerates its bundles | 🟢 `packages/infra/test/adapters/awesome-copilot-adapter.test.ts` |
| 5.3 | `Sync Source`, then `Sync All Sources` | Content refreshes, progress reported, per-source results visible | 🟢 `packages/app/test/registry/source-sync-queue.test.ts` |
| 5.4 | Sync again with nothing changed upstream | ETag/cache short-circuits instead of refetching the tree | 🟢 `packages/infra/test/harvest/etag-store.test.ts`, `blob-cache.test.ts` |
| 5.5 | `Edit Source` | Change persists and the next sync uses it | 🟢 `test/commands/source-commands.test.ts` (`editSource`: name, URL, type, priority preserved) |
| 5.6 | `Toggle Source Enabled/Disabled` | Disabled source drops out of the marketplace and is skipped by `Sync All Sources` | 🟡 `packages/app/test/registry/load-hub-sources.test.ts` asserts only enabled sources are loaded. **Marketplace filtering after a live toggle is the gap** |
| 5.7 | Sync a source shipping a README and assets | Fetched to the expected location | 🟢 `test/e2e/source-sync-readme-download.test.ts` |
| ⭐ 5.8 | Private GitHub repository using the credential from TP-03 | Content enumerates normally | 🔴 **Needs a real private repository and a real token.** Suites use `nock`, so authorization is never truly exercised |
| 5.9 | Remove all credentials, browse and sync the public source | Public flows work with no credentials | 🟡 Provider fallback covered in `packages/infra/test/auth/**`; the unauthenticated network path is mocked |
| ⭐ 5.10 | Add a **local** source pointing at collection content on disk | Discovered and installable | 🟢 `packages/infra/test/adapters/local-adapter.test.ts` |
| 5.11 | GitHub source exposing multiple collections in one repository | All discovered and listed separately | 🟢 `test/e2e/github-multiple-collections.test.ts` |
| 5.12 | `Remove Source` while its bundles are installed | Source removed, installed bundles intact | 🟡 `test/commands/source-commands.test.ts` (`removeSource`: confirmation, cancellation) covers the command. **That installed bundles survive is not asserted** |

## TP-06 — Marketplace Discovery

Everything in this plan is UI. Automation asserts what the providers return; nobody has automated what the user sees.

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| 6.1 | Open the Marketplace webview with several sources configured | Bundles render with title, description, version, source and icon | 🟡 `test/ui/marketplace-view-provider.test.ts` covers the data handed to the webview. **Rendering is unverified** |
| 6.2 | Search for a known bundle and apply the filters | Relevant results | 🟢 `packages/app/test/registry/search-registry-bundles.test.ts`, `packages/infra/test/search/**` |
| ⭐ 6.3 | Open a bundle's details view | Description, version, contents, source — and the `README.md` renders correctly | 🟡 Wiring covered by `test/ui/marketplace-view-provider.test.ts`. **Rendered markdown is unverified** |
| 6.4 | Reload the window with the marketplace open | Restores without a blank panel or duplicated content | 🟡 `test/ui/marketplace-view-provider.eventHandling.test.ts` |
| ⭐ 6.5 | Repeat 6.1–6.4 with the extension running in **Kiro** | Webviews render and behave the same | 🔴 **No test covers Kiro — verify manually** |

## TP-07 — Bundle Installation

Destinations come from `packages/infra/src/writers/default-layouts.json`. Note the host-specific routing: Kiro folds `prompts/` **and** `instructions/` into `steering/` and has no `hooks/` or `plugins/` route; VS Code routes `chatmodes/` into `agents/`. `deployment-manifest.yml` and `README.md` are never copied into the installed layout.

Layout resolution is well covered by unit tests. What they use is a mocked filesystem — so the manual focus is real files on a real machine, in the real host.

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| ⭐ 7.1 | Install at `user` scope for **VS Code** | Lands under `~/.copilot/` per the kind routes | 🟡 Layer resolution covered by `packages/app/test/install/layout-resolver.test.ts`. **Only skills assert a `~/.copilot/` destination**, and `test/services/skills-service.test.ts` compares a path against itself rather than against production code — treat the general kind set as unverified |
| ⭐ 7.2 | Install at `repository` scope for **VS Code** | Lands under `<workspace>/.github/` | 🟢 `test/e2e/repository-level-installation.test.ts`, `packages/infra/test/writers/repo-scope-writer.test.ts` |
| ⭐ 7.3 | Install at `user` scope for **Kiro** | Lands under `~/.kiro/` | 🟢 `test/services/user-scope-service.test.ts` writes and asserts `~/.kiro/agents/` on a real temp filesystem. (Note: `kiro-transformer.test.ts` is about agent frontmatter `name` fields, **not** routing) |
| ⭐ 7.4 | Install at `repository` scope for **Kiro** | Lands under `<workspace>/.kiro/` | 🟢 `test/services/repository-scope-service.test.ts` (`Host-Aware Destinations`) asserts files land under `.kiro/` and *never* `.github/`, plus skills dirs, git-exclude paths and unsync cleanup |
| 7.5 | Install for Claude Code and Windsurf | Correct per-host transform and layout | 🟢 `packages/app/test/transform/claude-code-transformer.test.ts`, `windsurf-transformer.test.ts` |
| ⭐ 7.6 | Install a collection containing **every primitive kind** | Every kind routed correctly; nothing silently dropped | 🟡 **5 of 7 kinds are covered.** `test/services/repository-scope-service.test.ts` exercises prompts, instructions, agents, chatmodes and skills; `test/e2e/skills-workflow.test.ts` covers four of those. **No suite installs `hooks/` or `plugins/`, and none installs all kinds in one collection** |
| ⭐ 7.7 | In **Kiro**, check where `prompts/` and `instructions/` landed | Both folded into `steering/`; nothing left in a `prompts/` or `instructions/` directory | 🟢 `test/services/repository-scope-service.test.ts` asserts both types resolve to `.kiro/steering/`; `packages/infra/test/stores/layout-config-store.test.ts` asserts `kindRoutes['prompts/'] === 'steering/'` |
| ⭐ 7.8 | Confirm the installed primitives in Copilot and Kiro | Prompts invocable, instructions/steering applied, agents and skills available | 🔴 **Nothing asserts a real agent consumes our output.** Highest-value row in this plan |
| 7.9 | Install a collection declaring MCP servers, in each host | MCP config written to the location that host actually reads | 🟡 `test/services/mcp-config-service.*.test.ts` covers merge, duplicates and inputs. **Per-host config location is the gap** — see the note below |
| 7.10 | Install at `workspace` and `project` scope | Files land in the corresponding workspace paths | 🟢 `test/services/user-scope-service.test.ts`, `packages/app/test/install/layout-resolver.test.ts` |
| 7.11 | `View Bundle Details` on the installed bundle | Installed version, scope and source all accurate | 🟢 `packages/app/test/registry/list-installed-bundles.test.ts` |
| 7.12 | Install a second bundle from a different source | Both coexist; neither overwrites the other | 🟢 `packages/app/test/install/install-bundle.test.ts` |
| ⭐ 7.13 | Repeat 7.1–7.8 through the **CLI**, passing `kiro` and `vscode` as explicit targets | Same on-disk result as the extension | 🟡 `packages/cli/test/commands/install.test.ts` covers the CLI alone. **No test diffs CLI output against extension output** |

`hooks/` and `plugins/` are not supported on Kiro, so there is no scenario for them here. If that changes, add a row and assert the routing.

> **On 7.9.** `McpConfigLocator` resolves the VS Code variant for Insiders, Cursor and Windsurf but has no Kiro branch, and the workspace path is hardcoded to `.vscode`. Verify against whatever the current behaviour is meant to be rather than assuming — this is being addressed separately.

### Coverage breakdown

**7.1–7.4 — the four host/scope destinations**

- [x] VS Code repository → `.github/` preserved *(real fs, mock vscode)*
- [x] Kiro repository → `.kiro/`, never `.github/` *(real fs, mock vscode)*
- [x] Kiro user → `~/.kiro/agents/` *(real fs via tmpdir)*
- [x] `getInstallDirectory` returns `.github`-based paths for repository scope, and still supports user and workspace scope — `test/services/bundle-installer.repositoryScope.test.ts` *(mock vscode)*
- [x] Layer resolution: `kindRoutes` deep-merge, `baseDir` override, `skipPaths` inheritance, `${workspaceRoot}` substitution incl. a `.kiro` baseDir *(pure)*
- [ ] **VS Code user scope → `~/.copilot/` for the general kind set.** Only skills touch this path, and `test/services/skills-service.test.ts` asserts a path against itself
- [ ] Installing while running in Kiro — not tested there

**7.5 — Claude Code and Windsurf**

- [x] Transformer behaviour per target — `packages/app/test/transform/claude-code-transformer.test.ts`, `windsurf-transformer.test.ts`, `transformer-registry.test.ts` *(fake port)*
- [ ] Destination paths for these two hosts asserted on a real filesystem

**7.6–7.7 — every primitive kind**

- [x] Skills install end to end *(nock + mock vscode)*
- [x] `prompts/` and `instructions/` both → `.kiro/steering/` *(real fs)*
- [x] Skill id sanitisation, id override from manifest, unknown item types handled, special characters in paths — `packages/infra/test/writers/repo-scope-writer.test.ts` *(fake port)*
- [x] Prompts, instructions, agents, chatmodes and skills all routed — `test/services/repository-scope-service.test.ts` *(real fs)*
- [ ] A single collection carrying **all** kinds at once
- [ ] `chatmodes/` → `agents/` folding on VS Code

**7.8 — the host agents consume it**

- [ ] Prompts invocable in Copilot; instructions applied; agents selectable
- [ ] Steering, agents and skills in effect in Kiro

**7.9 — MCP servers**

- [x] Config merge, duplicate detection and lifecycle, declared inputs, remote servers — `test/services/mcp-config-service.*.test.ts` *(real fs via tmpdir)*
- [x] Repository-scope MCP handling — `test/services/mcp-server-manager.repositoryScope.test.ts` *(real fs)*
- [ ] The **per-host config location**: `McpConfigLocator` has no Kiro branch and hardcodes `.vscode` for workspace scope

**7.10–7.12 — scopes and coexistence**

- [x] Workspace and project scope paths *(real fs via tmpdir)*
- [x] Installed bundle listing reflects version, scope and source *(fake port)*
- [x] Two bundles coexisting without overwriting *(fake port)*
- [x] Install pipeline stage failures wrapped as typed errors *(fake port)*

**7.13 — CLI parity**

- [x] CLI install/uninstall in isolation *(real fs via tmpdir)*
- [ ] Any test diffing CLI output against extension output

### Destination reference

| Host | User base | Repository base | Notable routing |
|---|---|---|---|
| `vscode` | `~/.copilot` | `<ws>/.github` | `chatmodes/` → `agents/` |
| `vscode-insiders` | `~/.copilot` | `<ws>/.github` | same as `vscode` |
| `kiro` | `~/.kiro` | `<ws>/.kiro` | `prompts/` **and** `instructions/` → `steering/`; no `hooks/`, no `plugins/` |
| `claude-code` | `~/.claude` | `<ws>/.claude` | `prompts/` → `commands/` |
| `windsurf` | `~/.codeium/windsurf` | `<ws>/.windsurf` | `prompts/` and `instructions/` → `rules/` |
| `copilot-cli` | `~/.copilot` | `<ws>/.github` | also skips `collections/` |

## TP-08 — Local Profiles and Favorites

**Effectively fully covered.** `test/commands/profile-commands.test.ts` walks the whole lifecycle — create, edit, activate (including installing bundles and syncing to Copilot), deactivate (with cleanup prompts and optional uninstall), delete (confirmation, refusing to delete an active profile), export, import, list and profile switching. Run this as a smoke pass unless your change is here; the only residual gap is the Kiro host in 8.6.

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| 8.1 | Create a profile referencing several primitives, then reload | Persists exactly as authored | 🟢 `test/commands/profile-commands.test.ts` (`createProfile`: name uniqueness, bundle selection), `packages/app/test/registry/local-profile-crud.test.ts` |
| 8.2 | Activate it | Referenced primitives applied to the workspace | 🟢 `test/commands/profile-commands.test.ts` (`activateProfile`, incl. deactivating others), `packages/app/test/registry/activate-registry-profile.test.ts` |
| 8.3 | Edit and re-activate | Changes take effect with no stale leftovers | 🟢 `test/commands/profile-commands.test.ts` (`editProfile`: rename, add/remove bundles, ID preserved) |
| 8.4 | Deactivate | Primitives removed; unrelated files untouched | 🟢 `packages/app/test/registry/deactivate-registry-profile.test.ts` |
| 8.5 | `Export Profile`, then `Import Profile` on a clean profile | Round-trips completely | 🟢 `test/commands/profile-commands.test.ts` covers both halves — export serializes to JSON with bundle configs and prompts for a location; import prompts for the file, validates structure, handles duplicate names and generates a new ID. Plus `exportLocalProfile`/`importLocalProfile` in `packages/app/test/registry/local-profile-crud.test.ts` (note: `packages/app/test/search/export-profile.test.ts` is a different feature — shortlist→profile export) |
| ⭐ 8.6 | Activate and deactivate the same profile in **VS Code**, then in **Kiro** | Primitives written to and removed from that host's layout, not the other's | 🟡 Activation and deactivation are covered, and path routing is asserted on a real filesystem (see TP-11). **Not tested in Kiro — verify there manually** |
| 8.7 | `List All Profiles` | Complete and accurate | 🟢 `packages/app/test/registry/list-all-profiles.test.ts` |
| 8.8 | `Toggle Favorite`, then switch `Show Favorites` / `Show All Profiles` | Filtered view correct; title actions follow the `promptRegistry.favoritesViewActive` context key | 🟢 `packages/infra/test/stores/favorites-store.test.ts`, `test/ui/registry-tree-provider.test.ts` |
| 8.9 | Delete a profile | Gone from the tree and from `List All Profiles` | 🟢 `packages/app/test/registry/local-profile-crud.test.ts` |

## TP-09 — Hub Profiles and Sync

Better automated than it looks. `test/commands/hub-sync-commands.test.ts` and `test/commands/hub-sync-history.test.ts` cover the update/diff/sync/review commands and the full history lifecycle including rollback. Run this plan as a smoke pass unless your change is here.

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| 9.1 | `Browse Hub Profiles`, then `View Hub Profile` | Content and metadata readable before committing to anything | 🟢 `test/commands/hub-profile-commands.test.ts`, `test/services/hub-manager-profiles.test.ts` |
| ⭐ 9.2 | `Activate Hub Profile` in **VS Code**, then in **Kiro** | Primitives installed into the correct host layout each time; tree reflects the active state | 🟡 `test/commands/hub-profile-activation-commands.test.ts`, `test/services/hub-profile-activation.test.ts`. **Not tested in Kiro — verify there manually** |
| 9.3 | `Show Active Hub Profiles` | Matches what is actually active on disk | 🟢 `packages/infra/test/stores/profile-activation-store.test.ts` |
| 9.4 | Change upstream, then `Check Hub Profile for Updates` | Update detected and flagged | 🟢 `test/commands/hub-sync-commands.test.ts` (`Check For Updates`), `packages/app/test/registry/detect-updates.test.ts` |
| 9.5 | `View Hub Profile Changes` | Diff accurately describes what would change | 🟢 `test/commands/hub-sync-commands.test.ts` (`View Changes`) |
| 9.6 | `Sync Hub Profile Now` | Profile advances to the upstream state | 🟢 `test/commands/hub-sync-commands.test.ts` (`Sync Profile`) |
| 9.7 | `Review and Sync Hub Profile` | Lists each change, allows opting out per change | 🟡 `test/commands/hub-sync-commands.test.ts` (`Review And Sync`) covers the review dialog and the no-changes case. **Opting out of one change while accepting others is not asserted** |
| 9.8 | `View Hub Profile Sync History` | Every sync recorded in order | 🟢 `test/commands/hub-sync-history.test.ts` — records additions, updates, removals and metadata changes; asserts chronological order and limits |
| 9.9 | `Rollback Hub Profile` to a previous entry | Earlier state restored exactly | 🟢 `test/commands/hub-sync-history.test.ts` (`Rollback to History Entry`) — restores state, records the rollback as a new entry, errors on a non-active profile |
| 9.10 | `Clear Hub Profile Sync History`, then `Deactivate Hub Profile` | History clears without touching active state; deactivation removes primitives cleanly | 🟢 `test/commands/hub-sync-history.test.ts` (`Clear History`, including per-profile scoping), `test/services/hub-profile-deactivation.test.ts` |

## TP-10 — Update Lifecycle

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| ⭐ 10.1 | Publish a newer version upstream, then `Check for Bundle Updates` | Bundle flagged in the tree with the correct `contextValue` | 🟢 `test/commands/bundle-commands.checkBundleUpdates.test.ts` (selection dialog, "up to date" case), `packages/app/test/registry/detect-updates.test.ts` |
| ⭐ 10.2 | Confirm the user is **notified** of the available update | Notification appears per the configured preference | 🟡 `test/services/notification-manager.property.test.ts` covers the policy. **The notification a user actually sees is not asserted** |
| ⭐ 10.3 | `Update Bundle` | Version advances; content replaced, not duplicated | 🟢 `test/commands/bundle-commands.updateBundle.test.ts` (incl. the versioned-ID-after-consolidation regression), `test/e2e/bundle-update-github.test.ts` |
| 10.4 | `Enable Auto-Update`, then `Disable Auto-Update` | `contextValue` and available menu entries change to match | 🟢 `test/ui/auto-update-toggle.property.test.ts`, `test/e2e/context-menu-regression.test.ts` |
| 10.5 | `updateCheck.autoUpdate` on, with an update available | Installs in the background and notifies | 🟢 `packages/app/test/update/auto-update.test.ts`, `test/services/auto-update-service.test.ts` |
| 10.6 | Walk `updateCheck.frequency` through `daily`, `weekly`, `manual` | Scheduler honours each value | 🟢 `test/services/update-scheduler.property.test.ts` |
| 10.7 | Check for updates from the **CLI** | Proposed automatically, or reported when checked | 🟢 `packages/cli/test/commands/doctor-status-init-update.test.ts` |
| ⭐ 10.8 | Apply the update from the CLI, then verify in Copilot and Kiro | Same result as the extension; agents pick up new content, stale content gone | 🔴 **The agent-consumption half has no coverage**, and cross-layer parity is manual |

## TP-11 — Repository Scope and Lockfile — **cannot be waived**

`prompt-registry.lock.json` is the source of truth for repository scope. A regression corrupts state a whole team shares through Git.

Run every row in both hosts. Repository scope resolves its destination from host detection, so this is where a detection regression does the most damage. This is the **best-automated** area in the document — which is why the manual focus is narrow and specific: real Git, real clone, real Kiro.

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| ⭐ 11.1 | Install at repository scope in **commit** mode | Committable lockfile entry; files land in the repository | 🟢 `test/services/lockfile-manager.test.ts`, `bundle-installer.repositoryScope.test.ts`, `packages/app/test/stores/json-lockfile-store.test.ts` |
| ⭐ 11.2 | Install at repository scope in **local-only** mode | Entry marked local-only, excluded from the commit | 🟢 `test/services/repository-scope-service.test.ts` (+ `.property.test.ts`) |
| ⭐ 11.3 | Do 11.1 with the extension running in **VS Code**, then in **Kiro** | Content lands in `<ws>/.github/` under VS Code and `<ws>/.kiro/` under Kiro — never `.github/` while running in Kiro | 🟡 `test/services/repository-scope-service.test.ts` (`Host-Aware Destinations`) covers both hosts on a real filesystem, including the no-regression case for `.github/`. **What is untested is detection from a real running Kiro** — the routing is right if the target is right |
| 11.4 | `Move to Repository (Commit)`, then `(Local Only)` from user scope | Files and lockfile move together; `contextValue` updates | 🟢 `test/commands/bundle-scope-commands.test.ts` (`moveToRepository`: both modes, cancellation, not-installed and no-workspace errors) |
| 11.5 | `Move to User` from each repository mode | Reverse move complete, no lockfile residue | 🟢 `test/commands/bundle-scope-commands.test.ts` (`moveToUser`), `test/services/user-scope-service.unsync.test.ts` |
| 11.6 | `Switch to Local Only`, then `Switch to Commit` | Mode flips in place without reinstalling | 🟢 `test/services/repository-scope-service.test.ts` |
| ⭐ 11.7 | Commit the lockfile, clone fresh elsewhere, activate in the host it was created in, then in the **other host** | Bundles restored from the lockfile alone; a lockfile written under one host is read correctly under the other | 🟡 `test/e2e/lockfile-source-of-truth.test.ts` covers restore-from-lockfile. **A real clone, and cross-host reads, are manual** |
| 11.8 | Inspect the lockfile after each operation | Valid, minimal, diff-friendly — no unrelated churn | 🟡 Shape covered by `packages/app/test/stores/json-lockfile-store.test.ts`. **Diff noise is a human judgement** |
| 11.9 | Open a repository whose lockfile came from the **previous major** | Read without migration errors or needless rewriting | 🟡 `test/services/lockfile-manager.test.ts` has a `Backward Compatibility - Legacy SourceId Format` suite (legacy hub-prefixed ids, mixed formats, many segments, write-new/preserve-old), and `test/e2e/lockfile-source-of-truth.test.ts` resolves legacy ids. **What is missing is a lockfile captured from an actually shipped release** |
| 11.10 | Delete an upstream source, then `Clean Up Stale Repository Bundles` | Stale entry removed; valid entries untouched | 🟢 `test/commands/bundle-commands.cleanupStale.property.test.ts`, `test/services/scope-conflict-resolver.test.ts` |

### Coverage breakdown

This is the most heavily automated area in the repository — `test/services/lockfile-manager.test.ts` alone carries well over a hundred assertions, against a **real filesystem**. Read the unticked boxes as the whole point of running TP-11 by hand.

**11.1 / 11.2 — install at repository scope, both modes**

- [x] Lockfile created with `$schema`, `version`, `generatedAt`, `generatedBy`, 2-space indentation *(real fs, mock vscode)*
- [x] Bundle entry records version, `sourceId`, `sourceType`, `installedAt`, file checksums *(real fs)*
- [x] `commitMode` deliberately **not** written into entries — it is implied by which file the entry lives in *(real fs)*
- [x] Commit mode writes `prompt-registry.lock.json`; local-only writes `prompt-registry.local.lock.json` *(real fs; also `packages/app/test/stores/json-lockfile-store.test.ts`, fake port)*
- [x] The two lockfiles stay separate; source, hub and profile sections recorded *(real fs)*
- [x] Local lockfile added to `.git/info/exclude` on first local-only install, not duplicated on later ones, skipped when `.git` is absent *(real fs)*
- [x] Repository scope routes through `RepositoryScopeService`, and `LockfileManager` is **not** called for user scope *(mock vscode)*
- [x] Writer places prompts, instructions, agents and skills, and honours git-exclude only in local-only mode — `packages/infra/test/writers/repo-scope-writer.test.ts` *(fake port)*
- [ ] Behaviour in a repository with an **unusual Git setup** (worktree, submodule, no `.git/info/`, pre-existing exclude section from another tool)

**11.3 — host-aware destination**

- [x] Kiro routes under `.kiro/`, never `.github/`; VS Code keeps `.github/` *(real fs, mock vscode)*
- [x] `getTargetPath`/`getTargetDirectory` host-aware per file type; skills under `.kiro/skills/` *(real fs)*
- [x] Tracked git-exclude paths equal the paths actually written *(real fs)*
- [ ] Detection from a **real running Kiro** — the routing is correct if the resolved target is correct, and that resolution is what is untested

**11.4 / 11.5 / 11.6 — moving and switching**

- [x] `moveToRepository` in both modes, with cancellation and not-installed / no-workspace errors *(mock vscode)*
- [x] `moveToUser` from repository scope *(mock vscode)*
- [x] `updateCommitMode` moves the entry between lockfiles, preserves all metadata, copies the source entry, updates `generatedAt`, errors when the bundle is missing, emits `onLockfileUpdated` *(real fs)*
- [x] Git-exclude added when moving to local-only and removed when the local lockfile empties *(real fs)*
- [x] Other bundles in the source lockfile are preserved *(real fs)*
- [x] `switchCommitMode` scans host-aware directories on a Kiro host *(real fs)*
- [ ] A move performed while the file is **open and dirty** in the editor

**11.7 — clone fresh and restore**

- [x] `listInstalledBundles(repository)` returns bundles from the lockfile; empty when absent *(nock + mock vscode)*
- [x] Lockfile takes precedence over stale `RegistryStorage` records *(nock + mock vscode)*
- [x] Repository install does not create a `RegistryStorage` record *(nock + mock vscode)*
- [x] `sourceId` is deterministic and URL-normalised, so a lockfile is portable across hub configurations *(nock)*
- [ ] An actual `git clone` into a new directory
- [ ] Restoring on a **different OS** from the one that wrote the lockfile
- [ ] Reading a lockfile written under one host while running the other

**11.8 — lockfile hygiene**

- [x] Atomic write via temp file and rename; no corruption under concurrent writes *(real fs)*
- [x] Corrupted lockfile handled gracefully on read; `validate()` reports missing fields and schema version *(real fs)*
- [x] Orphaned sources cleaned up when a bundle is removed; sources still referenced are kept *(real fs, fake port)*
- [x] Conflict detected and logged when the same bundle id exists in both lockfiles *(real fs)*
- [ ] **Diff noise across a realistic sequence of operations** — a human judgement no assertion makes

**11.9 — previous-major lockfile**

- [x] Legacy hub-prefixed `sourceId` read correctly, including multiple and mixed formats and many segments *(real fs)*
- [x] New format written on update, legacy preserved when untouched *(real fs)*
- [ ] A lockfile **captured from an actually shipped release** rather than hand-written in a fixture

**11.10 — stale cleanup**

- [x] Stale entries with missing files removed; info message when there are none; user cancellation respected *(nock + mock vscode)*
- [x] Property-based cleanup coverage — `test/commands/bundle-commands.cleanupStale.property.test.ts` *(mock vscode)*
- [x] Uninstalling the last bundle deletes the lockfile and fires the event with `null`; other bundles preserved *(nock)*

## TP-12 — Uninstall and Cleanup

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| ⭐ 12.1 | Uninstall a user-scope bundle in **VS Code**, then in **Kiro** | Files removed from `~/.copilot/` and `~/.kiro/` respectively | 🟡 `packages/app/test/install/uninstall-bundle.test.ts`, `uninstall-pipeline.test.ts`. **Not tested in Kiro** |
| 12.2 | Uninstall one of two bundles installed side by side | The other's files untouched | 🟢 `packages/app/test/registry/uninstall-installed-bundle.test.ts` |
| ⭐ 12.3 | Uninstall at each repository mode, in both hosts | Files removed from `.github/` or `.kiro/` as appropriate; matching lockfile entry goes too | 🟡 Covered for VS Code by `test/e2e/lockfile-source-of-truth.test.ts`; **not tested in Kiro** |
| 12.4 | Hand-edit an installed file, then uninstall | Local-modification warning appears; choice honoured | 🟢 `test/services/local-modification-warning-service.test.ts` (+ `.property.test.ts`) |
| 12.5 | Leave unrelated files alongside a bundle, then uninstall | Unrelated files preserved | 🟢 `test/e2e/uninstall-preserves-unrelated-files.test.ts` |
| 12.6 | Uninstall everything, then inspect the target directories | No orphaned directories or empty scaffolding | 🟡 Pipeline covered; **leftover empty directories on real disk are the gap** |

## TP-13 — Settings

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| 13.1 | All 9 `promptregistry.*` settings at defaults, main flows exercised | Behaviour matches the documented defaults | 🟡 `test/config/package-configuration.test.ts` asserts schema, defaults and enums for **the 4 `updateCheck.*` settings only**. The remaining 5 have no schema or default assertions |
| 13.2 | `installationScope` set to `user`, `workspace`, `project` in turn | Default install target follows the setting | 🟢 `test/services/user-scope-service.test.ts`, `packages/app/test/install/layout-resolver.test.ts` |
| ⭐ 13.3 | Set the settings in **Kiro** and confirm they are read | Settings apply the same way; nothing depends on a VS Code-only config path | 🔴 **No test covers Kiro — verify manually** |
| 13.4 | Turn `enableLogging` off | Output channel quiet; genuine errors still surfaced | 🟡 Logger behaviour covered in `test/utils/**`; **"errors still reach the user" is a judgement call** |
| 13.5 | Turn `autoCheckUpdates` off and reload | No update check on activation | 🔴 `updateCheck.enabled` scheduling is covered by `test/services/update-scheduler.property.test.ts`, but **`autoCheckUpdates` appears in no behavioural test** — only as a serialized field in `packages/app/test/registry/registry-settings.test.ts` |
| 13.6 | `Export Settings`, then `Import Settings` into a clean profile | Full configuration round-trips | 🟡 `packages/app/test/registry/registry-settings.test.ts` covers serialization properly (JSON/YAML, version checks, replace strategy). `test/commands/settings-commands.test.ts` only asserts the commands are callable. **The clean-profile round-trip is manual** |
| 13.7 | `Open Settings` | Extension's settings scope opens directly | 🔴 No test references the `openSettings` command |
| 13.8 | Compare `reference/settings.md` against `package.json` | Names, types, defaults and enums match exactly | 🔴 **No test compares docs against the manifest.** Easy automation win |

## TP-14 — Authoring, Scaffolding and Publishing

Local authoring is well covered. Everything involving a real GitHub runner is not covered at all.

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| ⭐ 14.1 | `Scaffold Project` into an **empty folder** | Documented structure created, including the CI workflow | 🟢 `test/commands/scaffold-command.test.ts` (directory structure, example files), `test/e2e/github-scaffold-integration.test.ts`, `packages/cli/test/commands/scaffolding.test.ts` |
| 14.2 | `Scaffold Project` in a workspace that already has content | Existing files untouched; nothing clobbered | 🟢 `test/commands/scaffold-command.test.ts` ("should not overwrite existing directory") |
| ⭐ 14.3 | `Add Resource` for each of prompt, instruction, agent and skill, plus a `README.md` | Each created with valid frontmatter from the template | 🟢 `packages/app/test/collection/generate-skill.test.ts`, `lib/test/skills.test.ts` |
| 14.4 | `Create New Collection` | Valid `deployment-manifest.yml` with id, version and name | 🟢 `lib/test/generate-manifest.test.ts`, `packages/core/test/domain/collection/manifest-validator.test.ts` |
| ⭐ 14.5 | `Validate Collections` against it | Passes | 🟢 `lib/test/validate.test.ts`, `lib/test/collections.test.ts` |
| 14.6 | Break the manifest, re-run `Validate Collections` | Errors precise and located | 🟢 `lib/test/validate.test.ts` |
| 14.7 | `Validate APM Package` on a sample package | Reported against `schemas/apm.schema.json` | 🟢 `packages/infra/test/adapters/apm-adapter.test.ts` |
| ⭐ 14.8 | Push to a **real GitHub repository** with the scaffolded runner configuration | Workflow runs and validation passes on the runner | 🔴 **The scaffolded workflow is generated but never executed on a runner** |
| ⭐ 14.9 | Let the workflow finish | A **release is pushed to GitHub** with the expected artifacts and correct version | 🔴 `lib/test/publish-collections.test.ts` is dry-run only. **No real publish is ever tested** |
| ⭐ 14.10 | Change the collection and push again | A new release with a correctly incremented version — not a re-tag, not a skipped bump | 🟡 Version maths covered by `lib/test/hub-release-analyzer.test.ts` and `version-compute`. **Real second release is unverified** |
| 14.11 | `List All Collections` | Complete listing | 🟢 `lib/test/collections.test.ts`, `packages/cli/test/commands/collection-bundle.test.ts` |
| 14.12 | Open a collection, manifest and hub config in the editor | Bundled schemas give completion and inline validation | 🔴 Editor schema association is not tested |
| ⭐ 14.13 | Run 14.1, 14.3, 14.5 and the publish flow through the **CLI** | Same result as the extension | 🟡 Per-command coverage exists. **Cross-layer parity is manual** |

## TP-15 — CLI (`ai-primitives-hub`)

The bar is parity: the same operation must produce the same on-disk result as the extension. Per-command behaviour is well covered; **the parity claim itself is not covered by anything.**

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| 15.1 | `--help`, `--version`, and a subcommand's `--help` | Help renders correctly at every level | 🟢 `packages/cli/test/framework/help-renderer.test.ts`, `golden.test.ts` |
| ⭐ 15.2 | `init`, `status`, `doctor` in a real project | Each reports the environment accurately | 🟡 `packages/cli/test/commands/doctor-status-init-update.test.ts` uses a test context. **A real project is the gap** |
| ⭐ 15.3 | `install`, `apply`, `update`, `uninstall` for a bundle | On-disk result matches the extension for the same bundle | 🟡 `packages/cli/test/commands/install.test.ts`, `uninstall.test.ts`. **Nothing diffs against the extension** |
| ⭐ 15.4 | `source`, `hub`, `profile` subcommands | Parity with the equivalent extension commands | 🟡 `packages/cli/test/commands/source.test.ts`, `hub.test.ts`, `profile.test.ts` — each alone |
| ⭐ 15.5 | `target-types`, then `target-add` for both `vscode` and `kiro` | Both listed as supported; both persisted and reflected in `target-list` | 🟢 `packages/cli/test/commands/target.test.ts`, `packages/infra/test/stores/target-state-store.test.ts` |
| ⭐ 15.6 | Install the same collection with `vscode` and with `kiro` as the target | Files land under `.copilot`/`.github` and `.kiro` respectively, matching what the extension produces in each host | 🟡 Transformers covered per target. **The cross-layer match is manual** |
| 15.7 | `target-remove` for one of them | Removed without disturbing the other target's installed content | 🟢 `packages/cli/test/commands/target.test.ts` |
| 15.8 | `discover` in a real project | Recommendations sensible for the detected context | 🟡 `packages/cli/test/commands/discover.test.ts`, `packages/app/test/discovery/recommendation-engine.test.ts`. **Whether results are *useful* is a judgement** |
| 15.9 | `collection-create/list/validate/affected`, `bundle-build`, `bundle-manifest`, `version-compute` | Correct outputs on a sample collection | 🟢 `packages/cli/test/commands/collection-bundle.test.ts` |
| 15.10 | Generators — `skill-create`, `skill-new`, `skill-validate`, `agent-create`, `hook-create`, `prompt-create`, `instruction-create`, `plugin-create`, `plugins-list` | Each produces a valid artifact | 🟢 `packages/cli/test/commands/scaffolding.test.ts`, `misc.test.ts` |
| 15.11 | Index pipeline — `index-harvest`, `index-build`, `index-search`, `index-shortlist`, `index-stats`, `index-report`, `index-export`, `index-eval` | Index round-trips; search returns expected hits | 🟢 `packages/infra/test/search/**` including `eval-pattern` and `bench` |
| 15.12 | `config-get`, `config-list` | Output reflects real configuration | 🟡 `packages/cli/test/framework/config.test.ts` covers resolution precedence thoroughly (defaults, project, user/XDG, env coercion). **The two commands' own output is not asserted** |
| 15.13 | `completion` for each supported shell | Installs and works | 🟡 `packages/cli/test/commands/completion.test.ts` covers generation. **Installing into a real shell is manual** |
| 15.14 | SEA binary from `pnpm -C packages/cli run build:sea`, on a machine with no Node.js | Runs standalone | 🔴 **`build:sea` never runs in CI.** No test executes the binary |

The CLI has no editor to detect, so it takes the host as an **explicit target** rather than inferring it. That difference is the point of 15.5–15.7: a host bug can exist in one delivery layer and not the other.

## TP-16 — Collection Scripts (`lib`)

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| 16.1 | Install from a clean `npx`, run each of the 11 bins with `--help` | Every bin present and self-documenting | 🔴 `lib/test/cli.test.ts` only tests argument-parsing helpers (`parseSingleArg`, `parseMultiArg`). **No test invokes a bin or its `--help`** |
| ⭐ 16.2 | `validate-collections` and `validate-skills` on valid input | Both pass | 🟢 `lib/test/validate.test.ts`, `lib/test/skills.test.ts` |
| 16.3 | The same two on deliberately invalid input | Failures precise and located | 🟢 `lib/test/validate.test.ts` |
| ⭐ 16.4 | `build-collection-bundle`, `generate-manifest`, `compute-collection-version` twice on the same input | Deterministic and reproducible | 🟢 `lib/test/generate-manifest.test.ts`, `lib/test/bundle-id.test.ts` |
| 16.5 | `detect-affected-collections` against a real diff | Correct affected set | 🟡 `lib/test/collections.test.ts`. **A real Git diff is the gap** |
| 16.6 | `publish-collections` in dry-run | Nothing published | 🟢 `lib/test/publish-collections.test.ts` |
| 16.7 | `list-collections`, `create-skill`, `hub-release-analyzer`, `hub-ownership-analyzer` | Expected report or artifact | 🟡 `lib/test/hub-release-analyzer.test.ts` covers one of the four; **`hub-ownership-analyzer` has no test** |
| ⭐ 16.8 | The `github-actions/validate-collections` action on a sample repository | Passes and fails as expected | 🔴 **This action has no test suite at all**, and consumers depend on it in their own CI |

## TP-17 — Upgrade and Migration from the Previous Major — **cannot be waived**

Run against real state, not a fixture. The migration *mechanism* is covered; **real upgrade-in-place from a previously shipped version is not.**

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| ⭐ 17.1 | Install the **previous major**, build real state — hubs, sources, profiles, favorites, bundles at user and repository scope | A representative starting point exists on disk | 🔴 **No previous-major state fixture exists anywhere** |
| ⭐ 17.2 | Install this release over the top and activate | Migrations run once and complete without error | 🟡 `test/services/migration-registry.test.ts` runs migrations against synthetic state. **Real accumulated state is the gap** |
| ⭐ 17.3 | Inspect all the state from 17.1 | Everything survives intact; nothing silently dropped | 🔴 Nothing asserts survival of state written by a previous release |
| 17.4 | Check the source-id normalization migration | Legacy ids normalized and every reference updated | 🟢 `test/migrations/source-id-normalization-migration.test.ts` |
| 17.5 | Reload and activate again | Migration does not re-run; provably idempotent | 🟢 `test/services/migration-registry.test.ts` |
| ⭐ 17.6 | Run 17.1–17.5 in **VS Code**, then repeat the whole sequence in **Kiro** | Migration works in both hosts; Kiro state is not migrated into VS Code paths or vice versa | 🔴 **Not tested in Kiro**, and no cross-host migration test exists |
| ⭐ 17.7 | On migrated state, confirm installed content is still where the current host expects it | Kiro content still under `.kiro/`, VS Code content still under `.github/` and `~/.copilot/` | 🟡 Path resolution covered by `packages/infra/test/storage/xdg-app-storage.test.ts`. **Post-migration reality is manual** |
| ⭐ 17.8 | Exercise G1 and G3 against the migrated state | Works on migrated data, not only on freshly created data | 🔴 All suites start from clean state |

### Coverage breakdown

The migration **mechanism** is solid. What is absent is any state that a shipped release actually produced — every fixture is hand-built, which is precisely the risk this plan exists to cover.

**17.1 / 17.3 — real previous-major state survives**

- [ ] Any fixture representing state written by a **previously shipped version**
- [ ] Hubs, sources, profiles and favorites asserted to survive an upgrade
- [ ] Installed bundles at user *and* repository scope surviving together
- [ ] A partially-migrated state (upgrade interrupted midway)

**17.2 / 17.5 — migrations run once, and are idempotent**

- [x] Migration executes on first run only; skipped when already completed or explicitly skipped *(mock vscode)*
- [x] Completion persisted with a timestamp; full migration state retrievable *(mock vscode)*
- [x] Errors from a migration propagate rather than being swallowed *(mock vscode)*
- [x] Second run of the source-id migration is a provable no-op *(mock vscode)*
- [ ] Two migrations that must run **in a specific order**, and what happens if one fails midway through a batch

**17.4 — source-id normalization**

- [x] Legacy id migrated to the new id; already-new ids left alone; non-hub ids untouched *(mock vscode)*
- [x] Source **cache files renamed** as part of the migration *(mock vscode)*
- [x] Installation records referencing the old `sourceId` updated *(mock vscode)*
- [x] Lockfiles containing legacy ids still resolve — `test/services/lockfile-manager.test.ts`, `test/e2e/lockfile-source-of-truth.test.ts` *(real fs / nock)*

**17.6 / 17.7 — per host, and content still where the host expects it**

- [x] XDG config/cache/data split; state round-trips and persists across separate storage instances — `packages/infra/test/storage/xdg-app-storage.test.ts` *(fake port)*
- [x] Host-aware destinations after a scope switch *(real fs — see TP-11)*
- [ ] Running the migration sequence **in Kiro** — not tested there
- [ ] That Kiro state is not migrated into VS Code paths, or the reverse
- [ ] Migration on a machine where `XDG_*` variables are set to non-default values

**17.8 — golden path on migrated state**

- [ ] Any suite that starts from migrated rather than clean state. All of them begin clean

## TP-18 — Publish and Distribution

Almost entirely manual by nature — it involves real registries and real releases.

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| 18.1 | Trigger the `Publishing` workflow on a pre-release tag | Every job completes green | 🟡 The workflow gates itself (tag format, audit, Trivy). **A dry run against a real tag is the only real check** |
| ⭐ 18.2 | Review the VS Code Marketplace listing | Correct version, README, icon and categories | 🔴 No coverage |
| 18.3 | Review the Open VSX listing | Same | 🔴 No coverage |
| ⭐ 18.4 | Install from each marketplace into a clean **VS Code**, and into a clean **Kiro** | Works end to end in both; Kiro can install the published artifact, not only a local VSIX | 🔴 No coverage |
| 18.5 | Confirm the rollback path | Previous version still installable; procedure written down | 🔴 No coverage |

## TP-19 — Documentation and Release Notes

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| 19.1 | Compare `reference/commands.md` and `reference/settings.md` against `package.json` | Both match exactly | 🔴 **No docs-vs-manifest check exists.** Same easy automation win as 13.8 |
| 19.2 | Review user guide pages for every changed behaviour | Updated to match the shipped build | 🔴 Editorial judgement |
| 19.3 | `pnpm -C website run build` | Clean build; new pages registered in `docs/README.md` and `website/sidebars.ts` | 🟢 Enforced by the `docs.yml` workflow |
| 19.4 | Read the release notes end to end | Every breaking change listed with a migration note | 🔴 Editorial judgement |
| 19.5 | Check version references in `README.md` | Updated by `version:bump:major` | 🟡 `version:update` rewrites them. **Nothing verifies the result** |
| 19.6 | Regenerate helper skill references via `copy-skill-references` | Reflect the current `docs/` tree | 🔴 **Nothing detects a stale generated index** |

---

## Where The Coverage Gaps Cluster

Pulled out of the tables above. Five themes account for nearly every 🔴 row, and each is a candidate for [#370](https://github.com/AmadeusITGroup/ai-primitives-hub/issues/370):

| Gap | Rows affected | Why automation does not reach it today |
|---|---|---|
| **Nothing is tested in Kiro** (routing itself *is* covered) | 1.2, 6.5, 8.6, 9.2, 12.1, 12.3, 13.3, 17.6 | `runTests()` is called without a `version`, so only VS Code is launched |
| **Host agents consuming our output** | 7.8, 10.8 | Needs a live Copilot or Kiro agent, not files on disk |
| **Real GitHub — runners, releases, private repos** | 5.8, 14.8, 14.9, 18.2–18.4 | Suites use `nock`; `publish-collections` is dry-run only |
| **Cross-layer parity (extension vs CLI)** | 7.13, 14.13, 15.3, 15.4, 15.6 | Both layers tested in isolation; nothing diffs their output |
| **Previous-major upgrade state** | 17.1, 17.3, 17.8 | Every fixture is hand-built; none came from a shipped release. (Legacy `sourceId` formats *are* covered — see 11.9) |
| **Command surface breadth** | 1.4, 1.5, 13.1, 13.5, 13.7 | Only 6 of 66 commands and 4 of 9 settings are asserted anywhere |

### Action items, cheapest first

Each of these closes one or more boxes without new infrastructure:

| # | Action | Closes |
|---|---|---|
| 1 | Extend `test/config/package-configuration.test.ts` to all 9 settings, plus a `getCommands()` sweep over all 66 commands | 1.4, 1.5, 13.1 |
| 2 | Compare `reference/commands.md` and `reference/settings.md` against `package.json` in a test | 13.8, 19.1 |
| 3 | Install the same bundle via extension and CLI, then diff the resulting tree | 7.13, 14.13, 15.3, 15.4, 15.6 |
| 4 | Assert a `~/.copilot/` destination for the general kind set — and fix `test/services/skills-service.test.ts`, which asserts a path against itself | 7.1 |
| 5 | One fixture collection carrying every primitive kind, installed in a single test | 7.6 |
| 6 | Lint the generated CI workflow in the scaffold test | 14.1 |
| 7 | Staleness check on the generated skill-reference index | 19.6 |
| 8 | Capture a lockfile and a state directory from a shipped release as fixtures | 11.9, 17.1, 17.3 |
| 9 | Point `@vscode/test-electron` at the compiled artifact rather than source | 1.1 |
| 10 | Add a scheduled job that pushes to a scratch repository and asserts a real release | 14.8, 14.9 |

Running the extension suites against a Kiro build, and asserting a real agent consumes our output, both need new infrastructure and are not on this list.

Two claims in earlier drafts of this page were wrong and are worth stating plainly, because the same mistake is easy to repeat: hub profile **sync history and rollback are well covered** (`test/commands/hub-sync-history.test.ts`), and `test/commands/**` covers far more of the command surface than the service-level suites suggest. Check `test/commands/` before assuming a command is unautomated.

## Recording A Run

Release sign-off lives on the [golden path page](./golden-path.md#sign-off). When you run plans from this page — because a PR touched a specific area — record which ones in the PR or release issue:

| Plan | Reason it was run | Result | Owner | Date |
|---|---|---|---|---|
| | | | | |

Two plans here block a major release outright, because both touch state users already have on disk:

- [TP-11 — Repository scope and lockfile](#tp-11--repository-scope-and-lockfile--cannot-be-waived)
- [TP-17 — Upgrade and migration](#tp-17--upgrade-and-migration-from-the-previous-major--cannot-be-waived)

## See Also

- [Golden Path Test Cases](./golden-path.md) — the three mandatory scenarios and the release sign-off table
- [Testing](../testing.md) — running the automated suites
- [Validation](../validation.md) — local validation commands
- [Releasing](../releasing.md) — version bump and publish mechanics
- [Testing SSH Remote](./ssh-remote.md) — remote environment testing
