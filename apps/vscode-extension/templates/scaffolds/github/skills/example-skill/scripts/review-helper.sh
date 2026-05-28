#!/bin/bash
# Code Review Helper Script
# This script performs automated checks on code files to assist with code reviews.

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Usage information
usage() {
    echo "Usage: $0 <file-or-directory>"
    echo ""
    echo "Performs automated code review checks on the specified file or directory."
    echo ""
    echo "Options:"
    echo "  -h, --help    Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0 src/main.js"
    echo "  $0 src/"
    exit 1
}

# Check if file/directory argument is provided
if [ $# -eq 0 ] || [ "$1" == "-h" ] || [ "$1" == "--help" ]; then
    usage
fi

TARGET="$1"

# Verify target exists
if [ ! -e "$TARGET" ]; then
    echo -e "${RED}Error: '$TARGET' does not exist${NC}"
    exit 1
fi

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}   Code Review Helper${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "Analyzing: ${YELLOW}$TARGET${NC}"
echo ""

# Function to check file size
check_file_size() {
    local file="$1"
    local lines=$(wc -l < "$file" 2>/dev/null || echo "0")
    if [ "$lines" -gt 500 ]; then
        echo -e "${YELLOW}⚠ Warning:${NC} File has $lines lines (consider splitting)"
    elif [ "$lines" -gt 300 ]; then
        echo -e "${YELLOW}ℹ Note:${NC} File has $lines lines"
    else
        echo -e "${GREEN}✓${NC} File size OK ($lines lines)"
    fi
}

# Function to check for common issues
check_common_issues() {
    local file="$1"
    local issues_found=0
    
    echo -e "\n${BLUE}Checking for common issues...${NC}"
    
    # Check for TODO/FIXME comments
    local todos=$(grep -c -E "(TODO|FIXME|XXX|HACK)" "$file" 2>/dev/null || echo "0")
    if [ "$todos" -gt 0 ]; then
        echo -e "${YELLOW}⚠ Found $todos TODO/FIXME comments${NC}"
        grep -n -E "(TODO|FIXME|XXX|HACK)" "$file" 2>/dev/null | head -5
        issues_found=$((issues_found + 1))
    fi
    
    # Check for console.log/print statements (potential debug code)
    local debug=$(grep -c -E "(console\.(log|debug|info)|print\(|println|System\.out\.print)" "$file" 2>/dev/null || echo "0")
    if [ "$debug" -gt 0 ]; then
        echo -e "${YELLOW}⚠ Found $debug potential debug statements${NC}"
        issues_found=$((issues_found + 1))
    fi
    
    # Check for hardcoded credentials patterns
    local creds=$(grep -c -E "(password|secret|api_key|apikey|token).*=.*['\"][^'\"]+['\"]" "$file" 2>/dev/null || echo "0")
    if [ "$creds" -gt 0 ]; then
        echo -e "${RED}⚠ Warning: Possible hardcoded credentials detected!${NC}"
        issues_found=$((issues_found + 1))
    fi
    
    # Check for very long lines
    local long_lines=$(awk 'length > 120' "$file" 2>/dev/null | wc -l || echo "0")
    if [ "$long_lines" -gt 0 ]; then
        echo -e "${YELLOW}⚠ Found $long_lines lines exceeding 120 characters${NC}"
        issues_found=$((issues_found + 1))
    fi
    
    if [ "$issues_found" -eq 0 ]; then
        echo -e "${GREEN}✓ No common issues detected${NC}"
    fi
}

# Function to show file statistics
show_statistics() {
    local file="$1"
    echo -e "\n${BLUE}File Statistics:${NC}"
    
    # Count functions/methods (basic heuristic)
    local functions=$(grep -c -E "^[[:space:]]*(function|def|func|fn|public|private|protected)[[:space:]]" "$file" 2>/dev/null || echo "0")
    echo "  Functions/Methods: ~$functions"
    
    # Count imports
    local imports=$(grep -c -E "^[[:space:]]*(import|require|use|from.*import)" "$file" 2>/dev/null || echo "0")
    echo "  Import statements: $imports"
    
    # Count comments
    local comments=$(grep -c -E "^[[:space:]]*(//|#|/\*|\*)" "$file" 2>/dev/null || echo "0")
    echo "  Comment lines: ~$comments"
}

# Main analysis
if [ -f "$TARGET" ]; then
    # Single file analysis
    echo -e "${BLUE}Single File Analysis${NC}"
    echo "----------------------------------------"
    check_file_size "$TARGET"
    check_common_issues "$TARGET"
    show_statistics "$TARGET"
elif [ -d "$TARGET" ]; then
    # Directory analysis
    echo -e "${BLUE}Directory Analysis${NC}"
    echo "----------------------------------------"
    
    file_count=$(find "$TARGET" -type f \( -name "*.js" -o -name "*.ts" -o -name "*.py" -o -name "*.java" -o -name "*.go" -o -name "*.rs" -o -name "*.rb" \) | wc -l)
    echo -e "Found ${YELLOW}$file_count${NC} source files"
    
    # Analyze each file
    find "$TARGET" -type f \( -name "*.js" -o -name "*.ts" -o -name "*.py" -o -name "*.java" -o -name "*.go" -o -name "*.rs" -o -name "*.rb" \) | while read -r file; do
        echo -e "\n${BLUE}--- $file ---${NC}"
        check_file_size "$file"
        check_common_issues "$file"
    done
fi

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}Review helper complete!${NC}"
echo -e "${BLUE}========================================${NC}"
