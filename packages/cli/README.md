# @ai-primitives-hub/cli

Thin Clipanion delivery adapter over `@ai-primitives-hub/app`. Depends on
`core`, `infra`, and `app`. Commands parse arguments, call into `app`, and
format output; shared business behavior belongs in the domain and application
packages.

Status: **active alpha CLI**. The package currently includes commands for
collections, primitives, bundle building, sources, Hubs, profiles, targets,
index/search/discovery, installation, configuration, shell completion, and
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

### Qualify a bundle with stock APM

The opt-in qualification command provisions the pinned APM CLI `0.35.0`
through `uv`, tests its direct ZIP-install behavior, then extracts the archive
and runs the installer in dry-run mode against the package directory. APM's
local ZIP installer is for plugin bundles, so it is expected to reject this
Agent Package archive as a direct local bundle; the directory check verifies
that APM accepts the archive's package layout. This does not add APM to routine
builds, tests, or CI.

```bash
pnpm --filter @ai-primitives-hub/cli qualify:apm-archive -- /path/to/bundle.zip
```

Requires `uv` and network access to resolve the pinned `apm-cli` package. The
command reports the APM version, exact commands, and both results.
