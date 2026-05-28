#!/usr/bin/env node
/**
 * APM Package Validation Script
 * 
 * Validates:
 * 1. apm.yml manifest structure
 * 2. .apm directory structure
 * 3. Prompt file naming conventions and basic format
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// ANSI color codes
const colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    bold: '\x1b[1m'
};

const PROMPT_EXTENSIONS = ['.prompt.md', '.instructions.md', '.chatmode.md', '.agent.md'];

/**
 * Validate apm.yml manifest
 */
function validateManifest(filePath) {
    const errors = [];
    const warnings = [];

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const manifest = yaml.load(content);

        if (!manifest || typeof manifest !== 'object') {
            return { valid: false, errors: ['Invalid or empty YAML'], warnings: [] };
        }

        // Check required fields
        const required = ['name', 'version', 'description', 'author'];
        required.forEach(field => {
            if (!manifest[field]) {
                errors.push(`Missing required field: ${field}`);
            }
        });

        // Validate types
        if (manifest.tags && !Array.isArray(manifest.tags)) {
            errors.push('tags must be an array');
        }

        if (manifest.dependencies && typeof manifest.dependencies !== 'object') {
            errors.push('dependencies must be an object');
        }

        return {
            valid: errors.length === 0,
            errors,
            warnings
        };
    } catch (e) {
        return { valid: false, errors: [`Failed to parse apm.yml: ${e.message}`], warnings: [] };
    }
}

/**
 * Scan directory recursively for prompt files
 */
function scanPrompts(dir, fileList = []) {
    const files = fs.readdirSync(dir);
    
    files.forEach(file => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        
        if (stat.isDirectory()) {
            if (!file.startsWith('.')) { // Skip hidden dirs
                scanPrompts(filePath, fileList);
            }
        } else {
            fileList.push(filePath);
        }
    });
    
    return fileList;
}

/**
 * Validate prompt files in .apm directory
 */
function validatePrompts(projectRoot) {
    const apmDir = path.join(projectRoot, '.apm');
    const errors = [];
    const warnings = [];
    
    if (!fs.existsSync(apmDir)) {
        // It's allowed to be empty initially, but good to warn if missing?
        // Actually, empty package is valid but useless.
        warnings.push('.apm directory not found (no prompts)');
        return { valid: true, errors, warnings };
    }
    
    const files = scanPrompts(apmDir);
    let validFiles = 0;
    
    files.forEach(file => {
        const fileName = path.basename(file);
        const relativePath = path.relative(projectRoot, file);
        
        // Check extension
        const hasValidExt = PROMPT_EXTENSIONS.some(ext => fileName.endsWith(ext));
        if (!hasValidExt) {
            warnings.push(`File ${relativePath} has unknown extension. Supported: ${PROMPT_EXTENSIONS.join(', ')}`);
        } else {
            validFiles++;
            
            // Basic content check
            try {
                const content = fs.readFileSync(file, 'utf8');
                if (content.trim().length === 0) {
                    warnings.push(`File ${relativePath} is empty`);
                }
            } catch (e) {
                errors.push(`Failed to read ${relativePath}: ${e.message}`);
            }
        }
    });
    
    if (validFiles === 0 && fs.existsSync(apmDir)) {
        warnings.push('No valid prompt files found in .apm directory');
    }
    
    return {
        valid: errors.length === 0,
        errors,
        warnings
    };
}

function main() {
    console.log(`${colors.cyan}${colors.bold}🔍 APM Package Validation${colors.reset}\n`);
    
    const projectRoot = process.cwd();
    let exitCode = 0;
    
    // 1. Validate apm.yml
    const manifestPath = path.join(projectRoot, 'apm.yml');
    if (!fs.existsSync(manifestPath)) {
        console.error(`${colors.red}❌ apm.yml not found${colors.reset}`);
        process.exit(1);
    }
    
    console.log(`Validating apm.yml...`);
    const manifestResult = validateManifest(manifestPath);
    
    if (manifestResult.errors.length > 0) {
        manifestResult.errors.forEach(e => console.error(`  ${colors.red}❌ ${e}${colors.reset}`));
        exitCode = 1;
    } else {
        console.log(`  ${colors.green}✓ Valid manifest${colors.reset}`);
    }
    
    if (manifestResult.warnings.length > 0) {
        manifestResult.warnings.forEach(w => console.warn(`  ${colors.yellow}⚠️  ${w}${colors.reset}`));
    }
    
    console.log('');
    
    // 2. Validate Prompts
    console.log(`Validating prompts...`);
    const promptsResult = validatePrompts(projectRoot);
    
    if (promptsResult.errors.length > 0) {
        promptsResult.errors.forEach(e => console.error(`  ${colors.red}❌ ${e}${colors.reset}`));
        exitCode = 1;
    }
    
    if (promptsResult.warnings.length > 0) {
        promptsResult.warnings.forEach(w => console.warn(`  ${colors.yellow}⚠️  ${w}${colors.reset}`));
    }
    
    if (promptsResult.valid && promptsResult.errors.length === 0 && promptsResult.warnings.length === 0) {
        console.log(`  ${colors.green}✓ All prompts valid${colors.reset}`);
    }
    
    console.log('');
    
    if (exitCode === 0) {
        console.log(`${colors.green}✅ Validation passed${colors.reset}`);
    } else {
        console.log(`${colors.red}❌ Validation failed${colors.reset}`);
    }
    
    process.exit(exitCode);
}

if (require.main === module) {
    main();
}
