<div align="center">

<img src="./apps/vscode-extension/icon.png" alt="AI Primitives Hub Logo" width="96" />

# AI Primitives Hub

### The collaboration and governance platform for your AI primitives across teams and organizations.

Discover, govern, install, and share **prompts, instructions, agents, skills, MCP servers, plugins, and more** across every IDE, agent, and CLI — from a single source of truth.

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-007ACC?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=AmadeusITGroup.prompt-registry)
[![Documentation](https://img.shields.io/badge/docs-GitHub%20Pages-blue?logo=github)](https://amadeusitgroup.github.io/ai-primitives-hub/)
[![Version](https://img.shields.io/github/v/release/AmadeusITGroup/ai-primitives-hub)](https://github.com/AmadeusITGroup/ai-primitives-hub/releases)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
<br/>
[![VS Code installs](https://badgen.net/vs-marketplace/i/AmadeusITGroup.prompt-registry?icon=visualstudio&label=VS%20Code%20installs&color=007ACC)](https://marketplace.visualstudio.com/items?itemName=AmadeusITGroup.prompt-registry)
[![Open VSX downloads](https://img.shields.io/open-vsx/dt/AmadeusITGroup/prompt-registry?logo=eclipseide&label=Open%20VSX%20downloads&color=C160EF)](https://open-vsx.org/extension/AmadeusITGroup/prompt-registry)
[![npm installs](https://img.shields.io/npm/d18m/@ai-primitives-hub/cli?logo=npm&label=npm%20installs)](https://www.npmjs.com/package/@ai-primitives-hub/cli)
[![npm monthly](https://img.shields.io/npm/dm/@ai-primitives-hub/cli?logo=npm&label=npm%20monthly)](https://www.npmjs.com/package/@ai-primitives-hub/cli)

#### Works with

[![VS Code](https://img.shields.io/badge/VS%20Code-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white)](#-works-with-your-tools)
[![VS Code Insiders](https://img.shields.io/badge/VS%20Code%20Insiders-24BFA5?style=for-the-badge&logo=visualstudiocode&logoColor=white)](#-works-with-your-tools)
[![GitHub Copilot CLI](https://img.shields.io/badge/Copilot%20CLI-000000?style=for-the-badge&logo=githubcopilot&logoColor=white)](#-works-with-your-tools)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-D97757?style=for-the-badge&logo=claude&logoColor=white)](#-works-with-your-tools)
[![Cursor](https://img.shields.io/badge/Cursor-000000?style=for-the-badge&logo=cursor&logoColor=white)](#-works-with-your-tools)
[![Windsurf](https://img.shields.io/badge/Windsurf-0B100F?style=for-the-badge&logo=windsurf&logoColor=white)](#-works-with-your-tools)
<br/>
[![Kiro](https://img.shields.io/badge/Kiro-7B3FE4?style=for-the-badge)](#-works-with-your-tools)
[![Kiro CLI](https://img.shields.io/badge/Kiro%20CLI-7B3FE4?style=for-the-badge)](#-works-with-your-tools)
[![OpenCode](https://img.shields.io/badge/OpenCode-1E1E1E?style=for-the-badge)](#-works-with-your-tools)
[![Devin](https://img.shields.io/badge/Devin-1A73E8?style=for-the-badge)](#-works-with-your-tools)
[![Devin CLI](https://img.shields.io/badge/Devin%20CLI-1A73E8?style=for-the-badge)](#-works-with-your-tools)

</div>

---

<p align="center">
  <img src="./docs/assets/how-it-works.svg" width="640" alt="How AI Primitives Hub works: authors publish primitives, the organization hub governs them, consumers install them everywhere"/>
</p>

> **ℹ️ Note:** This project was formerly known as **Prompt Registry**. The VS Code extension ID (`AmadeusITGroup.prompt-registry`) and lockfile names remain unchanged for compatibility — seeing `prompt-registry` in paths is expected.

## 💡 Why AI Primitives Hub?

- 🔍 **Marketplace experience** — browse, search, and one-click install curated bundles right inside VS Code.
- 🌐 **Write once, install everywhere** — the same bundle lands in the right folder and format for each IDE or agent CLI.
- 🛡️ **One governed organization hub** — authors publish from their own repositories, and a reviewed, central hub config approves, pins, and tracks what the whole organization installs.
- 🛡️ **Built for teams** — share role-based profiles, pin versions in a committed lockfile, and auto-update.
- 📦 **Bring your own source** — GitHub, Azure DevOps, Artifactory, APM, Awesome Copilot, or a local folder.
- ⚡ **Two front doors, one engine** — a VS Code extension and a scriptable CLI share the same core.

## 📑 Table of Contents

- [How It Works](#-how-it-works)
- [Works With Your Tools](#-works-with-your-tools)
- [Supported Primitives](#-supported-primitives)
- [Supported Sources](#-supported-sources)
- [Quick Start](#-quick-start)
- [Repository Structure](#-repository-structure)
- [Architecture](#%EF%B8%8F-architecture)
- [Documentation](#-documentation)
- [Contributing](#-contributing)
- [License](#-license)

## 🔄 How It Works

**Authors publish primitives, the organization hub governs them, consumers consume them.** Agents, skills, MCP server configs, plugins, and other primitives stay in the authors' own repositories. The organization hub is the governance layer in between. It decides which sources and versions are approved, reviews every change, and tracks what gets installed. Every client reads from that hub.

The animation at the top of this page walks through each stage.

| Role | What they do | How |
|------|--------------|-----|
| 🧑‍🔧 **Author** (collection or plugin owner) | Creates a repository with their primitives (**agents, skills, MCP server configs, plugins, prompts, instructions, hooks**), groups them into collections, and publishes them as versioned bundles. | `agent create`, `skill create`, `plugin create`, `collection create`, `bundle build`, GitHub releases |
| 🛡️ **Organization hub** (governance layer) | A central `hub-config.yml` that registers authors' repositories as approved **sources**, curates role-based **profiles** with pinned versions, and gates every change through review and validation. | `hub create`, `hub validate`, Visual Hub Configuration Editor |
| 🧑‍💻 **Consumer** | Imports the organization hub once, then browses, installs bundles, or activates profiles. Bundles are downloaded from the approved sources and placed in each tool's own folders and formats. | VS Code extension, `hub add`, `profile activate`, `install` |

### 🛡️ Governance Controls

| Control | What the organization gets |
|---------|----------------------------|
| **Approved sources** | The hub catalog lists only the sources registered in `hub-config.yml`. |
| **Reviewed changes** | Adding a source or changing a profile is a pull request on the hub repository, with normal code-review protections. |
| **Validation** | `hub validate` checks the schema, source and profile references, and bundle IDs, and can resolve every profile's bundles with `--check-sources`. Authors can validate collections in CI with the [validate-collections action](./github-actions/validate-collections/). |
| **Lockfile scanner** *(coming soon)* | Hub pull requests will scan lockfiles and primitives before a source is approved. |
| **Version pinning** | Profiles pin each bundle to a SemVer version (or `latest`). Repository installs record versions and file checksums in `prompt-registry.lock.json`. |
| **Usage tracking** | With `telemetry` configured in the hub, the VS Code extension reports bundle install, update, and uninstall events, plus profile and source events, to your Elastic Search, respecting each user's VS Code telemetry setting. |
| **Controlled distribution** | `hub replicate` mirrors SHA-256-verified releases into Artifactory. See [Hub Replication](./docs/reference/hub-replication.md). |

See [Creating a Hub](./docs/author-guide/creating-a-hub.md) and [Profiles and Hubs](./docs/user-guide/profiles-and-hubs.md).

## 🧩 Works With Your Tools

| Tool | Target ID | Type | VS Code extension | CLI |
|------|-----------|------|:-----------------:|:---:|
| Visual Studio Code | `vscode` | IDE | ✅ | ✅ |
| VS Code Insiders | `vscode-insiders` | IDE | ✅ | ✅ |
| Kiro | `kiro` | IDE | ✅ | ✅ |
| Windsurf | `windsurf` | IDE | ✅ | ✅ |
| Cursor | `cursor` | IDE | — | ✅ |
| Devin | `devin` | IDE | — | ✅ |
| GitHub Copilot CLI | `copilot-cli` | CLI agent | — | ✅ |
| Claude Code | `claude-code` | CLI agent | — | ✅ |
| Kiro CLI | `kiro-cli` | CLI agent | — | ✅ |
| OpenCode | `opencode` | CLI agent | — | ✅ |
| Devin CLI | `devin-cli` | CLI agent | — | ✅ |

The extension auto-detects the IDE it runs in. The CLI can install into any target: `ai-primitives-hub target types` lists them all.

## 📦 Supported Primitives

**Portable primitives** — work on **every** supported tool:

| | Primitive | Kind |
|---|-----------|------|
| 💬 | Prompts | `prompt` |
| 📋 | Instructions | `instruction` |
| 🗨️ | Chat modes | `chat-mode` |
| 🤖 | Agents | `agent` |
| 🛠️ | Skills | `skill` |
| 🔌 | MCP servers | `mcp-server` |
| 🪝 | Hooks | `hook` |
| 🧩 | Plugins | `plugin` |

**Tool-specific primitives** — installed only where the tool understands them:

| Primitive | Kind | Available on |
|-----------|------|--------------|
| 🧭 Steering | `steering` | Kiro, Kiro CLI |
| 📐 Specs | `spec` | Kiro, Kiro CLI |
| ⚡ Powers | `power` | Kiro, Kiro CLI, Devin, Devin CLI |
| ⌨️ Slash commands | `command` | Claude Code |
| 🎨 Output styles | `output-style` | Claude Code |
| 📏 Rules | `rule` | Cursor |
| 🔧 Tools | `tool` | OpenCode |
| 📚 Knowledge | `knowledge` | Devin, Devin CLI |
| 📖 Playbooks | `playbook` | Devin, Devin CLI |

Mixed bundles install all-or-nothing by default; add `--skip-unsupported` to install only what the target supports.

## 🌐 Supported Sources

| Remote | Local |
|--------|-------|
| GitHub releases (`github`) | Local bundles (`local`) |
| Awesome Copilot collections (`awesome-copilot`) | Local collections (`local-awesome-copilot`) |
| Skills repositories (`skills`) | Local skills (`local-skills`) |
| APM packages (`apm`) | Local APM packages (`local-apm`) |
| Azure DevOps (`azure-devops`) | |
| JFrog Artifactory (`artifactory`) | |

See [Sources](./docs/user-guide/sources.md) for configuration details.

## 🚀 Quick Start

**🖥️ In VS Code (and Kiro, Windsurf):**
Search **"AI Primitives Hub"** in the Extensions panel and install it. On first launch, pick your organization's hub. Its sources sync and its first profile activates. Then browse the marketplace view and click **Install** on any bundle. To build from source, see [`apps/vscode-extension/README.md`](./apps/vscode-extension/README.md).

![AI Primitives Hub in VS Code](./docs/assets/ai-primitives-hub.png)

**⌨️ From the terminal:**

```bash
npm install -g @ai-primitives-hub/cli
ai-primitives-hub hub add --location <owner/hub-repo>     # import the hub and make it active
ai-primitives-hub target add my-claude --type claude-code
ai-primitives-hub profile activate <profile-id> --target my-claude
# or install a single bundle from one of the hub's sources
ai-primitives-hub install <bundle-id> --source <source-id> --target my-claude
```

See the [Command Reference](./docs/reference/commands.md) for all CLI commands.

**🧑‍🔧 As a collection or plugin owner:**
Structure your primitives and publish them from your own repository. See the [Author Guide](./docs/author-guide/creating-source-bundle.md) and [Publishing](./docs/author-guide/publishing.md).

**🛡️ Setting up an organization hub:**
Register authors' repositories as approved sources, curate profiles, and configure governance in `hub-config.yml`. See [Creating a Hub](./docs/author-guide/creating-a-hub.md) and [Adding Profiles and Sources](./docs/author-guide/adding-profile-source-to-hub.md).

**🛠️ As a contributor:**

Requires Node.js 24 or newer and pnpm 11 or newer. See
[CONTRIBUTING.md](./CONTRIBUTING.md) for the complete development setup.

```bash
git clone https://github.com/AmadeusITGroup/ai-primitives-hub.git
cd ai-primitives-hub
pnpm install
pnpm build        # build all workspace packages
pnpm test         # run all workspace tests
pnpm lint
```

## 📁 Repository Structure

| Path | Purpose |
|------|---------|
| `apps/vscode-extension/` | VS Code extension: UI, commands, services, adapters |
| `packages/core/` | Domain types and port interfaces |
| `packages/infra/` | Adapter implementations: sources, stores, writers, scaffolding |
| `packages/app/` | Use-case orchestration: install, registry, discovery, transforms |
| `packages/cli/` | Terminal interface calling `app` |
| `lib/` | Legacy collection scripts (deprecated in place) |
| `github-actions/validate-collections/` | Reusable GitHub Action for validating collections in CI |
| `docs/` | User, author, and contributor documentation |
| `website/` | Docusaurus documentation site |
| `packages/infra/src/hub/` | Shared Hub resolution, validation, and default-Hub definitions |

## 🏗️ Architecture

The monorepo is organized around a shared `core` domain, with `infra` adapters, an `app` orchestration layer, and thin delivery layers for the VS Code extension and the CLI.

```mermaid
flowchart TD
    subgraph "Delivery"
        VSC[VS Code extension<br/>apps/vscode-extension]
        CLI[CLI<br/>packages/cli]
    end
    VSC --> APP[packages/app]
    CLI --> APP
    APP --> CORE[packages/core]
    APP --> INF[packages/infra]
    INF --> CORE
    INF --> AD[Adapters<br/>GitHub / Local / APM / Skills / Awesome Copilot / Azure DevOps / Artifactory]
```

For extension details, see the [Contributor Architecture Guide](./docs/contributor-guide/architecture.md).

## 📚 Documentation

- [User Guide](./docs/user-guide/getting-started.md)
- [Author Guide](./docs/author-guide/creating-source-bundle.md)
- [Contributor Guide](./docs/contributor-guide/development-setup.md)
- [Architecture](./docs/contributor-guide/architecture.md)
- [Reference](./docs/reference/commands.md)

See the full index: [`docs/README.md`](./docs/README.md).

## 🤝 Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md). For security, see [SECURITY.md](./SECURITY.md).

## 📄 License

[Apache 2.0](./apps/vscode-extension/LICENSE.txt)
