/**
 * Local Skills source adapter — discovers Anthropic-style skills
 * (`skills/<id>/SKILL.md`) from a local directory instead of a GitHub
 * repository. Useful for authoring and testing skills locally before
 * publishing.
 *
 * Ported from `src/adapters/local-skills-adapter.ts`. Content hashing
 * necessarily differs from the remote `SkillsAdapter`: there's no git
 * blob sha to hash by reference, so this hashes each file's actual
 * content directly (matching `main`'s own local implementation, which
 * already did this correctly - only the remote adapter has git shas to
 * reuse). All disk I/O goes through the injected `FileSystem` port;
 * archive creation uses `archiver`, reading each file as text (matching
 * `LocalAdapter`'s own documented text-only limitation - `FileSystem`
 * has no binary-safe read, so a hash computed here over a binary skill
 * asset's UTF-8-decoded text won't byte-for-byte match one computed by
 * `main`'s raw-`Buffer` read; same accepted limitation, not a new one).
 * Uses the shared `resolveLocalPath`/`isValidLocalUrl` from
 * `./local-path`.
 *
 * Deliberate deviations from `main`:
 * - Dropped the unused `parsedSkillMd`/`raw`/markdown-`content` fields
 *   on `SkillItem`, same as the remote `SkillsAdapter`.
 * - `getSkillSourcePath`/`getSkillName` (ported below) reuse the
 *   already-factored private `skillIdFromBundleId` instead of each
 *   re-deriving the source-name prefix inline, unlike `main`'s three
 *   separate copies of the same `bundle.id.replace(...)` logic.
 * @module adapters/local-skills-adapter
 */
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type {
  Bundle,
  Clock,
  FileSystem,
  RegistrySource,
  SourceMetadata,
  ValidationResult,
} from '@ai-primitives-hub/core';
import archiver from 'archiver';
import * as yaml from 'js-yaml';
import {
  BaseSourceAdapter,
} from './base-source-adapter';
import {
  isValidLocalUrl,
  resolveLocalPath,
} from './local-path';

const SKILL_ENVIRONMENTS = ['claude', 'vscode', 'claude-code'];
const SKILL_TAGS = ['skill', 'anthropic', 'local'];
/** Crude per-file size heuristic, matching the remote `SkillsAdapter`. */
const ESTIMATED_BYTES_PER_FILE = 4096;

interface SkillFrontmatter {
  name?: string;
  description?: string;
  license?: string;
}

interface SkillItem {
  id: string;
  name: string;
  description: string;
  license?: string;
  path: string;
  files: string[];
  contentHash: string;
}

function parseFrontmatter(raw: string): SkillFrontmatter {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n/.exec(raw);
  if (!match) {
    return {};
  }
  try {
    return (yaml.load(match[1]) as SkillFrontmatter | undefined) ?? {};
  } catch {
    return {};
  }
}

function formatSkillVersion(contentHash: string): string {
  return contentHash ? `hash:${contentHash}` : '1.0.0';
}

