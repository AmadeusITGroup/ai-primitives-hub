#!/usr/bin/env node
/**
 * CLI wrapper for setup-discussions
 * 
 * Creates GitHub Discussions for all bundles in a hub configuration.
 * The discussions are used to collect ratings and feedback via reactions.
 */

const { setupDiscussions, parseArgs, printUsage } = require('../dist/setup-discussions');

async function main() {
    const args = process.argv.slice(2);
    const { hubUrl, branch, output, category, dryRun, help } = parseArgs(args);
    
    // Show help
    if (help || !hubUrl) {
        printUsage();
        process.exit(help ? 0 : 1);
    }
    
    // Check for GitHub token
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
        console.error('Error: GITHUB_TOKEN environment variable is required');
        console.error('');
        console.error('Create a token at: https://github.com/settings/tokens');
        console.error('Required scopes: repo, write:discussion');
        process.exit(1);
    }
    
    try {
        await setupDiscussions(hubUrl, branch, output, category, dryRun, token);
    } catch (error) {
        console.error('');
        console.error('Fatal error:', error.message);
        process.exit(1);
    }
}

main();
