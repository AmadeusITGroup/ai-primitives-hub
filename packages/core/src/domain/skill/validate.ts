/**
 * Skills validation module (pure functions).
 *
 * Validates skill folders following the Agent Skills specification.
 * File-IO dependent functions belong in the `app` layer.
 *
 * Ported unchanged from the reference branch's
 * `core/src/domain/skill/validate.ts`. Its `parseFrontmatter` is
 * reused as-is by `app/transform/transformers/kiro-transformer.ts`
 * (a generic YAML-frontmatter reader, despite this file's own
 * skill-specific name/home — matches the reference's own reuse).
 * @see https://agentskills.io/specification
 * @module domain/skill/validate
 */

import * as yaml from 'js-yaml';
import {
  COLLECTION_ID_PATTERN,
} from '../collection/validate';

export interface SkillMetadata {
  name: string;
  description: string;
  [key: string]: unknown;
}

export interface SkillValidationResult {
  skillName: string;
  folderName: string;
  valid: boolean;
  errors: string[];
}

export interface AllSkillsValidationResult {
  valid: boolean;
  skills: SkillValidationResult[];
  totalSkills: number;
  validSkills: number;
  invalidSkills: number;
}

// Constants
export const SKILL_NAME_MAX_LENGTH = 64;
export const SKILL_DESCRIPTION_MIN_LENGTH = 10;
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;
export const MAX_ASSET_SIZE = 5 * 1024 * 1024; // 5 MB

/**
 * Parse YAML frontmatter from SKILL.md content
 * @param content
 */
export function parseFrontmatter(content: string): SkillMetadata | null {
  const match = /^---\n([\s\S]*?)\n---/.exec(content.replaceAll('\r\n', '\n'));
  if (!match) {
    return null;
  }
  try {
    return yaml.load(match[1]) as SkillMetadata;
  } catch {
    return null;
  }
}

/**
 * Validate SKILL.md content for a skill folder. Pure, so it runs on local files
 * and on content fetched from a source alike.
 * @param folderName Name of the folder that contains SKILL.md.
 * @param content SKILL.md content.
 * @returns Error messages; empty when valid.
 */
export function validateSkillContent(folderName: string, content: string): string[] {
  const metadata = parseFrontmatter(content);
  if (!metadata) {
    return ['Failed to parse SKILL.md frontmatter'];
  }
  const errors: string[] = [];
  const nameError = validateSkillName(metadata.name);
  if (nameError) {
    errors.push(`name: ${nameError}`);
  } else if (metadata.name !== folderName) {
    errors.push(`Folder name "${folderName}" does not match skill name "${metadata.name}"`);
  }
  const descError = validateSkillDescription(metadata.description);
  if (descError) {
    errors.push(`description: ${descError}`);
  }
  return errors;
}

/**
 * Validate skill name format
 * @param name
 */
export function validateSkillName(name: unknown): string | null {
  if (!name || typeof name !== 'string') {
    return 'name is required and must be a string';
  }
  if (!COLLECTION_ID_PATTERN.test(name)) {
    return 'name must contain only lowercase letters, numbers, and hyphens';
  }
  if (name.length > SKILL_NAME_MAX_LENGTH) {
    return `name must not exceed ${SKILL_NAME_MAX_LENGTH} characters`;
  }
  return null;
}

/**
 * Validate skill description
 * @param description
 */
export function validateSkillDescription(description: unknown): string | null {
  if (!description || typeof description !== 'string') {
    return 'description is required and must be a string';
  }
  if (description.length < SKILL_DESCRIPTION_MIN_LENGTH) {
    return `description must be at least ${SKILL_DESCRIPTION_MIN_LENGTH} characters`;
  }
  if (description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
    return `description must not exceed ${SKILL_DESCRIPTION_MAX_LENGTH} characters`;
  }
  return null;
}
