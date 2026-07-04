# VS Code User-Scope Golden Fixture

This fixture captures the current user-scope filesystem layout before the extension/CLI migration.

- `prompts/` represents the resolved VS Code Copilot prompts directory.
- `skills/` represents the current `~/.copilot/skills` directory.

The current user-scope service writes prompts, instructions, and agents as flat files in the prompts directory. Skills are copied as directories under the Copilot skills directory.