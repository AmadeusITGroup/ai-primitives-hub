/**
 * Skills file generation utilities (file-IO dependent).
 * @module app/collection/generate-skill
 *
 * File-IO dependent skill generation functions.
 * Pure validation functions are in src/domain/skill/validate.ts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  AllSkillsValidationResult,
  SkillValidationResult,
} from '@prompt-registry/core';
import {
  MAX_ASSET_SIZE,
  parseFrontmatter,
  validateSkillDescription,
  validateSkillName,
} from '@prompt-registry/core';

/**
 * Validate a single skill folder.
 * @param folderPath
 * @param folderName
 */
export function validateSkillFolder(folderPath: string, folderName: string): SkillValidationResult {
  const errors: string[] = [];
  let skillName = folderName;

  // Check if SKILL.md exists
  const skillFile = path.join(folderPath, 'SKILL.md');
  if (!fs.existsSync(skillFile)) {
    return {
      skillName,
      folderName,
      valid: false,
      errors: ['Missing SKILL.md file']
    };
  }

  // Read and parse frontmatter
  const content = fs.readFileSync(skillFile, 'utf8');
  const metadata = parseFrontmatter(content);
  if (!metadata) {
    return {
      skillName,
      folderName,
      valid: false,
      errors: ['Failed to parse SKILL.md frontmatter']
    };
  }

  skillName = metadata.name || folderName;

  // Validate name field
  const nameError = validateSkillName(metadata.name);
  if (nameError) {
    errors.push(`name: ${nameError}`);
  } else if (metadata.name !== folderName) {
    errors.push(`Folder name "${folderName}" does not match skill name "${metadata.name}"`);
  }

  // Validate description field
  const descError = validateSkillDescription(metadata.description);
  if (descError) {
    errors.push(`description: ${descError}`);
  }

  // Check for reasonable file sizes in bundled assets
  const files = fs.readdirSync(folderPath);
  for (const file of files) {
    if (file === 'SKILL.md') {
      continue;
    }
    const filePath = path.join(folderPath, file);
    try {
      const stats = fs.statSync(filePath);
      if (stats.isFile() && stats.size > MAX_ASSET_SIZE) {
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
        errors.push(`Bundled asset "${file}" exceeds maximum size of 5MB (${sizeMB}MB)`);
      }
    } catch (error) {
      errors.push(`Cannot access bundled asset "${file}": ${(error as Error).message}`);
    }
  }

  return {
    skillName,
    folderName,
    valid: errors.length === 0,
    errors
  };
}

/**
 * Validate all skills in a directory.
 * @param repoRoot
 * @param skillsDir
 */
export function validateAllSkills(repoRoot: string, skillsDir = 'skills'): AllSkillsValidationResult {
  const skillsPath = path.join(repoRoot, skillsDir);

  if (!fs.existsSync(skillsPath)) {
    return {
      valid: true,
      skills: [],
      totalSkills: 0,
      validSkills: 0,
      invalidSkills: 0
    };
  }

  const skillFolders = fs.readdirSync(skillsPath).filter((file) => {
    const filePath = path.join(skillsPath, file);
    return fs.statSync(filePath).isDirectory();
  });

  if (skillFolders.length === 0) {
    return {
      valid: true,
      skills: [],
      totalSkills: 0,
      validSkills: 0,
      invalidSkills: 0
    };
  }

  const results: SkillValidationResult[] = [];
  const usedNames = new Set<string>();
  let hasErrors = false;

  for (const folder of skillFolders) {
    const folderPath = path.join(skillsPath, folder);
    const result = validateSkillFolder(folderPath, folder);

    // Check for duplicate names
    if (result.valid && usedNames.has(result.skillName)) {
      result.valid = false;
      result.errors.push(`Duplicate skill name "${result.skillName}"`);
    } else if (result.valid) {
      usedNames.add(result.skillName);
    }

    if (!result.valid) {
      hasErrors = true;
    }

    results.push(result);
  }

  return {
    valid: !hasErrors,
    skills: results,
    totalSkills: results.length,
    validSkills: results.filter((r) => r.valid).length,
    invalidSkills: results.filter((r) => !r.valid).length
  };
}

/**
 * Generate SKILL.md content
 * @param name
 * @param description
 */
export function generateSkillContent(name: string, description: string): string {
  return `---
name: ${name}
description: "${description}"
---

# ${name}

${description}

## Capabilities

Describe what this skill enables Copilot to do.

## Usage

Explain when and how Copilot should use this skill.

## Examples

Provide example interactions or use cases.
`;
}

/**
 * Create a new skill directory structure
 * @param repoRoot
 * @param skillName
 * @param description
 * @param skillsDir
 */
export function createSkill(
    repoRoot: string,
    skillName: string,
    description: string,
    skillsDir = 'skills'
): { success: boolean; path: string; error?: string } {
  // Validate inputs
  const nameError = validateSkillName(skillName);
  if (nameError) {
    return { success: false, path: '', error: nameError };
  }

  const descError = validateSkillDescription(description);
  if (descError) {
    return { success: false, path: '', error: descError };
  }

  const skillsPath = path.join(repoRoot, skillsDir);
  const skillPath = path.join(skillsPath, skillName);

  if (fs.existsSync(skillPath)) {
    return { success: false, path: skillPath, error: `Skill "${skillName}" already exists` };
  }

  try {
    // Ensure skills directory exists
    if (!fs.existsSync(skillsPath)) {
      fs.mkdirSync(skillsPath, { recursive: true });
    }

    // Create skill folder
    fs.mkdirSync(skillPath, { recursive: true });

    // Create SKILL.md
    const content = generateSkillContent(skillName, description);
    fs.writeFileSync(path.join(skillPath, 'SKILL.md'), content);

    return { success: true, path: skillPath };
  } catch (error) {
    return { success: false, path: skillPath, error: (error as Error).message };
  }
}
