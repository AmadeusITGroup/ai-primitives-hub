#!/usr/bin/env bash

################################################################################
# update-version.sh
# 
# Automatically updates version references across the project to match the
# version specified in package.json.
#
# Usage:
#   ./scripts/update-version.sh           # Use version from package.json
#   ./scripts/update-version.sh 2.1.0     # Set specific version
#
# This script updates:
#   - README.md version badge
#   - README.md version references in text
#   - CONTRIBUTING.md version examples
#   - package.json (if version argument provided)
#
# Exit codes:
#   0 - Success
#   1 - Error (missing dependencies, file not found, etc.)
################################################################################

set -euo pipefail

# Colors for output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly NC='\033[0m' # No Color

# Script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Files to update
readonly PACKAGE_JSON="${PROJECT_ROOT}/package.json"
readonly README_MD="${PROJECT_ROOT}/README.md"
readonly CONTRIBUTING_MD="${PROJECT_ROOT}/CONTRIBUTING.md"

################################################################################
# Helper Functions
################################################################################

log_info() {
    echo -e "${BLUE}ℹ${NC} $*"
}

log_success() {
    echo -e "${GREEN}✓${NC} $*"
}

log_warning() {
    echo -e "${YELLOW}⚠${NC} $*"
}

log_error() {
    echo -e "${RED}✗${NC} $*" >&2
}

# Check if a file exists
check_file() {
    local file="$1"
    if [[ ! -f "${file}" ]]; then
        log_error "File not found: ${file}"
        return 1
    fi
    return 0
}

