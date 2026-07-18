#!/bin/bash
echo "Applying post-compilation fixes..."

# Get the directory of the script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Fix test runner path
sed -i 's|test-dist/src/test/index.js|test-dist/test/index.js|' test/runExtensionTests.js

# Update repository references in test files
find test-dist/test/suite -name "*.js" -exec sed -i 's/test-owner/AmadeusITGroup/g; s/test-repo/prompt-registry/g' {} \; 2>/dev/null || true

# Create test-dist/utils directory if it doesn't exist
mkdir -p test-dist/utils

# Create complete logger.js file with all required methods
cat > test-dist/utils/logger.js << 'LOGGER_EOF'
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Logger = void 0;
const vscode = require("vscode");
class Logger {
    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('prompt-registry');
    }
    static getInstance() {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }
    info(message, ...args) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] INFO: ${message}`;
        try {
            this.outputChannel.appendLine(logMessage);
            if (args.length > 0) {
                this.outputChannel.appendLine(`  Details: ${JSON.stringify(args, null, 2)}`);
            }
        } catch (e) {
            console.log("Logger channel closed:", logMessage);
        }
        console.log(logMessage, ...args);
    }
    warn(message, ...args) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] WARN: ${message}`;
        try {
            this.outputChannel.appendLine(logMessage);
            if (args.length > 0) {
                this.outputChannel.appendLine(`  Details: ${JSON.stringify(args, null, 2)}`);
            }
        } catch (e) {
            console.log("Logger channel closed:", logMessage);
        }
        console.warn(logMessage, ...args);
    }
    error(message, error, ...args) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ERROR: ${message}`;
        try {
            this.outputChannel.appendLine(logMessage);
            if (error) {
                this.outputChannel.appendLine(`  Error: ${error.message}`);
                this.outputChannel.appendLine(`  Stack: ${error.stack}`);
            }
            if (args.length > 0) {
                this.outputChannel.appendLine(`  Details: ${JSON.stringify(args, null, 2)}`);
            }
        } catch (e) {
            console.log("Logger channel closed:", logMessage);
        }
        console.error(logMessage, error, ...args);
    }
    debug(message, ...args) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] DEBUG: ${message}`;
        try {
            this.outputChannel.appendLine(logMessage);
            if (args.length > 0) {
                this.outputChannel.appendLine(`  Details: ${JSON.stringify(args, null, 2)}`);
            }
        } catch (e) {
            console.log("Logger channel closed:", logMessage);
        }
        console.debug(logMessage, ...args);
    }
    show() {
        try {
            this.outputChannel.show();
        } catch (e) {
            console.log("Logger channel closed: Cannot show output channel");
        }
    }
    clear() {
        try {
            this.outputChannel.clear();
        } catch (e) {
            console.log("Logger channel closed: Cannot clear output channel");
        }
    }
    dispose() {
        try {
            this.outputChannel.dispose();
        } catch (e) {
            console.log("Logger channel closed: Cannot dispose output channel");
        }
    }
}
exports.Logger = Logger;
LOGGER_EOF

# Ensure test index exists
"$SCRIPT_DIR/ensure-test-index.sh"

# Create VS Code mock
"$SCRIPT_DIR/create-vscode-mock.sh"

echo "Post-compilation fixes applied"
