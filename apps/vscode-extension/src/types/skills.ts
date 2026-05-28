/**
 * Type definitions for Anthropic-style Skills repositories
 * Skills are folders with SKILL.md files containing YAML frontmatter and markdown instructions
 */

/**
 * SKILL.md frontmatter structure
 * Required: name, description
 * Optional: license
 */
export interface SkillFrontmatter {
  /** Skill name (lowercase, hyphens for spaces) */
  name: string;

  /** Description of what the skill does and when to use it */
  description: string;

  /** License information (optional) */
  license?: string;

  /** Additional frontmatter fields */
  [key: string]: any;
}

/**
 * Parsed SKILL.md file content
 */
export interface ParsedSkillFile {
  /** Parsed YAML frontmatter */
  frontmatter: SkillFrontmatter;

  /** Markdown content (instructions) */
  content: string;

  /** Raw file content */
  raw: string;
}

/**
 * Information about a discovered skill
 */
export interface SkillItem {
  /** Skill ID (folder name) */
  id: string;

  /** Skill name from frontmatter */
  name: string;

  /** Skill description from frontmatter */
  description: string;

  /** License from frontmatter (optional) */
  license?: string;

  /** Path to the skill folder relative to repository root */
  path: string;

  /** Path to SKILL.md file */
  skillMdPath: string;

  /** List of files in the skill folder */
  files: string[];

  /** Hash representing the skill content (used for versioning) */
  contentHash?: string;

  /** Parsed SKILL.md content */
  parsedSkillMd?: ParsedSkillFile;
}

/**
 * GitHub directory content item (for API responses)
 */
export interface GitHubContentItem {
  name: string;
  path: string;
  type: 'file' | 'dir';
  // eslint-disable-next-line @typescript-eslint/naming-convention -- matches external API response shape
  download_url?: string;
  url?: string;
  sha?: string;
  size?: number;
}
