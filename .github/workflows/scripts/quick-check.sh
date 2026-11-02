#!/bin/bash
# Quick validation for rapid development iteration
# Runs only essential checks (faster than full validation)

set -e

echo "🚀 Quick validation check..."

# 1. Lint
echo "▶ Linting..."
pnpm run lint

# 2. Build packages (the extension compiles against them; the unit tests run the built CLI)
echo "▶ Building packages..."
pnpm -C packages -r build

# 3. Compile
echo "▶ Compiling..."
pnpm run compile

# 4. Compile Tests
echo "▶ Compiling tests..."
pnpm run compile-tests

# 5. Unit tests only
echo "▶ Unit tests..."
pnpm run test:unit

echo ""
echo "✅ Quick check passed! Safe to continue development."
echo "💡 Run ./.github/workflows/scripts/validate-locally.sh before pushing to GitHub"
