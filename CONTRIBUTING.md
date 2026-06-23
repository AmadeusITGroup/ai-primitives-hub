# Contributing to AI Primitives Hub

Thank you for your interest in contributing to AI Primitives Hub! This document provides guidelines and instructions for contributing to the project.

## 🎯 Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [How to Contribute](#how-to-contribute)
- [Coding Standards](#coding-standards)
- [Testing Guidelines](#testing-guidelines)
- [Commit Messages](#commit-messages)
- [Pull Request Process](#pull-request-process)
- [Release Process](#release-process)

---

## Code of Conduct

This project adheres to a [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior to the project maintainers.

---

## Getting Started

### Prerequisites

- **Node.js**: Version 18.x or 20.x
- **npm**: Version 8.x or higher
- **VS Code**: Latest stable version
- **Git**: For version control

### Quick Start

1. **Fork the repository**
   ```bash
   # Click "Fork" on GitHub, then clone your fork
   git clone https://github.com/YOUR_USERNAME/prompt-registry.git
   cd prompt-registry
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Build the extension**
   ```bash
   npm run compile
   ```

4. **Run tests**
   ```bash
   npm test
   ```

5. **Launch in VS Code**
   - Press `F5` in VS Code to open Extension Development Host
   - The extension will be loaded and ready to test

---

## Development Setup

### Environment Configuration

1. **TypeScript Compilation**
   ```bash
   # Watch mode for development
   npm run watch
   
   # Single compilation
   npm run compile
   ```

2. **Testing**
   ```bash
   # Run all tests
   npm run test:all
   
   # Run unit tests only
   npm run test:unit
   
   # Run with coverage
   npm run test:coverage
   ```

3. **Linting**
   ```bash
   # Check code style
   npm run lint
   
   # Auto-fix issues
   npm run lint -- --fix
   ```

### Recommended VS Code Extensions

- **ESLint**: Code quality
- **Prettier**: Code formatting
- **TypeScript**: Language support
- **Test Explorer**: Run tests in UI

---

## Project Structure

```
prompt-registry/
├── src/
│   ├── adapters/          # Source adapters (GitHub, Local, etc.)
│   ├── commands/          # VS Code commands
│   ├── services/          # Core business logic
│   ├── ui/                # WebView UI components
│   ├── types/             # TypeScript type definitions
│   ├── utils/             # Utility functions
│   └── extension.ts       # Extension entry point
├── templates/
│   └── scaffolds/         # Project scaffolding templates
│       ├── github/        # GitHub scaffold with CI/CD publishing
│       └── apm/           # APM package template
├── test/
│   ├── adapters/          # Adapter unit tests
│   ├── services/          # Service unit tests
│   ├── integration/       # Integration tests
│   └── e2e/               # End-to-end tests
├── docs/                  # Additional documentation
├── .github/
│   └── workflows/         # CI/CD pipelines
└── package.json           # Extension manifest
```

### Key Files

- **`src/extension.ts`**: Extension activation and setup
- **`src/types/registry.ts`**: Core type definitions
- **`src/commands/ScaffoldCommand.ts`**: Project scaffolding command
- **[Architecture](docs/contributor-guide/architecture.md)**: Detailed architecture documentation
- **[Core Flows](docs/contributor-guide/core-flows.md)**: Key system flows and processes

### Scaffolding System

The extension includes a scaffolding system for creating new prompt projects:

| Scaffold Type | Description | Template Location |
|--------------|-------------|-------------------|
| **GitHub** | Full-featured template with GitHub Releases CI for automated collection publishing | `templates/scaffolds/github/` |
| **APM** | APM package template | `templates/scaffolds/apm/` |

**GitHub Scaffold Features:**
- GitHub Actions workflows for automated publishing
- Collection validation scripts
- Example prompts, instructions, and agents
- Pre-commit hooks for validation

When contributing to scaffolding:
- Templates use `{{variable}}` syntax for substitution
- Test changes with `npm run test:unit` (scaffold tests in `test/commands/`)
- Ensure all generated files are valid and functional

---

## How to Contribute

### Types of Contributions

We welcome all types of contributions:

- 🐛 **Bug fixes**
- ✨ **New features**
- 📝 **Documentation improvements**
- 🧪 **Test coverage**
- 🎨 **UI/UX enhancements**
- 🌍 **Translations** (future)
- 💡 **Ideas and suggestions**

### Finding Work

1. **Check Issues**: Browse [GitHub Issues](https://github.com/AmadeusITGroup/prompt-registry/issues)
2. **Good First Issues**: Look for `good-first-issue` label
3. **Help Wanted**: Look for `help-wanted` label
4. **Propose New**: Create an issue to discuss new features

### Before You Start

1. **Check for existing work**: Search issues and PRs to avoid duplicates
2. **Discuss large changes**: Open an issue first for major features
3. **Read the docs**: Review [Architecture](docs/contributor-guide/architecture.md) and [Core Flows](docs/contributor-guide/core-flows.md)

---

## Coding Standards

### TypeScript Style

```typescript
// ✅ Good: Type-safe, clear naming
export interface Bundle {
    id: string;
    name: string;
    version: string;
}

async function fetchBundle(bundleId: string): Promise<Bundle> {
    // Implementation
}

// ❌ Bad: Any types, unclear names
async function fetch(id: any): Promise<any> {
    // Implementation
}
```

### Naming Conventions

- **Classes**: `PascalCase` (e.g., `GitHubAdapter`)
- **Functions**: `camelCase` (e.g., `fetchBundles`)
- **Constants**: `UPPER_SNAKE_CASE` (e.g., `DEFAULT_TIMEOUT`)
- **Interfaces**: `PascalCase` (e.g., `RegistrySource`)
- **Files**: Match class name or `camelCase` for utilities

### Code Organization

1. **Imports**: Group by external, internal, types
   ```typescript
   // External
   import * as vscode from 'vscode';
   import axios from 'axios';
   
   // Internal
   import { Logger } from '../utils/logger';
   
   // Types
   import { Bundle } from '../types/registry';
   ```

2. **Exports**: Prefer named exports
   ```typescript
   // ✅ Good
   export class GitHubAdapter { }
   export function parseManifest() { }
   
   // ❌ Avoid (unless single export)
   export default class GitHubAdapter { }
   ```

3. **Error Handling**: Always use try-catch for async
   ```typescript
   async function fetchData(): Promise<void> {
       try {
           const data = await api.fetch();
           // Process data
       } catch (error) {
           logger.error('Failed to fetch', error as Error);
           throw new Error('Fetch failed');
       }
   }
   ```

### Documentation

1. **JSDoc Comments**: For public APIs
   ```typescript
   /**
    * Fetches bundles from a registry source
    * @param sourceId - Unique source identifier
    * @returns Array of bundle metadata
    * @throws {Error} If source is not accessible
    */
   async fetchBundles(sourceId: string): Promise<Bundle[]> {
       // Implementation
   }
   ```

2. **Inline Comments**: For complex logic
   ```typescript
   // Use path.join for cross-platform compatibility
   const bundlePath = path.join(baseDir, 'bundles', bundleId);
   ```

---

## Testing Guidelines

### Test Structure

```typescript
import * as assert from 'assert';
import { GitHubAdapter } from '../../src/adapters/GitHubAdapter';

suite('GitHubAdapter', () => {
    suite('Constructor', () => {
        test('should accept valid URL', () => {
            const adapter = new GitHubAdapter({ url: 'https://github.com/user/repo' });
            assert.ok(adapter);
        });
        
        test('should reject invalid URL', () => {
            assert.throws(() => {
                new GitHubAdapter({ url: 'invalid' });
            });
        });
    });
});
```

### Testing Best Practices

1. **Unit Tests**: Test individual functions/classes in isolation
2. **Integration Tests**: Test component interactions
3. **Mocking**: Use `nock` for HTTP, mock VS Code APIs
4. **Coverage**: Aim for 70%+ coverage on new code
5. **Naming**: Descriptive test names (what and expected outcome)

### Running Tests

```bash
# Run specific test file
npx mocha test-dist/test/adapters/GitHubAdapter.test.js

# Run with debugger
# Add breakpoint, then F5 in VS Code with "Extension Tests" config

# Generate coverage report
npm run test:coverage
```

---

## Commit Messages

We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

### Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types

- **feat**: New feature
- **fix**: Bug fix
- **docs**: Documentation only
- **style**: Code style (formatting, no logic change)
- **refactor**: Code restructuring (no feature/bug change)
- **test**: Adding or updating tests
- **chore**: Maintenance tasks (dependencies, build config)
- **perf**: Performance improvements
- **ci**: CI/CD changes

### Examples

```bash
# Feature
feat(adapters): add APM adapter support

Implements APM adapter with package repository support
and release fetching.

Closes #42

# Bug fix
fix(installer): handle symlink failures on Windows

Falls back to file copy when symlink creation fails.
Fixes installation issues on Windows systems.

Fixes #56

# Documentation
docs(readme): add installation troubleshooting section

# Test
test(adapters): add comprehensive GitHubAdapter tests

Adds 15 test cases covering URL validation, metadata fetching,
and error handling.
```

### Guidelines

- **Subject**: 50 chars max, imperative mood ("add" not "added")
- **Body**: Wrap at 72 chars, explain *what* and *why*
- **Footer**: Reference issues (`Closes #123`, `Fixes #456`)

---

## Pull Request Process

### Before Submitting

1. **Update from main**
   ```bash
   git fetch upstream
   git rebase upstream/main
   ```

2. **Run all checks**
   ```bash
   npm run lint
   npm run compile
   npm test
   ```

3. **Update documentation** if needed

4. **Add tests** for new features

### PR Description Template

```markdown
## Description
Brief description of changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing
- [ ] Unit tests added/updated
- [ ] Manual testing completed
- [ ] All tests passing

## Checklist
- [ ] Code follows style guidelines
- [ ] Self-review completed
- [ ] Comments added for complex code
- [ ] Documentation updated
- [ ] No new warnings generated
- [ ] Tests added proving fix/feature works
```

### Review Process

1. **Automated checks**: Must pass CI/CD
2. **Code review**: At least one maintainer approval
3. **Testing**: Reviewers may test locally
4. **Feedback**: Address review comments
5. **Merge**: Maintainers will merge when ready

### After Merge

- Delete your feature branch
- Update your fork
- Celebrate! 🎉

---

## Release Process

### Versioning

We use [Semantic Versioning](https://semver.org/):

- **MAJOR**: Breaking changes (v1.0.0 → v2.0.0)
- **MINOR**: New features, backward compatible (v1.0.0 → v1.1.0)
- **PATCH**: Bug fixes, backward compatible (v1.0.0 → v1.0.1)

### Release Checklist

1. Update version in `package.json`
2. Update `CHANGELOG.md`
3. Run full test suite
4. Create git tag
5. Publish to VS Code Marketplace
6. Create GitHub release with notes

### Pre-release Testing

- Run on all supported OS (macOS, Linux, Windows)
- Test with VS Code Stable and Insiders
- Verify marketplace package size

---

## Development Tips

### Debugging

1. **VS Code Extension Host**
   - Press `F5` to launch
   - Set breakpoints in TypeScript
   - Check Debug Console for logs

2. **Extension Logs**
   - View → Output → Select "AI Primitives Hub"
   - Check for error messages and warnings

3. **Network Inspection**
   - Use `nock` in tests to capture requests
   - Check browser DevTools for WebView issues

### Common Issues

**Issue**: "Cannot find module 'vscode'"
- **Solution**: Run `npm install`, ensure you're in VS Code

**Issue**: Tests failing with "suite is not defined"
- **Solution**: Check test file uses correct mocha setup

**Issue**: Extension not loading
- **Solution**: Check `package.json` activation events, rebuild

### Performance Considerations

- **Minimize API calls**: Cache when possible
- **Lazy loading**: Load heavy resources on demand
- **Async operations**: Use `async/await`, avoid blocking
- **Memory**: Clean up resources in `dispose()` methods

---

## Community

### Communication Channels

- **GitHub Issues**: Bug reports and feature requests
- **GitHub Discussions**: General questions and ideas
- **Pull Requests**: Code contributions

### Getting Help

1. Check existing [documentation](README.md)
2. Search [closed issues](https://github.com/AmadeusITGroup/prompt-registry/issues?q=is%3Aissue+is%3Aclosed)
3. Ask in [GitHub Discussions](https://github.com/AmadeusITGroup/prompt-registry/discussions)
4. Open a new issue with details

### Recognition

Contributors are recognized in:
- GitHub contributors page
- Release notes
- Project README (major contributors)

---

## Legal

### Contributor License Agreement

By contributing, you agree that:
- Your contributions are your own work
- You grant us rights to use your contribution
- Your contribution is licensed under the Apache License 2.0

### License

This project is licensed under the Apache License 2.0 - see [LICENSE](LICENSE.txt) for details.

---

## Thank You! 🙏

Your contributions make this project better. Whether it's a bug fix, feature, or documentation improvement, we appreciate your time and effort.

**Happy coding!** 🚀

---

**Questions?** Open an issue or discussion - we're here to help!
