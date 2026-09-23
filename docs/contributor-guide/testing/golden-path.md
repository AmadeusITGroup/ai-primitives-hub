# Golden Path Test Cases

The manual runs that must pass for every release, on **both the extension and the CLI**.

Three scenarios, executed in order. They chain — G2 produces the collection G3 updates — so set up once and get all three from one pass. Each covers ground automation cannot: whether a real AI agent picks up what we installed, and whether a real GitHub runner publishes what we scaffolded.

For which parts already have automated coverage and which do not, see the [Full Test Plan](./test-plan.md). This page is the run sheet.

## Before You Start

Run the automated suites first — see [Validation](../validation.md).

You need a clean VS Code profile, Kiro installed, a GitHub account you can create a repository under, and the CLI (`ai-primitives-hub`) available.

Do not reset state between G2 and G3.

---

## G1 — Collection User

Install, connect a hub, install content at both scopes for both hosts, and confirm the AI agent picks it up.

| # | Step | Expected result |
|---|---|---|
| G1.1 | Install the compiled extension into a clean **VS Code** profile, and into a clean **Kiro** profile; reload each | Activates cleanly in both, both views render, setup flow appears once |
| G1.2 | In each host, read the `[host-app] detectHostApp:` line in the Output channel | Resolves to `vscode` in VS Code and `kiro` in Kiro — **not** the `vscode` fallback while running in Kiro |
| G1.3 | Connect a hub and confirm it exposes a **GitHub** source | The source enumerates its bundles |
| G1.4 | Install a collection containing every primitive kind plus a `README.md`, covering all four combinations below | Files land at the documented destination each time |
| G1.5 | Check every primitive kind landed somewhere | Nothing silently dropped |
| G1.6 | Open GitHub Copilot Chat in VS Code | Prompts invocable, instructions applied, agents/chatmodes selectable |
| G1.7 | Open Kiro | Steering files in effect, agents and skills available |
| G1.8 | Open the bundle details view | The collection `README.md` renders correctly |
| G1.9 | Repeat G1.4 through the **CLI** | Same files, same destinations, same lockfile result |

Install matrix for G1.4 — same **GitHub** source throughout, varying scope and host:

| Scope | Host | Destination |
|---|---|---|
| user | VS Code | `~/.copilot/{prompts,instructions,agents,skills,hooks,plugins}/` |
| repository | VS Code | `<workspace>/.github/{prompts,instructions,agents,skills,hooks,plugins}/` |
| user | Kiro | `~/.kiro/{steering,agents,skills}/` |
| repository | Kiro | `<workspace>/.kiro/{steering,agents,skills}/` |

Kiro folds `prompts/` **and** `instructions/` into `steering/`; VS Code routes `chatmodes/` into `agents/`. `deployment-manifest.yml` and `README.md` must **not** appear in the installed layout — the README is checked in the details view at G1.8.

G1.6 and G1.7 are the point of this scenario. Files in the right directory is not the same as the agent recognizing them.

---

## G2 — Collection Author

Scaffold, publish through a real GitHub runner, then consume it back through the hub.

| # | Step | Expected result |
|---|---|---|
| G2.1 | Scaffold a new project into an **empty folder**; add primitives of each kind and a `README.md` | Documented structure created, including the CI workflow |
| G2.2 | Validate the collection locally | Passes |
| G2.3 | Create a real GitHub repository and push | The scaffolded runner configuration is picked up and the workflow runs |
| G2.4 | Let the workflow complete | Validation passes on the runner and a **release is pushed to GitHub** with the expected artifacts |
| G2.5 | Add that repository manually as a source and sync it | The new collection is discovered |
| G2.6 | Install it | Installs correctly, routed per host as in G1 |
| G2.7 | Add the same content as a **local** source and sync | Discovered and installable from the local path too |
| G2.8 | Run G2.1, G2.2 and G2.5–G2.7 through the **CLI** | Same result as the extension |

G2.3 and G2.4 fail more often than anything else here and are invisible to local testing — the scaffolded runner configuration has to work on GitHub's actual runners and actually produce a release.

---

## G3 — Update

Runs immediately after G2, against the collection you just published.

| # | Step | Expected result |
|---|---|---|
| G3.1 | Change the collection from G2 and push | The workflow runs again |
| G3.2 | Let it publish | A **new release** with a correctly incremented version — not a re-tag, not a skipped bump |
| G3.3 | Wait for the extension's update check, or trigger it | The user is **notified** an update is available |
| G3.4 | Apply the update from the extension | Version advances; content replaced, not duplicated |
| G3.5 | Check for updates from the **CLI** | Proposed automatically, or reported when checked |
| G3.6 | Apply the update from the CLI | Same result as G3.4 |
| G3.7 | Verify the updated primitives in Copilot and Kiro | Agents pick up the new content; stale content is gone |

This closes the loop the other two open: author publishes → consumer is told → consumer updates → the agent sees the change. Each link is covered by automation in isolation; the chain is not.

---

## Sign-Off

Record this in the release issue. All three are mandatory on both delivery layers.

| | Scenario | Extension | CLI | Owner | Date |
|---|---|---|---|---|---|
| **G1** | Collection user | | | | |
| **G2** | Collection author | | | | |
| **G3** | Update | | | | |

For a **MAJOR** release, two plans from the full test plan also block, because both touch state users already have on disk:

| | Plan | Result | Owner | Date |
|---|---|---|---|---|
| **TP-11** | [Repository scope and lockfile](./test-plan.md#tp-11--repository-scope-and-lockfile--cannot-be-waived) | | | |
| **TP-17** | [Upgrade and migration](./test-plan.md#tp-17--upgrade-and-migration-from-the-previous-major--cannot-be-waived) | | | |

Blocking rules:

- G1, G2 and G3 must pass on **both** the extension and the CLI.
- TP-11 and TP-17 block a major release outright.
- Anything else is fixed or recorded as a known issue in the release notes, with an owner and a target release.

## See Also

- [Full Test Plan](./test-plan.md) — all 19 plans, with per-step automated-coverage checklists
- [Testing](../testing.md) — running the automated suites
- [Validation](../validation.md) — local validation commands
- [Releasing](../releasing.md) — version bump and publish mechanics
