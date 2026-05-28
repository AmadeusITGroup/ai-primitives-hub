# Development Setup

## Prerequisites

- Node.js 18.x or 20.x
- pnpm 8.x+
- TypeScript 5.3+
- VS Code (latest)
- Git

## Quick Start

```bash
git clone https://github.com/AmadeusITGroup/prompt-registry.git
cd prompt-registry
pnpm install
pnpm run extension:compile
pnpm test
```

Press `F5` in VS Code to launch Extension Development Host.

## Commands

```bash
# Workspace-level commands
pnpm install              # Install all workspace dependencies
pnpm build                # Build all packages
pnpm test                 # Run all tests (all packages)
pnpm lint                 # Lint all packages
pnpm lint:fix             # Auto-fix lint issues

# Extension-specific commands
pnpm --filter=prompt-registry run compile        # Production build
pnpm --filter=prompt-registry run watch          # Dev mode with auto-compile
pnpm --filter=prompt-registry run package:vsix   # Create .vsix package

# Package-specific commands
pnpm --filter=@prompt-registry/core run build    # Build core package
pnpm --filter=@prompt-registry/infra run build   # Build infra package
# ... etc for other packages

# Testing
pnpm test                 # Run all tests (unit + integration)
pnpm --filter=prompt-registry run test:unit      # Unit tests only
pnpm --filter=prompt-registry run test:integration  # Integration tests only
```

## Project Structure

```
apps/vscode-extension/
├── src/
│   ├── adapters/       # Source adapters (GitHub, Local, APM, Skills)
│   ├── commands/       # VS Code command handlers
│   ├── config/         # Configuration defaults
│   ├── integrations/   # External integrations (Copilot)
│   ├── notifications/  # Notification services
│   ├── services/       # Core business logic
│   ├── storage/        # Persistent state management
│   ├── types/          # TypeScript definitions
│   ├── ui/             # WebView and TreeView providers
│   ├── utils/          # Shared utilities
│   └── extension.ts    # Entry point
├── test/               # Extension tests
├── package.json        # Extension package.json
└── tsconfig.json       # Extension TypeScript config

packages/
├── core/               # Domain types and interfaces
│   ├── src/
│   │   ├── domain/     # Domain types (Bundle, Source, Profile, etc.)
│   │   ├── ports/      # Port interfaces
│   │   └── index.ts
│   ├── package.json
│   └── tsconfig.json
├── infra/              # Infrastructure layer
│   ├── src/
│   │   ├── discovery/  # Discovery implementations
│   │   ├── downloaders/# Download implementations
│   │   ├── extractors/ # Archive extraction
│   │   ├── fs/         # File system operations
│   │   ├── github/     # GitHub API client
│   │   ├── harvest/    # Harvesting logic
│   │   ├── http/       # HTTP client
│   │   ├── resolvers/  # Source resolvers
│   │   ├── search/     # Search engine
│   │   ├── stores/     # Storage implementations
│   │   └── writers/     # Bundle writers
│   ├── test/
│   ├── package.json
│   └── tsconfig.json
├── app/                # Application layer
│   ├── src/
│   │   ├── install/    # Installation logic
│   │   ├── registry/   # Registry management
│   │   └── index.ts
│   ├── package.json
│   └── tsconfig.json
├── cli/                # CLI tool
│   ├── src/
│   │   ├── commands/   # CLI commands
│   │   └── index.ts
│   ├── bin/
│   ├── package.json
│   └── tsconfig.json
└── sdk/                # SDK for integrations
    ├── src/
    ├── package.json
    └── tsconfig.json

pnpm-workspace.yaml     # Workspace configuration
tsconfig.base.json      # Shared TypeScript config
tsconfig.json           # Solution root (references all packages)
package.json            # Workspace root (scripts only)
```

## Debugging

1. Press `F5` → Extension Development Host
2. Set breakpoints in TypeScript
3. View logs: `View → Output → Prompt Registry`

## Common Issues

- **"Cannot find module 'vscode'"** → Run `pnpm install`
- **Tests fail "suite is not defined"** → Check mocha setup
- **Extension not loading** → Check `apps/vscode-extension/package.json` activation events

## See Also

- [Architecture](./architecture.md)
- [Testing](./testing.md)
- [Coding Standards](./coding-standards.md)
