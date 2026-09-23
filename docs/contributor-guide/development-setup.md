# Development Setup

## Prerequisites

- Node.js 24.x
- pnpm 11.x+
- TypeScript 5.3+
- VS Code (latest)
- Git

## Quick Start

```bash
git clone https://github.com/AmadeusITGroup/prompt-registry.git
cd prompt-registry
pnpm install
pnpm run compile
pnpm test
```

Press `F5` in VS Code to launch Extension Development Host.

## Commands

```bash
# Development
pnpm run watch          # Dev mode with auto-compile
pnpm run compile        # Production build
pnpm run lint           # Check code style (ESLint v9 flat config)
pnpm run lint:fix       # Auto-fix lint issues

# Testing
pnpm test               # Run all tests (unit + integration)
pnpm run test:unit      # Unit tests only
pnpm run test:one -- test/path/to/file.test.ts  # Single test file
pnpm run test:integration  # Integration tests only
pnpm run test:coverage  # With coverage report

# Packaging
pnpm run package:vsix   # Create .vsix package
pnpm run package:production  # Optimized production package
```

## Project Structure

```
src/
├── adapters/       # Source adapters (GitHub, Local, APM)
├── commands/       # VS Code command handlers
├── config/         # Configuration defaults
├── integrations/   # External integrations (Copilot)
├── notifications/  # Notification services
├── services/       # Core business logic
├── storage/        # Persistent state management
├── types/          # TypeScript definitions
├── ui/             # WebView and TreeView providers
├── utils/          # Shared utilities
└── extension.ts    # Entry point
```

## Debugging

1. Press `F5` → Extension Development Host
2. Set breakpoints in TypeScript
3. View logs: `View → Output → AI Primitives Hub`

## Common Issues

- **"Cannot find module 'vscode'"** → Run `pnpm install`
- **Tests fail "suite is not defined"** → Check mocha setup
- **Extension not loading** → Check `package.json` activation events

## See Also

- [Architecture](./architecture.md)
- [Testing](./testing.md)
- [Coding Standards](./coding-standards.md)
