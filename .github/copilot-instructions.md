# Copilot sandbox notes

This repo resolves npm/pnpm packages through an internal Artifactory registry
configured in the user's `~/.npmrc`. Keep that in mind when running package
manager commands from the coding agent's sandboxed terminal.

## Do not strip `~/.npmrc`

The common sandbox workaround `NPM_CONFIG_USERCONFIG=/dev/null` (referenced in
`AGENTS.md` when the sandbox cannot read `~/.npmrc`) removes the Artifactory
registry override along with it. Once stripped, `pnpm`/`npm` fall back to the
public registry, which is not reachable here and causes `fetch failed` errors.
Do not use that override in this repo.

## Prefer VS Code tasks over the sandboxed terminal

For `pnpm`/`npm` commands (install, compile, lint, test, package), prefer the
`run_task` / `create_and_run_task` tools over `run_in_terminal`. The workspace
has a pinned task set in `.vscode/tasks.json` that runs through VS Code's
integrated terminal using the real shell environment and the user's actual
`~/.npmrc`, so it reaches Artifactory without needing
`requestAllowNetwork` / `requestUnsandboxedExecution` and without breaking the
registry configuration.

- Keep using shell tasks that invoke `pnpm` explicitly; do not switch to `type`:
  `npm` tasks because they invoke `npm` instead of `pnpm`.
- Reuse existing tasks first: `pnpm: watch`, `pnpm: watch-tests`, `pnpm: compile`,
  `pnpm: compile-tests`, `pnpm: lint`, `pnpm: test:unit`, `pnpm: test:integration`,
  `pnpm: test:coverage:unit`, `pnpm: test:one`, `pnpm: package:vsix`, `pnpm: lib test`,
  `pnpm: packages build`, `pnpm: packages lint`, `pnpm: packages test`,
  `pnpm: website build`, and `pnpm: install`.
- For commands without a matching task, add an ad-hoc task via
  `create_and_run_task` and reuse or update its `command` field for follow-up
  checks instead of creating a new task each time.
- After running a task, use `get_task_output` to confirm the exit code before
  concluding that it succeeded.
