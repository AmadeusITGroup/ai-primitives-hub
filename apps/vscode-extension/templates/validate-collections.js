#!/usr/bin/env node
/**
 * Collection Validation Script
 * 
 * Standalone script to validate awesome-copilot collection files.
 * Can be run locally or in CI/CD pipelines.
 * 
 * Attribution: Inspired by github/awesome-copilot
 * https://github.com/github/awesome-copilot
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// ANSI color codes for terminal output
const colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    bold: '\x1b[1m'
};

// Validation constants
const VALID_KINDS = ['prompt', 'instruction', 'chat-mode', 'agent'];
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 30;
const MAX_ITEMS = 50;
const ID_PATTERN = /^[a-z0-9-]+$/;

/**
 * Validate a single collection file
 */
function validateCollection(filePath, projectRoot) {
    const errors = [];
    const warnings = [];
    const fileName = path.basename(filePath);

    try {
        // Read and parse YAML
        const content = fs.readFileSync(filePath, 'utf8');
        let collection;

        try {
            collection = yaml.load(content);
        } catch (parseError) {
            return {
                valid: false,
                errors: [{ file: fileName, message: `Failed to parse YAML: ${parseError.message}` }],
                warnings: []
            };
        }

        if (!collection) {
            return {
                valid: false,
                errors: [{ file: fileName, message: 'Empty or invalid YAML file' }],
                warnings: []
            };
        }

        // Validate required fields
        if (!collection.id) {
            errors.push({ file: fileName, message: 'Missing required field: id' });
        }
        if (!collection.name) {
            errors.push({ file: fileName, message: 'Missing required field: name' });
        }
        if (!collection.description) {
            errors.push({ file: fileName, message: 'Missing required field: description' });
        }
        if (!collection.items || !Array.isArray(collection.items)) {
            errors.push({ file: fileName, message: 'Missing or invalid field: items (must be an array)' });
        }

        // Validate ID format
        if (collection.id && !ID_PATTERN.test(collection.id)) {
            errors.push({
                file: fileName,
                message: 'Invalid id format (must be lowercase letters, numbers, and hyphens only)'
            });
        }

        // Validate description length
        if (collection.description && collection.description.length > MAX_DESCRIPTION_LENGTH) {
            warnings.push({
                file: fileName,
                message: `Description is longer than recommended (${MAX_DESCRIPTION_LENGTH} characters)`
            });
        }

        // Validate items
        if (collection.items && Array.isArray(collection.items)) {
            if (collection.items.length === 0) {
                warnings.push({ file: fileName, message: 'Collection has no items' });
            }

            if (collection.items.length > MAX_ITEMS) {
                warnings.push({
                    file: fileName,
                    message: `Collection has more than ${MAX_ITEMS} items (recommended max)`
                });
            }

            collection.items.forEach((item, index) => {
                const itemNumber = index + 1;

                if (!item.path) {
                    errors.push({ file: fileName, message: `Item ${itemNumber}: Missing 'path' field` });
                }
                if (!item.kind) {
                    errors.push({ file: fileName, message: `Item ${itemNumber}: Missing 'kind' field` });
                } else if (!VALID_KINDS.includes(item.kind)) {
                    errors.push({
                        file: fileName,
                        message: `Item ${itemNumber}: Invalid 'kind' value (must be one of: ${VALID_KINDS.join(', ')})`
                    });
                }

                // Validate file exists
                if (item.path) {
                    const itemPath = path.join(projectRoot, item.path);
                    if (!fs.existsSync(itemPath)) {
                        errors.push({
                            file: fileName,
                            message: `Item ${itemNumber}: Referenced file does not exist: ${item.path}`
                        });
                    }
                }
            });
        }

        // Validate tags
        if (collection.tags) {
            if (!Array.isArray(collection.tags)) {
                errors.push({ file: fileName, message: 'Tags must be an array' });
            } else {
                if (collection.tags.length > MAX_TAGS) {
                    warnings.push({
                        file: fileName,
                        message: `More than ${MAX_TAGS} tags (recommended max)`
                    });
                }

                collection.tags.forEach((tag, index) => {
                    const tagNumber = index + 1;
                    if (typeof tag !== 'string') {
                        errors.push({ file: fileName, message: `Tag ${tagNumber}: Must be a string` });
                    } else if (tag.length > MAX_TAG_LENGTH) {
                        warnings.push({
                            file: fileName,
                            message: `Tag ${tagNumber}: Longer than ${MAX_TAG_LENGTH} characters`
                        });
                    }
                });
            }
        }

        return {
            valid: errors.length === 0,
            errors,
            warnings
        };

    } catch (error) {
        return {
            valid: false,
            errors: [{ file: fileName, message: `Unexpected error: ${error.message}` }],
            warnings: []
        };
    }
}

