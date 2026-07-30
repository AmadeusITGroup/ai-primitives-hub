# Local Validation

For validation architecture details, see [Architecture: Validation](./architecture/validation.md).

## 🎯 Quick Reference

### Validation Scripts

| Script | Purpose | Time | Use When |
|--------|---------|------|----------|
| `./.github/workflows/scripts/quick-check.sh` | Fast iteration check | ~30s | During development |
| `./.github/workflows/scripts/validate-locally.sh` | Full CI simulation | ~2-5min | Before pushing |
| `npm run pretest` | Pre-test setup | ~1min | Before running tests |
| `npm test` | All tests | ~2min | Verify functionality |

### Essential Commands

| Command | Purpose | When |
|---------|---------|------|
| `npm run lint` | Code style | During development |
| `npm run compile` | Build | Before testing |
| `npm run test:unit` | Unit tests | Fast feedback |
| `npm test` | All tests | Before pushing |
| `npm run package:full` | Production VSIX | Before release |

## 📋 Validation Workflow (Matches GitHub Actions)

### 1. **Security & Dependencies**
```bash
# Install dependencies with audit
npm ci --fund=false
npm audit --omit=dev --audit-level=moderate
```

### 2. **Code Quality**
```bash
# Linting
npm run lint

# Type checking & compilation
npm run compile
```

### 3. **Testing**
```bash
# Compile tests
npm run compile-tests

# Unit tests (fast)
npm run test:unit

# Integration tests (requires display)
npm run test:integration

# All tests
npm test
```

### 4. **Packaging**
```bash
# Full production package with optimizations
npm run package:full

# Or individual steps:
npm run package:prepare    # Switch to production config
npm run package:vsix        # Create VSIX
npm run package:cleanup     # Restore dev config
```

### 5. **Validation**
```bash
# Validate VSIX contents
unzip -l *.vsix

# Check package size
ls -lh *.vsix
```

## 🔧 Development Workflow

### For Quick Iterations (30 seconds)
```bash
./.github/workflows/scripts/quick-check.sh
```
Runs: `lint → compile → unit tests`

### Before Committing (2-5 minutes)
```bash
./.github/workflows/scripts/validate-locally.sh
```
Runs: Full CI simulation including packaging

### Continuous Development
```bash
# Terminal 1: Watch mode for auto-compilation
npm run watch

# Terminal 2: Watch mode for tests
npm run watch-tests
```

### Manual Quick Check
```bash
npm run lint && npm run compile && npm run test:unit
```

### Full Manual Validation
```bash
npm run lint
npm run compile
npm test
npm run package:full
```

## 📊 Understanding Test Organization

### Unit Tests (`test:unit`)
- Location: `test/{adapters,commands,services,utils}/`
- Fast, no VS Code API needed
- Mock dependencies
- **~30 seconds**

### Integration Tests (`test:integration`)
- Location: `test/integration/`
- Requires VS Code environment
- Tests real extension behavior
- **~1-2 minutes**

### Coverage Reports
```bash
# Unit test coverage
npm run test:coverage:unit

# Full coverage
npm run test:coverage

# View HTML report
open coverage/index.html
```

## 🎯 npm Script Cheatsheet

### Essential Commands
| Command | Description |
|---------|-------------|
| `npm run lint` | ESLint validation |
| `npm run compile` | Production build |
| `npm run watch` | Dev mode with auto-compile |
| `npm test` | Run all tests |
| `npm run test:unit` | Unit tests only |
| `npm run test:integration` | Integration tests |
| `npm run package:full` | Create production VSIX |

### Development Helpers
| Command | Description |
|---------|-------------|
| `npm run dev:setup` | Switch to dev-friendly config |
| `npm run compile-tests` | Compile test files |
| `npm run watch-tests` | Auto-compile tests |
| `npm run coverage:clean` | Clean coverage reports |

### Version Management
| Command | Description |
|---------|-------------|
| `npm run version:bump:patch` | Bump patch version (0.0.X) |
| `npm run version:bump:minor` | Bump minor version (0.X.0) |
| `npm run version:bump:major` | Bump major version (X.0.0) |

## 🚨 Common Issues & Solutions

### Issue: Tests fail with "Cannot find module 'vscode'"
**Solution:**
```bash
npm run compile-tests
# Ensures test fixtures are copied
```

### Issue: Integration tests fail on Linux
**Solution:**
```bash
# Install required dependencies
sudo apt-get install -y xvfb libnss3-dev libatk-bridge2.0-dev

# Run with xvfb
xvfb-run -a npm run test:integration
```

### Issue: VSIX package too large
**Solution:**
```bash
# Use production packaging
npm run package:full

# This uses .vscodeignore.production which excludes:
# - Source files (src/, test/)
# - Dev dependencies
# - CI/CD files
# - Documentation
```

### Issue: npm audit warnings
**Solution:**
```bash
# Check what's failing
npm audit

# Fix automatically (if possible)
npm audit fix

# Ignore dev dependencies
npm audit --omit=dev
```

## 🎓 Workflow Examples

### Example 1: Fixing a Bug
```bash
# 1. Update source files in src/
# 2. Quick check
./.github/workflows/scripts/quick-check.sh

# 3. If passed, commit
git add .
git commit -m "fix: ..."
```

### Example 2: Adding a Feature
```bash
# 1. Create feature branch
git checkout -b feature/new-feature

# 2. Develop with watch mode
npm run watch        # Terminal 1
npm run watch-tests  # Terminal 2

# 3. Update test files
# 4. Full validation before push
./.github/workflows/scripts/validate-locally.sh

# 5. If passed, push
git push origin feature/new-feature
```

### Example 3: Pre-Release Checklist
```bash
# 1. Bump version
npm run version:bump:minor

# 2. Full validation
./.github/workflows/scripts/validate-locally.sh

# 3. Create production package
npm run package:full

# 4. Test the VSIX locally
code --install-extension *.vsix

# 5. Tag for release (publication happens via GitHub Actions)
git tag v0.2.0
git push --tags
```

**Note:** Creating a GitHub release triggers automatic publication and should be done after proper validation. See [Release Process](./releasing.md) for publication workflow.

## 📦 Package Size Optimization

Production package should be **< 2MB**. If larger, check contents:

```bash
unzip -l *.vsix | grep extension/ | sort -k4 -rn | head -20
```

Common culprits: `node_modules/`, `src/`, `test/`, `.github/` (should be excluded)

## 🔍 Debugging Failed CI

When GitHub Actions fails:

1. Check which job failed in GitHub Actions UI
2. Reproduce locally: `./.github/workflows/scripts/validate-locally.sh`
3. Check specific step: `npm run lint`, `npm run test:unit`, or `npm run package:full`

## 💡 Pro Tips

- **Use watch mode** for faster feedback during development
- **Run quick-check.sh frequently** after changes and before switching branches
- **Run validate-locally.sh before pushing** to catch CI failures early
- **Keep test data small** for faster execution and easier debugging
- **Use coverage reports** to find untested code and guide testing efforts

## See Also

- [Development Setup](./development-setup.md)
- [Testing](./testing.md)
- [Manual Test Plan](./testing/test-plan.md)
- [Architecture: Validation](./architecture/validation.md)
