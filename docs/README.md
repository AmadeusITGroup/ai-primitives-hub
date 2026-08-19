# AI Primitives Hub Documentation

One platform to discover, install, govern, and share AI primitives — prompts, instructions, agents, skills, and MCP server configurations — across every major AI coding tool. Delivered through a VS Code extension (also runs in Kiro and Windsurf) and a standalone CLI. From a solo developer to teams and enterprise, the same primitives scale effortlessly.

---

## 📖 For Users

- **[Getting Started](user-guide/getting-started.md)** — Installation and first steps (extension & CLI)
- **[Marketplace](user-guide/marketplace.md)** — Browsing and installing bundles
- **[Repository Installation](user-guide/repository-installation.md)** — Team-shared configurations via Git
- **[Sources](user-guide/sources.md)** — Managing bundle sources
- **[Profiles and Hubs](user-guide/profiles-and-hubs.md)** — Profile and Hub management
- **[Configuration](user-guide/configuration.md)** — Extension settings, CLI config, and telemetry
- **[Troubleshooting](user-guide/troubleshooting.md)** — Common issues

---

## ✍️ For Collection Authors

- **[Creating Collections](author-guide/creating-source-bundle.md)** — How to create collections
- **[Creating a Hub](author-guide/creating-a-hub.md)** — Why, when, and how to publish a Hub
- **[Adding Sources to Hubs](author-guide/adding-profile-source-to-hub.md)** — Maintain existing Hubs
- **[Collection Scripts](author-guide/collection-scripts.md)** — Shared npm package for validation and building
- **[Collection Schema](author-guide/collection-schema.md)** — YAML schema reference
- **[Validation](author-guide/validation.md)** — Validating collections
- **[Publishing](author-guide/publishing.md)** — Publishing to registries

---

## 🔧 For Contributors

- **[Development Setup](contributor-guide/development-setup.md)** — Local dev environment
- **[Elastic Search Local Setup](contributor-guide/elastic-search-local-setup.md)** — Running ES locally with Docker/Podman
- **[Architecture](contributor-guide/architecture.md)** — System overview
  - [Adapters](contributor-guide/architecture/adapters.md)
  - [Authentication](contributor-guide/architecture/authentication.md)
  - [Installation Flow](contributor-guide/architecture/installation-flow.md)
  - [Update System](contributor-guide/architecture/update-system.md)
  - [UI Components](contributor-guide/architecture/ui-components.md)
  - [MCP Integration](contributor-guide/architecture/mcp-integration.md)
  - [Scaffolding](contributor-guide/architecture/scaffolding.md)
  - [Validation](contributor-guide/architecture/validation.md)
  - [Library-Centric Architecture](contributor-guide/architecture/library-centric-architecture/clean-architecture.md) — Ports-and-adapters deep dive
  - [CLI User Flows](contributor-guide/architecture/library-centric-architecture/cli-user-flows.md) — CLI command hierarchy and use cases
  - [ADRs](contributor-guide/architecture/adr/adr-index.md) — Architecture Decision Records
- **[Core Flows](contributor-guide/core-flows.md)** — Key system flows
- **[Testing](contributor-guide/testing.md)** — Testing strategy
- **[Testing SSH Remote](contributor-guide/testing/ssh-remote.md)** — SSH testing
- **[Validation](contributor-guide/validation.md)** — Local validation commands
- **[Coding Standards](contributor-guide/coding-standards.md)** — Style guide
- **[Releasing](contributor-guide/releasing.md)** — Release process
- **[Golden Path Test Cases](contributor-guide/testing/golden-path.md)** — The three mandatory manual scenarios, and the release gate
- **[Full Test Plan](contributor-guide/testing/test-plan.md)** — All 19 plans, for area-by-area manual coverage

---

## 📋 Reference

- **[Commands](reference/commands.md)** — VS Code extension commands & CLI commands
- **[Settings](reference/settings.md)** — Extension settings & CLI configuration
- **[Adapter API](reference/adapter-api.md)** — Custom adapters & target writers
- **[Hub Schema](reference/hub-schema.md)** — Hub configuration

---

## Additional Resources

- [CONTRIBUTING.md](../CONTRIBUTING.md) — Contribution guidelines
- [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) — Community standards
- [SECURITY.md](../SECURITY.md) — Security policy