/**
 * Main validation function
 */
function main() {
    console.log(`${colors.cyan}${colors.bold}📋 Collection Validation${colors.reset}\n`);
    console.log(`${colors.cyan}Attribution: Inspired by github/awesome-copilot${colors.reset}`);
    console.log(`${colors.cyan}https://github.com/github/awesome-copilot${colors.reset}\n`);

    // Find collections directory
    const projectRoot = process.cwd();
    const collectionsDir = path.join(projectRoot, 'collections');

    if (!fs.existsSync(collectionsDir)) {
        console.error(`${colors.red}❌ Error: Collections directory not found: ${collectionsDir}${colors.reset}`);
        process.exit(1);
    }

    // Find all collection files
    const files = fs.readdirSync(collectionsDir)
        .filter(f => f.endsWith('.collection.yml'))
        .sort();

    if (files.length === 0) {
        console.log(`${colors.yellow}⚠️  No collection files found in ${collectionsDir}${colors.reset}`);
        process.exit(0);
    }

    console.log(`Found ${files.length} collection(s)\n`);

    let totalErrors = 0;
    let totalWarnings = 0;
    let validCollections = 0;

    // Validate each collection
    for (const file of files) {
        const filePath = path.join(collectionsDir, file);
        const result = validateCollection(filePath, projectRoot);

        console.log(`Validating: ${colors.bold}${file}${colors.reset}`);

        if (result.errors.length === 0 && result.warnings.length === 0) {
            console.log(`  ${colors.green}✓ Valid${colors.reset}`);
            validCollections++;
        } else {
            if (result.errors.length > 0) {
                result.errors.forEach(err => {
                    console.log(`  ${colors.red}✗ Error: ${err.message}${colors.reset}`);
                });
                totalErrors += result.errors.length;
            }
            if (result.warnings.length > 0) {
                result.warnings.forEach(warn => {
                    console.log(`  ${colors.yellow}⚠ Warning: ${warn.message}${colors.reset}`);
                });
                totalWarnings += result.warnings.length;
            }
        }
        console.log('');
    }

    // Print summary
    console.log('='.repeat(60));
    console.log(`Summary: ${validCollections}/${files.length} collections valid`);
    
    if (totalErrors > 0) {
        console.log(`${colors.red}Total Errors: ${totalErrors}${colors.reset}`);
    } else {
        console.log(`${colors.green}Total Errors: ${totalErrors}${colors.reset}`);
    }
    
    if (totalWarnings > 0) {
        console.log(`${colors.yellow}Total Warnings: ${totalWarnings}${colors.reset}`);
    } else {
        console.log(`${colors.green}Total Warnings: ${totalWarnings}${colors.reset}`);
    }
    
    console.log('='.repeat(60));

    // Exit with appropriate code
    if (totalErrors > 0) {
        console.log(`\n${colors.red}❌ Validation failed${colors.reset}`);
        process.exit(1);
    } else if (totalWarnings > 0) {
        console.log(`\n${colors.yellow}⚠️  Validation passed with warnings${colors.reset}`);
        process.exit(0);
    } else {
        console.log(`\n${colors.green}✅ All collections valid!${colors.reset}`);
        process.exit(0);
    }
}

// Run main function
if (require.main === module) {
    main();
}

module.exports = { validateCollection };
