#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  AI Primitives Hub - Local Validation Suite                   ║${NC}"
echo -e "${BLUE}║  Simulates GitHub Actions CI/CD workflow                    ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

FAILED=0
TOTAL=0

run_step() {
    local step_name="$1"
    local command="$2"
    TOTAL=$((TOTAL + 1))
    
    echo ""
    echo -e "${YELLOW}▶ Step $TOTAL: $step_name${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    
    if eval "$command"; then
        echo -e "${GREEN}✓ $step_name passed${NC}"
        return 0
    else
        echo -e "${RED}✗ $step_name failed${NC}"
        FAILED=$((FAILED + 1))
        return 1
    fi
}

# 1. Clean previous builds
run_step "Clean build artifacts" "npm run coverage:clean 2>/dev/null || true"
# 2. Clean test-dist
run_step "Clean test-dist" "rm -rf test-dist"
# 3. Install dependencies
run_step "Install dependencies" "npm ci --fund=false"
# 4. Security audit
run_step "Security audit (npm)" "npm audit --omit=dev --audit-level=moderate || echo 'Audit warnings found'"
# 5. Lint code
run_step "ESLint validation" "npm run lint"
# 6. Type checking & compilation
run_step "TypeScript compilation" "npm run compile"
# 7. Compile tests
run_step "Compile test suite" "npm run compile-tests"
# 8. Run unit tests
run_step "Unit tests" "npm run test:unit"
# 9. Run integration tests (if display available)
if [ -n "$DISPLAY" ] || command -v xvfb-run &> /dev/null; then
    if command -v xvfb-run &> /dev/null; then
        run_step "Integration tests (xvfb)" "xvfb-run -a npm run test:integration"
    else
        run_step "Integration tests" "npm run test:integration"
    fi
else
    echo -e "${YELLOW}⚠ Skipping integration tests (no display available)${NC}"
fi

# 10. Package VSIX (with production config)
run_step "Package VSIX (production mode)" "npm run package:full"

# 11. Validate VSIX contents
run_step "Validate VSIX package" "
    VSIX_FILE=\$(ls -t *.vsix 2>/dev/null | head -1)
    if [ -n \"\$VSIX_FILE\" ]; then
        echo \"Found VSIX: \$VSIX_FILE\"
        unzip -l \"\$VSIX_FILE\" | head -20
        SIZE=\$(ls -lh \"\$VSIX_FILE\" | awk '{print \$5}')
        echo \"Package size: \$SIZE\"
    else
        echo 'No VSIX file found'
        exit 1
    fi
"

# 12. License compliance check (optional)
if command -v npx &> /dev/null; then
    run_step "License compliance check" "npx license-checker --summary 2>/dev/null || echo 'license-checker not available'"
fi

# Summary
echo ""
echo -e "${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  Validation Summary                                          ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "Total steps: ${TOTAL}"
echo -e "Passed: ${GREEN}$((TOTAL - FAILED))${NC}"
echo -e "Failed: ${RED}${FAILED}${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}✓ All validation steps passed!${NC}"
    echo -e "${GREEN}✓ Ready to push to GitHub${NC}"
    exit 0
else
    echo -e "${RED}✗ ${FAILED} validation step(s) failed${NC}"
    echo -e "${RED}✗ Fix issues before pushing${NC}"
    exit 1
fi
