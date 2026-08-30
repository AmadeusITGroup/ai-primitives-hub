# Architecture Overview

AI Primitives Hub is a pnpm monorepo for discovering, packaging, installing,
and managing AI primitives. This page describes the implementation in this
repository today. Architecture Decision Records (ADRs) explain decisions and
migration direction; they are not evidence that every migration step is
complete.

## Current Shape

The repository has two delivery layers over shared packages:

- The Clipanion CLI under `packages/cli/`
- The VS Code extension under `apps/vscode-extension/`

The CLI delegates most use cases to the shared packages. The extension also
uses the shared packages, but still owns VS Code-specific commands, UI,
storage wiring, events, notifications, and several compatibility facades. The
extension is therefore not yet only a thin shell.

```mermaid
flowchart TD
    USER["CLI user"] --> CLI["packages/cli"]
    IDE["VS Code user"] --> EXT["Extension commands and UI"]
    EXT --> ESVC["Extension services and facades"]
    CLI --> APP["packages/app"]
    ESVC --> APP
    ESVC --> INFRA["packages/infra"]
    ESVC --> CORE["packages/core"]
    APP --> INFRA
    APP --> CORE
    INFRA --> CORE
```

## Package Responsibilities

| Area | Current responsibility |
|---|---|
| `packages/core` | Domain types, validation rules, errors, schemas, and ports for external capabilities |
| `packages/infra` | Implementations of core ports: source adapters, HTTP/GitHub access, stores, search, archives, scaffolding, layout loading, and target writers |
| `packages/app` | Use-case orchestration for installation, registry/Hub/profile operations, discovery, search, updates, and transforms |
| `packages/cli` | Clipanion commands, argument parsing, terminal output, and delivery-specific wiring |
| `apps/vscode-extension` | VS Code commands, views, webviews, progress, notifications, host detection, extension storage wiring, and compatibility facades over shared use cases |
| `lib` | Legacy collection build, validation, publishing, and release-analysis scripts |

The package dependency declarations enforce this shared direction:

```mermaid
flowchart LR
    CLI["CLI"] --> APP["app"]
    EXT["Extension"] --> APP
    APP --> INFRA["infra"]
    APP --> CORE["core"]
    INFRA --> CORE
```

`core` has no dependency on another `@ai-primitives-hub/*` package. `infra`
depends on `core`; `app` depends on both. The CLI also declares direct
dependencies on all three because its delivery wiring constructs concrete
adapters as well as calling application services.

## VS Code Extension

The extension currently has its own layered delivery architecture:

```mermaid
flowchart TD
    VIEW["Tree views and webviews"] --> CMD["Command handlers"]
    CMD --> REG["RegistryManager and focused services"]
    REG --> SHARED["Shared app use cases"]
    REG --> VSC["VS Code-specific storage and events"]
    SHARED --> ADAPTERS["infra source adapters and writers"]
```

Important current boundaries:

- `RegistryManager` remains the central extension facade. Search,
  installation, uninstallation, update detection, and profile operations
  already delegate substantial behavior to `packages/app`.
- `BundleInstaller` owns extension-specific installation wiring and invokes
  the shared `InstallPipeline` for the generic download, extraction,
  validation, cache, and write sequence.
- `UserScopeService` and `RepositoryScopeService` handle host- and
  scope-specific synchronization.
- `McpServerManager` and `McpConfigService` manage MCP configuration as a
  merge/tracking lifecycle rather than as a normal copied file.
- `HubManager` is an extension facade over shared Hub resolution, storage,
  validation, and application operations.
- Source adapter construction has moved to `packages/app` and
  `packages/infra`; the extension adapter directory contains compatibility
  wiring for remaining call sites.

See [Core Flows](./core-flows.md) for the current entry points,
[Security Scanner Architecture](./architecture/security-scanner.md) for scanner
boundaries and flows, and [Installation Flow](./architecture/installation-flow.md) for scope-specific
details.