# Validate version format (semver: X.Y.Z)
validate_version() {
    local version="$1"
    if [[ ! "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        log_error "Invalid version format: ${version}"
        log_error "Expected format: X.Y.Z (e.g., 2.0.0)"
        return 1
    fi
    return 0
}

# Extract version from package.json
get_package_version() {
    if ! check_file "${PACKAGE_JSON}"; then
        return 1
    fi
    
    local version
    version=$(grep -oP '(?<="version":\s").*?(?=")' "${PACKAGE_JSON}" | head -1)
    
    if [[ -z "${version}" ]]; then
        log_error "Could not extract version from ${PACKAGE_JSON}"
        return 1
    fi
    
    echo "${version}"
}

# Update version in package.json
update_package_json() {
    local new_version="$1"
    local temp_file="${PACKAGE_JSON}.tmp"
    
    log_info "Updating package.json to version ${new_version}..."
    
    if command -v jq &> /dev/null; then
        # Use jq if available (more robust)
        jq --arg ver "${new_version}" '.version = $ver' "${PACKAGE_JSON}" > "${temp_file}"
    else
        # Fallback to sed
        sed "s/\"version\": \"[^\"]*\"/\"version\": \"${new_version}\"/" "${PACKAGE_JSON}" > "${temp_file}"
    fi
    
    mv "${temp_file}" "${PACKAGE_JSON}"
    log_success "Updated package.json"
}

# Update README.md version references
update_readme() {
    local old_version="$1"
    local new_version="$2"
    
    if ! check_file "${README_MD}"; then
        return 1
    fi
    
    log_info "Updating README.md..."
    
    local temp_file="${README_MD}.tmp"
    local updated=0
    
    # Update version badge
    if grep -q "version-${old_version}" "${README_MD}"; then
        sed "s/version-${old_version}/version-${new_version}/g" "${README_MD}" > "${temp_file}"
        mv "${temp_file}" "${README_MD}"
        log_success "  Updated version badge: ${old_version} → ${new_version}"
        ((updated++))
    fi
    
    # Update VSIX filename references (e.g., prompt-registry-2.0.0.vsix)
    if grep -q "prompt-registry-${old_version}.vsix" "${README_MD}"; then
        sed "s/prompt-registry-${old_version}\.vsix/prompt-registry-${new_version}.vsix/g" "${README_MD}" > "${temp_file}"
        mv "${temp_file}" "${README_MD}"
        log_success "  Updated VSIX filename: ${old_version} → ${new_version}"
        ((updated++))
    fi
    
    # Update "Current Version (X.Y.Z)" headings
    if grep -q "Current Version (${old_version})" "${README_MD}"; then
        sed "s/Current Version (${old_version})/Current Version (${new_version})/g" "${README_MD}" > "${temp_file}"
        mv "${temp_file}" "${README_MD}"
        log_success "  Updated version heading: ${old_version} → ${new_version}"
        ((updated++))
    fi
    
    # Update "version (X.Y.Z+)" references
    if grep -q "version (${old_version}+)" "${README_MD}"; then
        sed "s/version (${old_version}+)/version (${new_version}+)/g" "${README_MD}" > "${temp_file}"
        mv "${temp_file}" "${README_MD}"
        log_success "  Updated version reference: ${old_version}+ → ${new_version}+"
        ((updated++))
    fi
    
    if [[ ${updated} -eq 0 ]]; then
        log_warning "  No version references found to update in README.md"
    fi
}

# Update CONTRIBUTING.md version examples
update_contributing() {
    local old_version="$1"
    local new_version="$2"
    
    if ! check_file "${CONTRIBUTING_MD}"; then
        log_warning "CONTRIBUTING.md not found, skipping..."
        return 0
    fi
    
    log_info "Updating CONTRIBUTING.md..."
    
    # CONTRIBUTING.md typically has example versions in semantic versioning examples
    # We'll be conservative and only update if there's a specific pattern
    local temp_file="${CONTRIBUTING_MD}.tmp"
    local updated=0
    
    # Look for version examples like "v1.0.0 → v2.0.0" and update the target version
    if grep -q "v[0-9]\+\.[0-9]\+\.[0-9]\+ → v${old_version}" "${CONTRIBUTING_MD}"; then
        sed "s/\(v[0-9]\+\.[0-9]\+\.[0-9]\+\) → v${old_version}/\1 → v${new_version}/g" "${CONTRIBUTING_MD}" > "${temp_file}"
        mv "${temp_file}" "${CONTRIBUTING_MD}"
        log_success "  Updated version examples"
        ((updated++))
    fi
    
    if [[ ${updated} -eq 0 ]]; then
        log_info "  No version examples to update in CONTRIBUTING.md"
    fi
}

# Create a backup of a file
backup_file() {
    local file="$1"
    local backup="${file}.backup.$(date +%Y%m%d_%H%M%S)"
    
    if [[ -f "${file}" ]]; then
        cp "${file}" "${backup}"
        log_info "Created backup: $(basename "${backup}")"
    fi
}

# Show diff of changes
show_changes() {
    local file="$1"
    local backup="$2"
    
    if [[ -f "${backup}" ]]; then
        log_info "Changes in $(basename "${file}"):"
        diff -u "${backup}" "${file}" | tail -n +3 || true
    fi
}

################################################################################
# Main Function
################################################################################

main() {
    log_info "Version Update Script for Prompt Registry"
    echo ""
    
    # Change to project root
    cd "${PROJECT_ROOT}"
    
    # Get current version from package.json
    local current_version
    current_version=$(get_package_version) || exit 1
    
    # Determine new version
    local new_version
    if [[ $# -gt 0 ]]; then
        new_version="$1"
        log_info "Target version: ${new_version} (provided as argument)"
    else
        new_version="${current_version}"
        log_info "Using current version from package.json: ${new_version}"
    fi
    
    # Validate new version format
    validate_version "${new_version}" || exit 1
    
    # If versions are the same and no argument provided, nothing to do
    if [[ "${current_version}" == "${new_version}" && $# -eq 0 ]]; then
        log_success "All version references are already at ${current_version}"
        exit 0
    fi
    
    echo ""
    log_info "Current version: ${current_version}"
    log_info "New version:     ${new_version}"
    echo ""
    
    # Ask for confirmation if changing version
    if [[ "${current_version}" != "${new_version}" ]]; then
        read -rp "$(echo -e "${YELLOW}?${NC} Update version from ${current_version} to ${new_version}? [y/N] ")" confirm
        if [[ ! "${confirm}" =~ ^[Yy]$ ]]; then
            log_warning "Version update cancelled"
            exit 0
        fi
        echo ""
    fi
    
    # Create backups
    log_info "Creating backups..."
    backup_file "${PACKAGE_JSON}"
    backup_file "${README_MD}"
    [[ -f "${CONTRIBUTING_MD}" ]] && backup_file "${CONTRIBUTING_MD}"
    echo ""
    
    # Update files
    if [[ "${current_version}" != "${new_version}" ]]; then
        update_package_json "${new_version}"
        echo ""
    fi
    
    update_readme "${current_version}" "${new_version}"
    echo ""
    
    update_contributing "${current_version}" "${new_version}"
    echo ""
    
    # Summary
    log_success "Version update complete!"
    echo ""
    log_info "Updated to version: ${GREEN}${new_version}${NC}"
    echo ""
    log_info "Next steps:"
    echo "  1. Review the changes: git diff"
    echo "  2. Run tests: npm test"
    echo "  3. Update CHANGELOG.md manually"
    echo "  4. Commit changes: git add -A && git commit -m \"chore: bump version to ${new_version}\""
    echo "  5. Create tag: git tag -a v${new_version} -m \"Release v${new_version}\""
    echo "  6. Push: git push && git push --tags"
    echo ""
}

# Run main function
main "$@"
