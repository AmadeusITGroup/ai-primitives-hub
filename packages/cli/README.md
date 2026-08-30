# @ai-primitives-hub/cli

Thin Clipanion delivery adapter over `@ai-primitives-hub/app`. Depends on
`core`, `infra`, and `app`. Commands parse arguments, call into `app`, and
format output; shared business behavior belongs in the domain and application
packages.

Status: **active alpha CLI**. The package currently includes commands for
collections, primitives, bundle building, sources, Hubs, profiles, targets,
index/search/discovery, security scanning, installation, configuration, shell completion, and
doctor/diagnostics. Run the executable with `--help` for the commands present
in the installed version.

The package requires Node.js 24 or newer. See the
[current architecture overview](../../docs/contributor-guide/architecture.md)
for its relationship with the extension and shared packages.

## Development

```bash
pnpm --filter @ai-primitives-hub/cli build
pnpm --filter @ai-primitives-hub/cli test
pnpm --filter @ai-primitives-hub/cli lint
```
