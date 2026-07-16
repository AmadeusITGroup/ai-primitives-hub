# Clean Architecture

This document explains how the AI Primitives Hub packages follow Clean Architecture principles.

## Terminology

- **Domain Layer**: The core business logic and domain models, independent of external concerns.
- **Ports**: Interfaces defined by the domain layer that specify what the domain needs from the outside world.
- **Adapters**: Implementations of ports that connect the domain to external systems (databases, APIs, file systems).
- **Application Layer**: Orchestrates use cases by coordinating domain objects and adapters.
- **Infrastructure Layer**: Provides concrete implementations of ports (GitHub client, file system, HTTP).
- **Dependency Rule**: Dependencies point inward — outer layers depend on inner layers, never the reverse.

## Principles

Clean Architecture (also known as Hexagonal Architecture or Ports and Adapters) emphasizes:

1. **Independence of Frameworks**: The architecture does not depend on the existence of external libraries or frameworks.
2. **Testability**: Business rules can be tested without UI, database, web server, or any external element.
3. **Independence of UI**: The UI can change easily, without changing the rest of the system.
4. **Independence of Database**: You can swap out Oracle or MongoDB for another database without affecting business rules.
5. **Independence of External Agencies**: Business rules don't know anything about the outside world.

## What It Is

Clean Architecture organizes code into concentric layers. The innermost layer contains the domain entities and business rules. Outer layers contain mechanisms for delivering data to and from the domain. The key insight is that dependencies only point inward — the domain knows nothing about the infrastructure, but the infrastructure depends on the domain through well-defined interfaces (ports).

This is achieved through the **Dependency Inversion Principle**: high-level modules (domain) should not depend on low-level modules (infrastructure). Both should depend on abstractions (ports). The abstractions are owned by the domain layer, and the infrastructure layer provides concrete implementations (adapters).

## In Our Case

The AI Primitives Hub packages follow Clean Architecture principles. The packages are organized as a pnpm workspace in `packages/` with four layers:

### Domain Layer (`@ai-primitives-hub/core`)

- Contains pure domain types: `Bundle`, `Collection`, `Primitive`, `Target`, `Source`
- Defines port interfaces in `ports/`: `FileSystem`, `HttpClient`, `GitHubApi`, `TargetWriter`, `BundleDownloader`, `BundleExtractor`, `SourceAdapter`, `LayoutConfigLoader`, `ResourceTransformer`, `AppStorage`
- No dependencies on other packages or external infrastructure
- Business rules live here (validation, parsing, domain logic)

### Infrastructure Layer (`@ai-primitives-hub/infra`)

- Implements ports as adapters: `NodeHttpClient`, `GitHubApiClient`, `FileTreeTargetWriter`, `AdmZipBundleExtractor`, `LocalAdapter`, `GitHubAdapter`, `AwesomeCopilotAdapter`, `ApmAdapter`, `SkillsAdapter`
- Provides concrete implementations for external systems: GitHub API, file system, HTTP, ZIP extraction, per-target content writers
- Depends only on `@ai-primitives-hub/core` (the port interfaces)
- Can be swapped without affecting domain logic

### Application Layer (`@ai-primitives-hub/app`)

- Orchestrates use cases: profile activation, bundle installation, registry management, discovery/search, multi-target transforms
- Coordinates domain objects and infrastructure adapters
- Contains no business rules — only orchestration
- Depends on core (domain) and infra (adapters)
- Also serves as the public SDK surface until a dedicated `@ai-primitives-hub/sdk` package is needed

### CLI Layer (`@ai-primitives-hub/cli`)

- Thin adapter that translates `ai-primitives-hub` CLI commands into application use cases
- Handles I/O, user interaction, and presentation using the Clipanion framework
- Depends on app, core, and infra but domain remains isolated
- Can be replaced with a web UI or a future dedicated SDK without changing core

### VS Code Extension (Separate Delivery Mechanism)

The `apps/vscode-extension` package is the second delivery mechanism. It is being migrated onto the same `core`/`infra`/`app` layers through a strangler-fig approach (see [ADR-0001](../adr/0001-ports-and-adapters-for-cli-and-extension.md)) so that it stops duplicating business logic that already lives in `app`.

### Dependency Flow

```
CLI  → App → Infra → Core
Extension ↗       ↓
                  Core ←───┘
```

All dependencies point toward the core. The core defines interfaces (ports), and outer layers implement them (adapters). This allows us to:

- Test business logic without external dependencies
- Swap implementations (e.g., replace GitHub client with a mock)
- Add new delivery mechanisms (CLI, VS Code extension, web UI) without changing domain
- Evolve infrastructure independently of business rules

## Further Reading

- [Clean Architecture by Robert C. Martin](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html) — Original article introducing the concept
- [Hexagonal Architecture by Alistair Cockburn](https://alistair.cockburn.us/hexagonal-architecture/) — The original ports and adapters pattern
- [Ports and Adapters Architecture](https://herbertograca.com/2017/09/14/ports-adapters-architecture/) — Practical explanation with examples
- [Onion Architecture by Jeffrey Palermo](https://jeffreypalermo.com/2008/07/28/the-onion-architecture-part-1/) — Another perspective on layered architecture
- [Domain-Driven Design by Eric Evans](https://www.domainlanguage.com/ddd/) — Foundation for domain-centric design

## See Also

- [Codemap](./codemap.md) — Package structure and dependency graph
- [System Context](./system-context.md) — External relationships and user personas
- [Container Diagram](./container.md) — High-level containers and technology choices
- [Component Diagrams](./component.md) — Detailed component views
