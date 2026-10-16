# Testing User-Scoped Customization Discovery in WSL

This document describes the open questions around user-scoped AI customization
discovery when the AI Primitives Hub extension runs in a VS Code Remote WSL
window. It provides a repeatable test strategy for maintainers. It does not
propose further implementation changes.

## Purpose

The extension installs several customization types, including prompts,
instructions, custom agents, and skills. In Remote WSL, two user homes and
multiple agent harnesses may be involved:

- the Windows user home and VS Code profile;
- the WSL user home;
- the Local harness, which runs through the VS Code extension host;
- the Copilot harness, which runs in the Agent Host and can target a connected
  WSL environment.

A path that works for one primitive or harness is not necessarily correct for
another. Tests must therefore verify actual discovery by the selected harness,
not only the path produced by `UserScopeService`.

## Scope

This analysis covers:

- user-scoped installations;
- VS Code Stable and Insiders connected to WSL;
- prompts, instructions, custom agents, legacy chat modes, and skills;
- Local and Copilot harness behavior;
- installation and removal of skill-only bundles.
- the planned convergence of extension and CLI storage on XDG conventions.

It does not cover repository-scoped customizations, non-VS Code targets, or
cloud-only sessions.

## Background

The behavior evolved through three related changes:

1. [Issue #215](https://github.com/AmadeusITGroup/ai-primitives-hub/issues/215)
   reported that prompts, instructions, and custom agents installed in the WSL
   filesystem were not discovered by VS Code, while skills were discovered.
2. [PR #231](https://github.com/AmadeusITGroup/ai-primitives-hub/pull/231)
   introduced WSL-aware Windows-home resolution and copied files across the
   WSL-to-Windows filesystem boundary. This addressed the observed Local
   harness behavior, particularly for prompts stored on the VS Code side.
3. [Issue #515](https://github.com/AmadeusITGroup/ai-primitives-hub/issues/515)
   demonstrated that applying Windows-home resolution to skills prevents the
   Copilot harness in WSL from discovering them.
   [PR #516](https://github.com/AmadeusITGroup/ai-primitives-hub/pull/516)
   keeps user-scoped skills in the WSL home while preserving the existing
   Windows-home behavior for other primitive types.

Issue #215 is evidence for the environment and VS Code behavior tested at that
time. It is not proof that every non-skill primitive must always use the Windows
home. VS Code now distinguishes between Local and Copilot harness
customization locations.

## Planned Direction: Shared XDG Storage

Maintainers have indicated that the extension and CLI are expected to converge
on a shared XDG-based storage model. The goal is to replace the current
VS Code-specific internal storage behavior with consistent locations across
delivery surfaces.

This is a planned direction, not the currently implemented path contract. The
design must distinguish two responsibilities:

1. **Internal AI Primitives Hub storage**, including the bundle cache, registry
   state, indexes, and application configuration.
2. **Published customization targets**, which must remain compatible with the
   discovery rules of VS Code, Copilot, Claude, and other consumers.

For example, a bundle may be cached under an XDG data directory while a
published skill still needs to be copied or linked to a consumer-supported
location such as `~/.copilot/skills`. Moving the cache to XDG does not by
itself make the customization discoverable.

The project already contains XDG storage infrastructure in
[`xdg-base-dirs.ts`](../../../packages/infra/src/storage/xdg-base-dirs.ts).
Future work should define which data belongs there and which files are
consumer-facing publication artifacts.

An XDG migration should avoid replacing one implicit rule with another. The
path contract must identify:

- the authoritative bundle and state location;
- the target consumer and harness;
- ownership of each published file;
- synchronization between extension and CLI operations;
- migration, rollback, and cleanup behavior.

## Verified Facts and Current Assumptions

### Verified

- Personal skills are documented under home-directory locations such as
  `~/.copilot/skills` and `~/.agents/skills`.
- In the environment reported by Issue #515, a skill under the WSL user's
  `~/.copilot/skills` directory was discovered, while the same skill under the
  Windows user's directory was not.
- Prompt files are supported by the Local harness, not the Copilot harness.
- Local harness user prompts are associated with VS Code profile storage.
- Copilot-harness agents and instructions use harness directories such as
  `~/.copilot/agents` and `~/.copilot/instructions`.
- User-level harness customizations must be present on the machine where the
  selected harness runs.
- The current VS Code user layout uses `${HOME}/.copilot` as its base and
  routes primitive types into subdirectories. See
  [`default-layouts.json`](../../../packages/infra/src/writers/default-layouts.json).

### Assumptions Requiring Manual Verification

- Windows-side placement remains correct for Local harness prompts in all
  supported VS Code versions and profile configurations.
- Windows-side placement is correct for Local harness custom agents and
  instructions.
- WSL-side placement is required for Copilot-harness custom agents and
  instructions when the session targets the connected WSL host.
- VS Code Stable and Insiders apply the same discovery rules.
- A user-level customization installed in one harness-specific location should
  not be expected to appear in another harness.

Do not convert these assumptions into path rules without recording discovery
evidence from a real VS Code session.

## Primitive and Harness Matrix

The table below is a test hypothesis, not a final path contract.

| Primitive | Local harness hypothesis | Copilot harness hypothesis | Confidence |
|---|---|---|---|
| Prompt | VS Code user profile on the Windows side | Unsupported; convert to a skill | High |
| Skill | Personal home visible to the selected execution environment | WSL `~/.copilot/skills` for a WSL target | High for the reported WSL case |
| Custom agent | VS Code profile storage | WSL `~/.copilot/agents` for a WSL target | Medium |
| Instructions | VS Code profile storage | WSL `~/.copilot/instructions` for a WSL target | Medium |
| Legacy chat mode | Treat as a Local custom-agent compatibility case | Verify migration or transformed agent behavior | Low |

The extension currently cannot infer every harness and execution-environment
combination from the primitive type alone. Any future design should explicitly
define which harness an installation targets.

## Why Unit Tests Are Not Sufficient

Unit tests can verify:

- the path selected for each primitive type;
- whether Windows-home resolution invokes `cmd.exe`;
- copying versus symlinking in WSL;
- installation and removal behavior;
- fallback behavior when Windows-home detection fails.

They cannot prove that VS Code or an Agent Host actually discovers and loads a
customization. Discovery is external behavior and requires a real VS Code
session with the relevant harness selected.

The existing automated test commands are documented in the
[Testing Guide](../testing.md). Real discovery should remain a manual or
purpose-built integration test until the project has a supported Agent Host
test harness.

## Test Environment Record

Record the following values for every manual run:

| Field | Example |
|---|---|
| Windows version | Windows 11 24H2 |
| WSL distribution and version | Ubuntu 24.04, WSL 2 |
| VS Code channel and version | Stable 1.x |
| Remote - WSL extension version | version |
| GitHub Copilot extension version | version |
| AI Primitives Hub version or commit | version or SHA |
| Selected VS Code profile | Default or named profile |
| Selected harness | Local or Copilot |
| Selected execution environment | connected WSL host |
| Windows home as seen from WSL | `/mnt/c/Users/<user>` |
| WSL home | `/home/<user>` |
| Relevant experimental settings | names and values |

Do not include access tokens, authentication headers, or unrelated environment
variables in attached logs.

## Test Fixture Design

Use distinct names and marker text for every candidate location. Never copy the
same fixture to multiple locations at once because that makes the discovery
source ambiguous.

Recommended fixture names:

- `profile-prompt-probe.prompt.md`;
- `windows-prompt-probe.prompt.md`;
- `wsl-prompt-probe.prompt.md`;
- `profile-agent-probe.agent.md`;
- `windows-agent-probe.agent.md`;
- `wsl-agent-probe.agent.md`;
- `profile-instructions-probe.instructions.md`;
- `windows-instructions-probe.instructions.md`;
- `wsl-instructions-probe.instructions.md`;
- `windows-skill-probe/SKILL.md`;
- `wsl-skill-probe/SKILL.md`.

Each fixture should contain a unique, harmless marker that can be observed in
the UI or response, for example `WSL_INSTRUCTIONS_PROBE_ACTIVE`.

## Candidate Locations

Test each location independently:

1. The canonical user location selected by VS Code through its customization
   creation UI. This is the control case and should not be hard-coded.
2. The Windows user's Copilot directory, visible from WSL as
   `/mnt/c/Users/<user>/.copilot/<primitive>`.
3. The WSL user's Copilot directory,
   `/home/<user>/.copilot/<primitive>`.
4. Where applicable, the equivalent `.agents` location documented by the
   selected harness.

Before each run, remove or rename competing fixtures, reload the VS Code
window, and start a new chat session.

## Manual Test Procedures

### Prompt Discovery

1. Select the Local harness.
2. Create a user prompt through **Chat: New Prompt File** and record the path
   chosen by VS Code. This is the control.
3. Create separate Windows-home and WSL-home prompt probes.
4. Test one probe at a time.
5. Run **Developer: Reload Window** and open a new Local chat.
6. Type `/` and record whether the probe appears.
7. Open the Agent Customizations editor and record whether the probe is listed.
8. Invoke the prompt and verify its unique marker.
9. Repeat with the Copilot harness. The expected result is that prompt files
   are not loaded by that harness.

Pass criteria:

- the control prompt is discovered by Local;
- the source location of every discovered probe is unambiguous;
- no prompt is reported as supported by Copilot unless current VS Code
  documentation and observed behavior both confirm it.

### Skill Discovery

1. Create a valid skill with a unique name and description.
2. Place it only in the Windows user home and start a new Copilot session
   targeting WSL.
3. Ask a question that matches the skill description and record whether the
   skill is available or invoked.
4. Move the skill to the WSL user home, start another new session, and repeat.
5. Repeat with Local if Local-harness compatibility is part of the supported
   contract.

Pass criteria for a WSL Copilot target:

- a user-scoped skill installed by the extension is present under the WSL
  user's supported skill directory;
- a new session can discover the skill;
- installation does not require accessing the Windows home for a skill-only
  bundle.

### Custom Agent Discovery

1. Create a control user agent through the VS Code customization UI.
2. Add separate agents to the Windows and WSL Copilot directories.
3. Select Local, reload, and record which agents appear in the agent selector.
4. Select Copilot with the connected WSL host, start a new session, and record
   the result again.
5. Invoke each discovered agent and verify its unique instructions.

The Local and Copilot results must be recorded separately. An agent appearing
in one harness does not demonstrate support in the other.

### Instruction Discovery

1. Create control, Windows-home, and WSL-home instructions with different
   marker prefixes and explicit, non-overlapping `applyTo` patterns.
2. Enable only one probe for each run.
3. Select Local, reload, and verify that VS Code lists the instruction in the
   Agent Customizations editor or available customization diagnostics. Record
   this as the discovery result.
4. Create or modify a harmless fixture file that matches the probe's `applyTo`
   pattern.
5. Start a new Local session with that fixture in context and ask a
   deterministic question that is relevant to the instruction.
6. Record the activation result separately by checking the response marker and
   the instruction references reported by VS Code when available.
7. Repeat the discovery and activation checks with a Copilot session targeting
   WSL.

Avoid instructions that can cause destructive tool calls. A response prefix or
formatting requirement is sufficient. Do not treat a missing response marker
alone as a discovery failure: the file may be discovered but not activated
because its `applyTo` pattern or task relevance does not match.

### Installation and Removal Lifecycle

Test a bundle containing only one skill and a mixed bundle containing a skill
plus at least one non-skill primitive.

For each bundle:

1. Capture the Windows and WSL target directories before installation.
2. Install at user scope.
3. Verify every created file and directory.
4. Confirm actual discovery in a new session.
5. Uninstall the bundle.
6. Verify that all extension-managed files were removed.
7. Verify that unrelated user-managed files remain.

For a skill-only bundle, installation and removal should not depend on the
existence of a prompts directory. This guards against an early return in the
shared bundle lifecycle and against unnecessary Windows-home resolution.

## Recommended Automated Coverage

Add or retain focused tests for the following behavior:

- WSL user-scoped skills resolve to the injected WSL home;
- non-WSL behavior remains unchanged;
- prompt synchronization retains its documented Windows/profile behavior;
- a skill-only `syncBundle` does not call Windows-home resolution;
- a skill-only `unsyncBundle` removes the skill when no prompts directory
  exists;
- mixed bundles synchronize and remove both skill and non-skill entries;
- failed `cmd.exe` or `wslpath` detection produces an actionable warning for
  primitive types that require the Windows home;
- Windows-to-WSL boundary operations use copies rather than broken symlinks;
- VS Code Stable and Insiders resolve their intended user locations.

For the planned XDG convergence, add coverage for:

- extension and CLI resolving the same internal storage roots;
- a bundle installed by the CLI being represented consistently in the
  extension, and the reverse;
- migration preserving existing installations and registry state;
- migration being idempotent when interrupted or run more than once;
- rollback restoring the previous usable state after a partial failure;
- cache and published artifacts not drifting to different bundle versions;
- uninstall removing only files owned by AI Primitives Hub;
- WSL, SSH, Tunnels, and Dev Containers not sharing an unintended user root.

Automated tests should assert observable service behavior. They should not
claim to validate VS Code discovery unless they run against a real supported
VS Code or Agent Host integration.

## Evidence to Attach to Follow-Up Issues

Include:

- the completed environment record;
- the selected harness and execution environment;
- the exact source and destination paths;
- the bundle manifest or minimal fixture;
- relevant AI Primitives Hub output-channel lines;
- screenshots of the customization editor or agent selector;
- whether a new session and window reload were performed;
- an A/B result showing which of two candidate locations was discovered;
- cleanup and uninstall results.

State whether each conclusion is observed, documented, inferred, or still
unknown.

## Maintainer Decisions Required

Before broadening the WSL path rules, maintainers should decide:

1. Whether a user-scope installation targets Local, Copilot, or both harnesses.
2. Whether the target harness should be explicit in the installation UI or
   configuration.
3. Whether duplicating a primitive into Windows and WSL locations is supported,
   and how updates and removals remain ownership-safe.
4. Whether prompts should remain a Local-only primitive or be converted to
   skills for Copilot-harness use.
5. Which combinations belong in the release support matrix.
6. How VS Code profile changes affect extension-managed files.
7. Whether user-scoped remote behavior should be consistent across WSL, SSH,
   Tunnels, and Dev Containers.
8. Which files move to XDG storage and which remain consumer-facing
   publication artifacts.
9. Whether XDG state is authoritative for both the extension and CLI.
10. How existing VS Code-specific cache and state are migrated, rolled back,
    and eventually removed.
11. Whether extension and CLI operations may update the same installation
    concurrently, and how ownership or locking is enforced.
12. How a published customization is reconciled when the internal XDG state
    exists but the consumer-facing file is missing or locally modified.

These are product and architecture decisions. They should not be inferred from
a single primitive's behavior.

## Recommendation

Keep PR #516 scoped to the verified skill defect and complete the skill-only
installation/removal lifecycle coverage. Do not extend its path exception to
agents or instructions without the manual discovery matrix above.

Create a separate follow-up issue for the cross-harness support contract. The
issue should link this document, assign owners for the test matrix, and record
the resulting path contract before further implementation begins.

Track the XDG convergence as planned state in that follow-up work. Validate it
with both extension and CLI scenarios, while preserving consumer-specific
publication targets until their discovery contracts are explicitly changed.

## References

- [Issue #215: Installed primitives do not work when the extension runs in WSL](https://github.com/AmadeusITGroup/ai-primitives-hub/issues/215)
- [PR #231: WSL compatibility bug fix](https://github.com/AmadeusITGroup/ai-primitives-hub/pull/231)
- [Issue #515: User-scoped skills are installed in Windows home instead of WSL home](https://github.com/AmadeusITGroup/ai-primitives-hub/issues/515)
- [PR #516: Install user skills in WSL home](https://github.com/AmadeusITGroup/ai-primitives-hub/pull/516)
- [VS Code: Prompt files](https://code.visualstudio.com/docs/agent-customization/prompt-files)
- [VS Code: Custom agents](https://code.visualstudio.com/docs/agent-customization/custom-agents)
- [VS Code: Custom instructions](https://code.visualstudio.com/docs/agent-customization/custom-instructions)
- [VS Code: Agent Skills](https://code.visualstudio.com/docs/agent-customization/agent-skills)
- [VS Code: Agent harnesses](https://code.visualstudio.com/docs/agents/concepts/agent-harnesses)
- [VS Code: Migrate customizations to the Copilot harness](https://code.visualstudio.com/docs/agent-customization/migrate-customizations)

## See Also

- [Testing Guide](../testing.md)
- [Full Test Plan](./test-plan.md)
- [Testing SSH Remote Support](./ssh-remote.md)
