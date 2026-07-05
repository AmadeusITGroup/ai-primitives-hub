# CLI Usage

The `prompt-registry` CLI provides command-line access to bundle management, validation, inspection, scaffolding, and shell completion.

## Installation

The CLI is available as a bin entry in the package. After `npm install`, use it via:

```bash
npx prompt-registry <command> [options]
```

Or link it globally:

```bash
npm link
prompt-registry <command> [options]
```

## Global Options

| Option | Description |
|--------|-------------|
| `--help`, `-h` | Show help with command categories and quick start |
| `--output <format>` | Select output format: `text` (default) or `json` |

## Commands

### list

List installed bundles.

```bash
prompt-registry list [--output json]
```

Output includes bundle ID, version, and target (type:scope) in a formatted table.

### install

Install a bundle to a target.

```bash
prompt-registry install <bundle-ref> --target <type>:<scope>
```

- `bundle-ref` — Path to a local bundle directory or remote bundle reference
- `--target` — Target in `type:scope` format (e.g., `vscode:user`, `vscode:repository`)

### update

Update an installed bundle to a new version.

```bash
prompt-registry update <bundle-ref> --target <type>:<scope>
```

### uninstall

Remove an installed bundle.

```bash
prompt-registry uninstall <bundle-id> --target <type>:<scope>
```

### validate

Validate a local bundle before installing.

```bash
prompt-registry validate <bundle-path>
```

Checks manifest structure, file references, and resource types.

### inspect

Show detailed information about a bundle.

```bash
prompt-registry inspect <bundle-id> [--output json]
```

### scaffold

Create a new collection or primitive scaffold.

```bash
prompt-registry scaffold <type> --name <name> [options]
```

**Types:** `collection`, `prompt`, `instruction`, `agent`, `skill`, `plugin`, `hook`

**Options:**

| Option | Description |
|--------|-------------|
| `--name <name>` | Name of the item (required) |
| `--description <text>` | Description |
| `--author <name>` | Author name |
| `--tags <comma-separated>` | Tags |
| `--path <dir>` | Output directory (default: current directory) |

**Example:**

```bash
prompt-registry scaffold collection --name "My Prompts" --description "Custom prompt collection" --tags "coding,review"
```

### completion

Generate a shell completion script for bash or zsh.

```bash
prompt-registry completion bash > /etc/bash_completion.d/prompt-registry
source /etc/bash_completion.d/prompt-registry
```

```bash
prompt-registry completion zsh > "${fpath[1]}/_prompt-registry"
compinit
```

## Output Formats

Most commands support `--output json` for structured JSON output, useful for scripting and automation. The JSON envelope includes:

```json
{
  "command": "<command-name>",
  "status": "ok|error|warning",
  "data": { ... },
  "error": { "code": "...", "message": "..." }
}
```

## Targets

Targets specify where bundles are installed:

| Target | Scope | Description |
|--------|-------|-------------|
| `vscode` | `user` | User-level Copilot directory |
| `vscode` | `repository` | Repository `.github/` directory (Git-tracked) |
| `kiro` | `user` | Kiro user directory |
| `kiro` | `repository` | Kiro repository directory |

## Resource Kinds

Bundles can contain the following resource kinds:

| Kind | File Extension | Description |
|------|----------------|-------------|
| `prompt` | `.prompt.md` | Prompt files |
| `instruction` | `.instructions.md` | Instruction files |
| `agent` | `.agent.md` | Agent definitions |
| `skill` | `SKILL.md` | Skill definitions |
| `plugin` | `.plugin.json` | Plugin configurations |
| `hook` | `.hook.json` | Hook definitions |

## Proxy Support

The CLI respects standard proxy environment variables:

- `HTTP_PROXY` / `http_proxy` — Proxy for HTTP requests
- `HTTPS_PROXY` / `https_proxy` — Proxy for HTTPS requests
- `NO_PROXY` / `no_proxy` — Comma-separated list of hosts to bypass proxy

## See Also

- [Command Reference](../reference/commands.md) — VS Code extension commands
- [Getting Started](./getting-started.md) — Installation and first steps
- [Repository Installation](./repository-installation.md) — Repository-scoped bundle management
