#!/usr/bin/env node

/**
 * Prompt Registry VS Code Extension Packaging Helpers
 * Handles switching between development and production .vscodeignore files
 */

const fs = require('fs');
const path = require('path');

const VSCODEIGNORE_FILE = '.vscodeignore';
const DEV_IGNORE_FILE = '.vscodeignore.development';
const PROD_IGNORE_FILE = '.vscodeignore.production';

function fileExists(filePath) {
    try {
        return fs.statSync(filePath).isFile();
    } catch (err) {
        return false;
    }
}

function switchToProduction() {
    console.log('📦 Switching to production .vscodeignore for packaging...');
    
    if (!fileExists(PROD_IGNORE_FILE)) {
        console.error(`❌ Production ignore file not found: ${PROD_IGNORE_FILE}`);
        process.exit(1);
    }
    
    // Backup current .vscodeignore if it exists
    if (fileExists(VSCODEIGNORE_FILE)) {
        fs.copyFileSync(VSCODEIGNORE_FILE, '.vscodeignore.backup');
        console.log('📋 Backed up current .vscodeignore');
    }
    
    // Copy production version
    fs.copyFileSync(PROD_IGNORE_FILE, VSCODEIGNORE_FILE);
    console.log('✅ Switched to production .vscodeignore');
    
    // Log what will be excluded
    console.log('📋 Production packaging will exclude:');
    console.log('   - Source files (src/, test/, *.ts)');
    console.log('   - Development tools and configs');
    console.log('   - Documentation except README/CHANGELOG');
    console.log('   - Build artifacts and temporary files');
}

function switchToDevelopment() {
    console.log('🔧 Switching to development .vscodeignore...');
    
    if (!fileExists(DEV_IGNORE_FILE)) {
        console.error(`❌ Development ignore file not found: ${DEV_IGNORE_FILE}`);
        process.exit(1);
    }
    
    // Copy development version
    fs.copyFileSync(DEV_IGNORE_FILE, VSCODEIGNORE_FILE);
    console.log('✅ Switched to development .vscodeignore');
    
    // Log what will be included
    console.log('📋 Development mode includes:');
    console.log('   - Full source code access');
    console.log('   - Test files and documentation');
    console.log('   - Copilot-friendly file access');
}

function restoreBackup() {
    console.log('🔄 Restoring .vscodeignore backup...');
    
    if (fileExists('.vscodeignore.backup')) {
        fs.copyFileSync('.vscodeignore.backup', VSCODEIGNORE_FILE);
        fs.unlinkSync('.vscodeignore.backup');
        console.log('✅ Restored .vscodeignore from backup');
    } else {
        // Fallback to development mode
        switchToDevelopment();
        console.log('ℹ️  No backup found, defaulted to development mode');
    }
}

function showStatus() {
    console.log('📊 VS Code Ignore Status:');
    
    if (!fileExists(VSCODEIGNORE_FILE)) {
        console.log('❌ No .vscodeignore file found');
        return;
    }
    
    const currentContent = fs.readFileSync(VSCODEIGNORE_FILE, 'utf8');
    const devContent = fileExists(DEV_IGNORE_FILE) ? fs.readFileSync(DEV_IGNORE_FILE, 'utf8') : '';
    const prodContent = fileExists(PROD_IGNORE_FILE) ? fs.readFileSync(PROD_IGNORE_FILE, 'utf8') : '';
    
    if (currentContent === devContent) {
        console.log('✅ Currently in DEVELOPMENT mode (Copilot friendly)');
    } else if (currentContent === prodContent) {
        console.log('📦 Currently in PRODUCTION mode (minimal package)');
    } else {
        console.log('⚠️  Custom .vscodeignore detected');
    }
    
    console.log(`📁 Available modes:`);
    console.log(`   - Development: ${fileExists(DEV_IGNORE_FILE) ? '✅' : '❌'} ${DEV_IGNORE_FILE}`);
    console.log(`   - Production:  ${fileExists(PROD_IGNORE_FILE) ? '✅' : '❌'} ${PROD_IGNORE_FILE}`);
}

// Command line interface
const command = process.argv[2];

switch (command) {
    case 'prod':
    case 'production':
        switchToProduction();
        break;
    case 'dev':
    case 'development':
        switchToDevelopment();
        break;
    case 'restore':
        restoreBackup();
        break;
    case 'status':
        showStatus();
        break;
    default:
        console.log('Prompt Registry VS Code Extension Packaging Helpers');
        console.log('');
        console.log('Usage: node scripts/package-helpers.js <command>');
        console.log('');
        console.log('Commands:');
        console.log('  prod, production  - Switch to production .vscodeignore for packaging');
        console.log('  dev, development  - Switch to development .vscodeignore for coding');
        console.log('  restore          - Restore from backup (.vscodeignore.backup)');
        console.log('  status           - Show current ignore mode status');
        console.log('');
        console.log('Examples:');
        console.log('  npm run package:prepare  # Switch to production mode');
        console.log('  npm run package:cleanup  # Restore development mode');
        console.log('  npm run ignore:status    # Check current mode');
        break;
}
