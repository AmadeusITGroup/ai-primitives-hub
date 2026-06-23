# 🎨 AI Primitives Hub

> A visual marketplace for discovering, installing, and managing GitHub Copilot prompt libraries from multiple sources.

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-blue?logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=AmadeusITGroup.prompt-registry)
[![Documentation](https://img.shields.io/badge/docs-GitHub%20Pages-blue?logo=github)](https://amadeusitgroup.github.io/prompt-registry/)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Version](https://img.shields.io/badge/version-0.0.2-green.svg)](https://github.com/AmadeusITGroup/prompt-registry)

---

**AI Primitives Hub** transforms how you discover and manage GitHub Copilot prompts. Browse a visual marketplace, search by tags, and install curated prompt libraries with a single click—no manual file copying or repository cloning required.

> **ℹ️ Note:** This project was formerly known as **Prompt Registry**. It has been renamed to **AI Primitives Hub** to better reflect its broader scope.

![AI Primitives Hub - main views](./docs/assets/prompt-registry-in-vscode.png)

---

## 🚀 Quick Start

1. **Install** — Search "AI Primitives Hub" in VS Code Extensions (`Ctrl+Shift+X`)
2. **Select Hub** — On first launch, choose a hub from the welcome dialog (or skip to configure later)
3. **Browse** — Click "MARKETPLACE" in the AI Primitives Hub sidebar
4. **Install** — Click any bundle tile, then click **Install**
5. **Use** — Your prompts are now available in GitHub Copilot! 🎉

The extension automatically adds the Awesome Copilot source and syncs your selected hub's profiles on startup.

→ [Full Getting Started Guide](./docs/user-guide/getting-started.md)

---

## ✨ Key Features

- **🎨 Visual Marketplace** — Browse bundles in a tile-based interface with search, filters, and one-click install ([details](./docs/user-guide/marketplace.md))
- **🔌 Multi-Source Support** — Connect to GitHub, local directories, APM repositories, or Awesome Copilot collections ([details](./docs/user-guide/sources.md))
- **📦 Version Management** — Track versions, detect updates, and enable automatic background updates ([details](./docs/user-guide/configuration.md))
- **👥 Profiles & Hubs** — Organize bundles by project/team and share configurations across your organization ([details](./docs/user-guide/profiles-and-hubs.md))
- **🤖 Built-in Copilot Skill** — Ask GitHub Copilot questions about AI Primitives Hub directly in chat — setup, authoring, troubleshooting, and more
- **🌍 Cross-Platform** — Works on macOS, Linux, and Windows with all VS Code flavors

---

## 🤖 Ask Copilot About AI Primitives Hub

AI Primitives Hub ships with a built-in **Copilot skill** that lets you ask GitHub Copilot questions about the extension directly in chat. No extra setup is required — the skill is available as soon as the extension is installed.

**What you can ask:**
- **Users** — "How do I add a local source?", "What scopes are available?", "Why isn't my hub showing?"
- **Authors** — "How do I create a collection?", "What fields are required in a manifest?", "How do I publish to a hub?"

The skill answers from the extension's own documentation, so responses are always grounded in the actual behavior of your installed version.

> **Note:** The skill covers user and author topics only. For contributor questions (architecture, testing, internals), consult the [Contributor Guide](./docs/contributor-guide/development-setup.md) directly.

> **Seeing incorrect or unexpected answers?** Please [open an issue](https://github.com/AmadeusITGroup/prompt-registry/issues) describing the question you asked and the response you received, or reach out to one of the project contributors directly.

---

## 📚 Documentation

| Audience | Description | Link |
|----------|-------------|------|
| **Users** | Installation, marketplace, sources, profiles, troubleshooting | [User Guide](./docs/user-guide/getting-started.md) |
| **Authors** | Creating, validating, and publishing prompt collections | [Author Guide](./docs/author-guide/creating-source-bundle.md) |
| **Contributors** | Development setup, architecture, testing, coding standards | [Contributor Guide](./docs/contributor-guide/development-setup.md) |
| **Reference** | Commands, settings, adapter API, hub schema | [Reference Docs](./docs/reference/commands.md) |

→ [Full Documentation Index](./docs/README.md)

---

## 📦 Installation

**From VS Code Marketplace:**
1. Open VS Code → Press `Ctrl+Shift+X`
2. Search "AI Primitives Hub" → Click **Install**

**From VSIX:**
```bash
code --install-extension prompt-registry-0.0.2.vsix
```

**From Source:**
```bash
git clone https://github.com/AmadeusITGroup/prompt-registry.git
cd prompt-registry
npm install
npm run package:vsix
code --install-extension prompt-registry-0.0.2.vsix
```

**For custom VS Code instances** (with custom user-data-dir/extensions-dir):
```bash
# After building the VSIX above, install to your custom VS Code instance
code --user-data-dir "$ud" --extensions-dir "$ed" --install-extension prompt-registry-0.0.2.vsix
```

---

## 🔌 Supported Sources

| Source Type | Description |
|-------------|-------------|
| **Awesome Copilot** | Curated community collections |
| **GitHub** | Direct from GitHub repositories |
| **Local** | File system directories |
| **APM** | APM package repositories |

→ [Source Configuration Guide](./docs/user-guide/sources.md)

---

## 🏗️ Architecture Overview

```
Marketplace/Tree View → Registry Manager → Adapters (GitHub, Local, etc.)
                              ↓
                       Bundle Installer → Copilot Sync
```

→ [Full Architecture Documentation](./docs/contributor-guide/architecture.md)

---

## 🔧 Troubleshooting

**Bundles not showing in Copilot?**
- Check sync completed in extension logs
- Run "AI Primitives Hub: Sync All Bundles"
- Restart VS Code (`Ctrl+R`)

**Installation fails?**
- Verify network connection and repository access
- Check bundle has valid `deployment-manifest.yml`

→ [Full Troubleshooting Guide](./docs/user-guide/troubleshooting.md)

---

## 🤝 Contributing

We welcome contributions! See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

→ [Development Setup](./docs/contributor-guide/development-setup.md) | [Coding Standards](./docs/contributor-guide/coding-standards.md)

---

## 📄 License

[Apache 2.0](./LICENSE.txt) — See [SECURITY.md](./SECURITY.md) for security policy.

---

## 🙏 Acknowledgments

- **Microsoft** - For GitHub Copilot and VS Code
- **Awesome Copilot Community** - For curated prompt collections
- **Contributors** - Everyone who has contributed to this project
---

## 🔗 Links

- [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=AmadeusITGroup.prompt-registry)
- [GitHub Repository](https://github.com/AmadeusITGroup/prompt-registry)
- [Report Issues](https://github.com/AmadeusITGroup/prompt-registry/issues)
- [Discussions](https://github.com/AmadeusITGroup/prompt-registry/discussions)