## CLI

`packages/cli` is an active delivery layer, not scaffolding. It contains
commands for collections, primitives, bundles, sources, Hubs, profiles,
targets, discovery/indexing, security scanning, installation, configuration,
completion, and diagnostics.

Commands parse input and format output. Shared business behavior belongs in
`packages/app`, with ports and domain rules in `core` and concrete adapters in
`infra`.

## Main Runtime Flows

### Discovery

```mermaid
flowchart TD
    SOURCE["Configured source"] --> FACTORY["app source-adapter factory"]
    FACTORY --> ADAPTER["infra adapter"]
    ADAPTER --> REMOTE["GitHub, local, APM, skills, or other source"]
    ADAPTER --> BUNDLES["Normalized bundle metadata"]
    BUNDLES --> STORE["Registry/index storage"]
    STORE --> UI["Extension marketplace or CLI search"]
```

### Installation

```mermaid
flowchart TD
    ACTION["CLI command or extension action"] --> RESOLVE["Resolve bundle and target"]
    RESOLVE --> DOWNLOAD["Download through source adapter"]
    DOWNLOAD --> PIPE["Shared InstallPipeline"]
    PIPE --> EXTRACT["Extract and validate"]
    EXTRACT --> CACHE["Install/cache content"]
    CACHE --> WRITE["Write target and scope layout"]
    WRITE --> MCP["Merge MCP configuration when present"]
    MCP --> STATE["Record lock and installation state"]
```

The delivery layers do not yet use identical wiring around every step. The
shared pipeline is the common generic sequence; the extension adds VS Code
progress, events, scope services, MCP handling, and its existing storage
model.

### Hub synchronization

```mermaid
flowchart TD
    REF["GitHub, URL, or local Hub reference"] --> RESOLVER["HubResolver"]
    RESOLVER --> VALIDATE["Parse and validate Hub configuration"]
    VALIDATE --> STORE["HubStore"]
    STORE --> ACTIVE["Select active Hub"]
    ACTIVE --> SYNC["Synchronize enabled sources"]
    SYNC --> PROFILES["Expose shared profiles and collections"]
```

A Hub is configuration that distributes sources and profiles. It does not
contain the primitive files itself. See
[Creating a Hub](../author-guide/creating-a-hub.md) for the author workflow
and [Hub Schema](../reference/hub-schema.md) for field definitions.

## Persistence and External Boundaries

| Boundary | Current implementation |
|---|---|
| Source content | GitHub, Azure DevOps, URLs, local files, APM, skills, and Awesome Copilot adapters where supported by the relevant source model |
| Shared application state | `AppStorage` port with the XDG-based infrastructure implementation |
| Extension state | VS Code extension storage facades plus repository lockfiles |
| Repository installation state | `prompt-registry.lock.json` and local-only lock/exclusion behavior |
| Target files | Host- and scope-aware writers/layout resolution |
| MCP state | Host configuration files plus managed-server tracking |

The existing `prompt-registry` identifiers are retained where changing them
would break compatibility. See ADR-0004 in the
[ADR index](./architecture/adr/adr-index.md).

## Documentation Boundaries

Use this page for the current system map. Keep detailed behavior in the
existing focused pages rather than repeating it here:

- [Adapters](./architecture/adapters.md)
- [Authentication](./architecture/authentication.md)
- [Installation Flow](./architecture/installation-flow.md)
- [Update System](./architecture/update-system.md)
- [UI Components](./architecture/ui-components.md)
- [MCP Integration](./architecture/mcp-integration.md)
- [Scaffolding](./architecture/scaffolding.md)
- [Validation](./architecture/validation.md)
- [Security Scanner](./architecture/security-scanner.md)
- [Library-centric code map](./architecture/library-centric-architecture/codemap.md)
- [Architecture decisions](./architecture/adr/adr-index.md)

When these pages disagree with executable code, tests, or schemas, treat the
executable behavior as authoritative and correct the documentation.