function estimateSkillSize(fileCount: number): string {
  const estimatedBytes = fileCount * ESTIMATED_BYTES_PER_FILE;
  if (estimatedBytes < 1024) {
    return `${estimatedBytes} B`;
  }
  if (estimatedBytes < 1024 * 1024) {
    return `${(estimatedBytes / 1024).toFixed(1)} KB`;
  }
  return `${(estimatedBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export class LocalSkillsAdapter extends BaseSourceAdapter {
  public readonly type = 'local-skills';

  public constructor(
    source: RegistrySource,
    private readonly fs: FileSystem,
    private readonly clock: Clock
  ) {
    super(source);
    if (!isValidLocalUrl(source.url)) {
      throw new Error(`Invalid local skills path: ${source.url}`);
    }
  }

  private getLocalPath(): string {
    return resolveLocalPath(this.source.url);
  }

  private async directoryExists(dirPath: string): Promise<boolean> {
    if (!(await this.fs.exists(dirPath))) {
      return false;
    }
    return (await this.fs.stat(dirPath)).isDirectory;
  }

  private getSourceName(): string {
    return path.basename(this.getLocalPath());
  }

  private buildBundleId(skillId: string): string {
    return `local-skills-${this.getSourceName()}-${skillId}`;
  }

  private skillIdFromBundleId(bundleId: string): string {
    return bundleId.replace(`local-skills-${this.getSourceName()}-`, '');
  }

  private async calculateContentHash(skillPath: string, files: string[]): Promise<string> {
    const hash = crypto.createHash('sha256');
    for (const file of files.toSorted((a, b) => a.localeCompare(b))) {
      const content = await this.fs.readFile(path.join(skillPath, file));
      hash.update(file).update(':').update(content).update('|');
    }
    return hash.digest('hex');
  }

  private async processSkillDirectory(skillId: string, skillsDir: string): Promise<SkillItem | undefined> {
    const skillPath = path.join(skillsDir, skillId);
    const skillMdPath = path.join(skillPath, 'SKILL.md');
    if (!(await this.fs.exists(skillMdPath))) {
      return undefined;
    }

    try {
      const frontmatter = parseFrontmatter(await this.fs.readFile(skillMdPath));
      const entries = await this.fs.readDirEntries(skillPath);
      const files = entries.filter((entry) => !entry.isDirectory).map((entry) => entry.name);
      const contentHash = await this.calculateContentHash(skillPath, files);

      return {
        id: skillId,
        name: frontmatter.name || skillId,
        description: frontmatter.description || 'No description',
        license: frontmatter.license,
        path: `skills/${skillId}`,
        files,
        contentHash
      };
    } catch {
      return undefined;
    }
  }

  private async scanSkillsDirectory(): Promise<SkillItem[]> {
    const skillsDir = path.join(this.getLocalPath(), 'skills');
    let entries;
    try {
      entries = await this.fs.readDirEntries(skillsDir);
    } catch (error) {
      throw new Error(`Failed to scan skills directory: ${error instanceof Error ? error.message : error}`);
    }

    const skills: SkillItem[] = [];
    for (const entry of entries.filter((item) => item.isDirectory)) {
      const skill = await this.processSkillDirectory(entry.name, skillsDir);
      if (skill) {
        skills.push(skill);
      }
    }
    return skills;
  }

  private createBundleFromSkill(skill: SkillItem): Bundle {
    const bundleId = this.buildBundleId(skill.id);
    return {
      id: bundleId,
      name: skill.name,
      // Content hash drives hash-based versioning for update detection.
      version: formatSkillVersion(skill.contentHash),
      description: skill.description,
      author: 'Local',
      sourceId: this.source.id,
      environments: SKILL_ENVIRONMENTS,
      tags: SKILL_TAGS,
      lastUpdated: this.clock.nowIso(),
      size: estimateSkillSize(skill.files.length),
      dependencies: [],
      license: skill.license || 'Unknown',
      repository: this.source.url,
      homepage: this.source.url,
      manifestUrl: this.getManifestUrl(bundleId),
      downloadUrl: this.getDownloadUrl(bundleId)
    };
  }

  private createDeploymentManifest(skill: SkillItem): Record<string, unknown> {
    return {
      id: this.buildBundleId(skill.id),
      version: formatSkillVersion(skill.contentHash),
      name: skill.name,
      metadata: {
        manifest_version: '1.0',
        description: skill.description,
        author: 'Local',
        last_updated: this.clock.nowIso(),
        repository: {
          type: 'local',
          url: this.source.url,
          directory: skill.path
        },
        license: skill.license || 'Unknown',
        keywords: SKILL_TAGS
      },
      common: {
        directories: [`skills/${skill.id}`],
        files: [],
        include_patterns: ['**/*'],
        exclude_patterns: []
      },
      bundle_settings: {
        include_common_in_environment_bundles: true,
        create_common_bundle: true,
        compression: 'zip',
        naming: {
          common_bundle: skill.id
        }
      },
      prompts: [
        {
          id: skill.id,
          name: skill.name,
          description: skill.description,
          file: 'SKILL.md',
          type: 'skill',
          tags: SKILL_TAGS
        }
      ]
    };
  }

  private async listFilesRecursively(dirPath: string, relativePrefix = ''): Promise<string[]> {
    const entries = await this.fs.readDirEntries(dirPath);
    const results: string[] = [];
    for (const entry of entries) {
      const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        results.push(...(await this.listFilesRecursively(path.join(dirPath, entry.name), relativePath)));
      } else {
        results.push(relativePath);
      }
    }
    return results;
  }

  private async createBundleArchive(skill: SkillItem): Promise<Buffer> {
    const skillPath = path.join(this.getLocalPath(), skill.path);
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks: Buffer[] = [];
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));

    const finished = new Promise<Buffer>((resolve, reject) => {
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      archive.on('error', (err: Error) => reject(new Error(`Failed to create ZIP archive: ${err.message}`)));
    });

    archive.append(yaml.dump(this.createDeploymentManifest(skill)), { name: 'deployment-manifest.yml' });

    for (const relativePath of await this.listFilesRecursively(skillPath)) {
      const content = await this.fs.readFile(path.join(skillPath, relativePath));
      archive.append(content, { name: `skills/${skill.id}/${relativePath}` });
    }

    await archive.finalize();
    return finished;
  }

  public requiresAuthentication(): boolean {
    return false;
  }

  public async fetchBundles(): Promise<Bundle[]> {
    let skills: SkillItem[];
    try {
      skills = await this.scanSkillsDirectory();
    } catch (error) {
      throw new Error(`Failed to fetch local skills: ${error instanceof Error ? error.message : error}`);
    }
    return skills.map((skill) => this.createBundleFromSkill(skill));
  }

  public async downloadBundle(bundle: Bundle): Promise<Buffer> {
    const skillId = this.skillIdFromBundleId(bundle.id);
    try {
      const skills = await this.scanSkillsDirectory();
      const skill = skills.find((item) => item.id === skillId);
      if (!skill) {
        throw new Error(`Skill not found: ${skillId}`);
      }
      return await this.createBundleArchive(skill);
    } catch (error) {
      throw new Error(`Failed to download skill ${skillId}: ${error instanceof Error ? error.message : error}`);
    }
  }

  public async fetchMetadata(): Promise<SourceMetadata> {
    try {
      const localPath = this.getLocalPath();
      const skills = await this.scanSkillsDirectory();
      const stats = await this.fs.stat(localPath);
      return {
        name: path.basename(localPath),
        description: 'Local Skills Repository',
        bundleCount: skills.length,
        lastUpdated: new Date(stats.mtimeMs).toISOString(),
        version: '1.0.0'
      };
    } catch (error) {
      throw new Error(`Failed to fetch local skills metadata: ${error instanceof Error ? error.message : error}`);
    }
  }

  public getManifestUrl(bundleId: string): string {
    const skillId = this.skillIdFromBundleId(bundleId);
    return `file://${path.join(this.getLocalPath(), 'skills', skillId, 'SKILL.md')}`;
  }

  public getDownloadUrl(bundleId: string): string {
    const skillId = this.skillIdFromBundleId(bundleId);
    return `file://${path.join(this.getLocalPath(), 'skills', skillId)}`;
  }

  public async validate(): Promise<ValidationResult> {
    const localPath = this.getLocalPath();
    if (!(await this.directoryExists(localPath))) {
      return { valid: false, errors: [`Directory does not exist: ${localPath}`], warnings: [], bundlesFound: 0 };
    }

    const skillsDir = path.join(localPath, 'skills');
    if (!(await this.directoryExists(skillsDir))) {
      return { valid: false, errors: [`Missing required 'skills' directory: ${skillsDir}`], warnings: [], bundlesFound: 0 };
    }

    const warnings: string[] = [];
    let bundlesFound = 0;
    try {
      bundlesFound = (await this.scanSkillsDirectory()).length;
      if (bundlesFound === 0) {
        warnings.push('No valid skills found in skills/ directory (skills must have SKILL.md file)');
      }
    } catch (error) {
      warnings.push(`Failed to scan skills: ${error instanceof Error ? error.message : error}`);
    }

    return { valid: true, errors: [], warnings, bundlesFound };
  }

  /**
   * Get the original source path for a skill, for symlink creation.
   * Used by an installer to symlink a locally-developed skill instead
   * of copying it.
   * @param bundle
   */
  public getSkillSourcePath(bundle: Bundle): string {
    return path.join(this.getLocalPath(), 'skills', this.skillIdFromBundleId(bundle.id));
  }

  /**
   * Get the skill name/ID from a bundle ID.
   * @param bundle
   */
  public getSkillName(bundle: Bundle): string {
    return this.skillIdFromBundleId(bundle.id);
  }
}
