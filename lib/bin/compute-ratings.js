#!/usr/bin/env node

const { computeRatings, parseArgs } = require('../dist/compute-ratings');

const token = process.env.GITHUB_TOKEN;
if (!token) {
    console.error('Error: GITHUB_TOKEN environment variable is required');
    console.error('Usage: GITHUB_TOKEN=<token> node compute-ratings.js [--config <path>] [--output <path>]');
    process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

computeRatings(args.configPath, args.outputPath, token)
    .then(() => {
        console.log('✓ Rating computation completed successfully');
        process.exit(0);
    })
    .catch((error) => {
        console.error('✗ Rating computation failed:', error.message);
        if (error.stack) {
            console.error(error.stack);
        }
        process.exit(1);
    });
