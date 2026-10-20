#!/usr/bin/env node
/**
 * Collection Validation GitHub Action
 *
 * Validates prompt registry collection files by delegating to the shared
 * `@prompt-registry/collection-scripts` library — the single source of truth
 * for collection validation (valid item kinds are loaded from the JSON schema).
 *
 * Attribution: Inspired by github/awesome-copilot
 * https://github.com/github/awesome-copilot
 */

import fs from 'fs';
import path from 'path';
import { listCollectionFiles, validateAllCollections } from '@prompt-registry/collection-scripts';
import { runCollectionGovernance } from './governance.js';

// ANSI color codes for terminal output
const colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    bold: '\x1b[1m'
};

async function main() {
    if (process.env.INPUT_GOVERNANCE === 'true' || process.env['INPUT_POLICY-PATH'] || process.env['INPUT_MIN-SCORE'] || process.env['INPUT_REPORT-PATH'] || process.env['INPUT_CHECK-RELEASES'] === 'true') {
        process.exitCode = await runCollectionGovernance(process.cwd());
        return;
    }
    console.log(`${colors.cyan}${colors.bold}📋 Collection Validation${colors.reset}\n`);
    console.log(`${colors.cyan}Attribution: Inspired by github/awesome-copilot${colors.reset}`);
    console.log(`${colors.cyan}https://github.com/github/awesome-copilot${colors.reset}\n`);

    const repoRoot = process.cwd();
    const collectionsDir = path.join(repoRoot, 'collections');

    if (!fs.existsSync(collectionsDir)) {
        console.error(`${colors.red}❌ Error: Collections directory not found: ${collectionsDir}${colors.reset}`);
        process.exit(1);
    }

    const files = listCollectionFiles(repoRoot);

    if (files.length === 0) {
        console.log(`${colors.yellow}⚠️  No collection files found in ${collectionsDir}${colors.reset}`);
        process.exit(0);
    }

    console.log(`Found ${files.length} collection(s)\n`);

    // Delegate to the shared validator (includes duplicate id/name detection).
    const result = validateAllCollections(repoRoot, files);

    result.fileResults.forEach((fileResult) => {
        console.log(`Validating: ${colors.bold}${fileResult.file}${colors.reset}`);
        if (fileResult.ok) {
            console.log(`  ${colors.green}✓ Valid${colors.reset}`);
        } else {
            fileResult.errors.forEach((err) => {
                console.log(`  ${colors.red}✗ Error: ${err}${colors.reset}`);
            });
        }
        console.log('');
    });
    const validCollections = result.fileResults.filter((r) => r.ok).length;

    // Cross-collection errors (duplicate collection id/name) are not tied to a
    // single file's result — surface them separately.
    const crossCollectionErrors = result.errors.filter((e) => e.includes('Duplicate collection'));
    if (crossCollectionErrors.length > 0) {
        console.log(`${colors.red}Cross-collection errors:${colors.reset}`);
        crossCollectionErrors.forEach((err) => {
            console.log(`  ${colors.red}✗ ${err}${colors.reset}`);
        });
        console.log('');
    }

    console.log('='.repeat(60));
    console.log(`Summary: ${validCollections}/${files.length} collections valid`);
    console.log(`${result.ok ? colors.green : colors.red}Total Errors: ${result.errors.length}${colors.reset}`);
    console.log('='.repeat(60));

    if (result.ok) {
        console.log(`\n${colors.green}✅ All collections valid!${colors.reset}`);
        process.exit(0);
    } else {
        console.log(`\n${colors.red}❌ Validation failed${colors.reset}`);
        process.exit(1);
    }
}

main().catch((error) => {
    process.stderr.write(`Collection validation could not complete: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
