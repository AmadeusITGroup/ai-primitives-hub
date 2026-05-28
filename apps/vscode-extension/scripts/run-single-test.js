#!/usr/bin/env node

/**
 * Helper script to run a single test file
 * Converts TypeScript test paths to compiled JavaScript paths
 * Optionally compiles tests if needed
 * 
 * Usage: 
 *   npm run test:one -- test/path/to/file.test.ts
 *   npm run test:one -- test/path/to/file.test.ts --no-compile
 */

const { execSync } = require('child_process');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);
const noCompile = args.includes('--no-compile');
const testPath = args.find(arg => !arg.startsWith('--'));

if (!testPath) {
    console.error('Error: No test file specified');
    console.error('Usage: npm run test:one -- test/path/to/file.test.ts [--no-compile]');
    process.exit(1);
}

// Convert TypeScript path to compiled JavaScript path
// test/commands/MyTest.test.ts -> test-dist/test/commands/MyTest.test.js
let jsPath = testPath;

// Remove leading test/ if present and add test-dist/test/
if (jsPath.startsWith('test/')) {
    jsPath = jsPath.replace(/^test\//, 'test-dist/test/');
} else if (!jsPath.startsWith('test-dist/')) {
    // If path doesn't start with test/, assume it's relative and add test-dist/test/
    jsPath = path.join('test-dist/test', jsPath);
}

// Replace .ts extension with .js
jsPath = jsPath.replace(/\.ts$/, '.js');

// Always recompile tests (and src) unless explicitly disabled.
// This ensures test-dist reflects any recent source changes before running.
if (!noCompile) {
    console.log('Compiling tests...');
    try {
        execSync('npm run compile-tests', { stdio: 'inherit' });
    } catch (error) {
        console.error('Test compilation failed');
        process.exit(1);
    }
}

console.log(`Running test: ${testPath}`);
console.log(`Compiled path: ${jsPath}`);

// Run mocha with the compiled test file
try {
    execSync(
        `npx mocha --ui tdd --require ./test/mocha.setup.js --require ./test/unit.setup.js --timeout 5000 "${jsPath}"`,
        { stdio: 'inherit' }
    );
} catch (error) {
    process.exit(error.status || 1);
}
