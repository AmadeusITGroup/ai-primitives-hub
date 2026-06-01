import * as crypto from 'node:crypto';
import * as yaml from 'js-yaml';
import type {
  Bundle,
} from '../../types/registry';
import type {
  ParsedSkillFile,
  SkillFrontmatter,
  SkillItem,
} from '../../types/skills';

/**
 * Parses a skill .md file with YAML frontmatter into structured parts.
 * @param content - Raw markdown content with optional YAML frontmatter
 */
export function parseSkillMd(content: string): ParsedSkillFile {
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!frontmatterMatch) {
    return { frontmatter: { name: '', description: '' }, content, raw: content };
  }
  const frontmatterYaml = frontmatterMatch[1];
  const markdownContent = frontmatterMatch[2];
  let frontmatter: SkillFrontmatter;
  try {
    frontmatter = yaml.load(frontmatterYaml) as SkillFrontmatter;
  } catch {
    frontmatter = { name: '', description: '' };
  }
  return { frontmatter, content: markdownContent, raw: content };
}

/**
 * Computes a deterministic SHA-256 hash from file paths and their SHAs.
 * @param files - Array of file entries with path and optional sha/download_url
 */
// eslint-disable-next-line @typescript-eslint/naming-convention -- mirrors GitHub API JSON field names
export function calculateContentHash(files: { path: string; sha?: string; download_url?: string }[]): string {
  const hash = crypto.createHash('sha256');
  const sorted = [...files].toSorted((a, b) => a.path.localeCompare(b.path));
  for (const file of sorted) {
    hash.update(file.path);
    hash.update(':');
    hash.update(file.sha ?? file.download_url ?? '');
    hash.update('|');
  }
  return hash.digest('hex');
}

/**
 * Formats a content hash as a version string for VersionManager compatibility.
 * @param contentHash - SHA-256 hex digest of skill contents
 */
export function formatSkillVersion(contentHash: string): string {
  return contentHash ? `hash:${contentHash}` : '1.0.0';
}

/**
 * Maps a SkillItem to a Bundle for registry display.
 * @param skill - Parsed skill item
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param sourceId - Registry source identifier
 * @param sourceUrl - Source repository URL
 */
export function mapSkillToBundle(skill: SkillItem, owner: string, repo: string, sourceId: string, sourceUrl: string): Bundle {
  const bundleId = `skills-${owner}-${repo}-${skill.id}`;
  return {
    id: bundleId,
    name: skill.name,
    version: formatSkillVersion(skill.contentHash || ''),
    description: skill.description,
    author: owner,
    sourceId,
    environments: ['claude', 'vscode', 'claude-code'],
    tags: ['skill', 'anthropic'],
    lastUpdated: new Date().toISOString(),
    size: `${skill.files.length} files`,
    dependencies: [],
    license: skill.license || 'Unknown',
    repository: sourceUrl,
    homepage: `https://github.com/${owner}/${repo}/tree/main/${skill.path}`,
    manifestUrl: `https://api.github.com/repos/${owner}/${repo}/contents/${skill.skillMdPath}`,
    downloadUrl: `https://github.com/${owner}/${repo}/archive/refs/heads/main.zip`
  };
}
