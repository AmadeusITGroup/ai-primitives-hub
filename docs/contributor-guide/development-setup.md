# Development Setup

## Prerequisites

- Node.js 18.x or 20.x
- npm 8.x+
- TypeScript 5.3+
- VS Code (latest)
- Git

## Quick Start

```bash
git clone https://github.com/AmadeusITGroup/prompt-registry.git
cd prompt-registry
npm install
npm run compile
npm test
```

Press `F5` in VS Code to launch Extension Development Host.

## Commands

```bash
# Development
npm run watch          # Dev mode with auto-compile
npm run compile        # Production build
npm run lint           # Check code style (ESLint v9 flat config)
npm run lint:fix       # Auto-fix lint issues

# Testing
npm test               # Run all tests (unit + integration)
npm run test:unit      # Unit tests only
npm run test:one -- test/path/to/file.test.ts  # Single test file
npm run test:integration  # Integration tests only
npm run test:coverage  # With coverage report

# Packaging
npm run package:vsix   # Create .vsix package
npm run package:production  # Optimized production package
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

- **"Cannot find module 'vscode'"** → Run `npm install`
- **Tests fail "suite is not defined"** → Check mocha setup
- **Extension not loading** → Check `package.json` activation events

## See Also

- [Architecture](./architecture.md)
- [Testing](./testing.md)
- [Coding Standards](./coding-standards.md)
