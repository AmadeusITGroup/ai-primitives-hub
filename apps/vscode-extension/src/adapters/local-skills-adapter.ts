/**
 * Local Skills filesystem adapter
 * Handles local filesystem directories containing Anthropic-style skills with SKILL.md files
 *
 * Directory structure:
 * - skills/ folder at root
 * - Each subfolder is a skill (folder name = skill ID)
 * - Each skill has a SKILL.md file with YAML frontmatter (name, description) and markdown instructions
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  promisify,
} from 'node:util';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- top-level import, cannot use await import
import AdmZip = require('adm-zip');
import * as yaml from 'js-yaml';
import {
  Bundle,
  RegistrySource,
  SourceMetadata,
  ValidationResult,
} from '../types/registry';
import {
  ParsedSkillFile,
  SkillFrontmatter,
  SkillItem,
} from '../types/skills';
import {
  Logger,
} from '../utils/logger';
import {
  RepositoryAdapter,
} from './repository-adapter';

const readdir = promisify(fs.readdir);
const readFile = promisify(fs.readFile);
const stat = promisify(fs.stat);
const access = promisify(fs.access);

/**
 * Local Skills filesystem adapter implementation
 * Expects a directory structure with skills/ subdirectory containing skill folders
 */
export class LocalSkillsAdapter extends RepositoryAdapter {
  public readonly type = 'local-skills';
  private readonly logger: Logger;

  constructor(source: RegistrySource) {
    super(source);
    this.logger = Logger.getInstance();

    if (!this.isValidLocalPath(source.url)) {
      throw new Error(`Invalid local skills path: ${source.url}`);
    }
  }

  /**
   * Get local directory path from file:// URL or direct path
   */
  private getLocalPath(): string {
    let localPath = this.source.url;

    if (localPath.startsWith('file://')) {
      localPath = localPath.substring(7);
    }

    if (localPath.startsWith('~/')) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- sync method cannot use await import
      const os = require('node:os');
      localPath = path.join(os.homedir(), localPath.slice(2));
    }

    return path.normalize(localPath);
  }

  /**
   * Check if path is valid local filesystem path
   * @param url
   */
  private isValidLocalPath(url: string): boolean {
    return url.startsWith('file://')
      || path.isAbsolute(url)
      || url.startsWith('~/')
      || url.startsWith('./');
  }

  /**
   * Check if directory exists and is accessible
   * @param dirPath
   */
  private async directoryExists(dirPath: string): Promise<boolean> {
    try {
      await access(dirPath, fs.constants.R_OK);
      const stats = await stat(dirPath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Validate directory structure for local skills source
   */
  private async validateDirectoryStructure(): Promise<ValidationResult> {
    const localPath = this.getLocalPath();
    const errors: string[] = [];
    const warnings: string[] = [];

    this.logger.debug(`[LocalSkillsAdapter] Validating directory structure: ${localPath}`);

    try {
      await access(localPath, fs.constants.R_OK);
      const stats = await stat(localPath);
      if (!stats.isDirectory()) {
        return {
          valid: false,
          errors: [`Path is not a directory: ${localPath}`],
          warnings: []
        };
      }
    } catch (error) {
      const errorCode = (error as NodeJS.ErrnoException).code;
      let errorMessage = `Directory not accessible: ${localPath}`;

      if (errorCode === 'ENOENT') {
        errorMessage = `Directory does not exist: ${localPath}`;
      } else if (errorCode === 'EACCES') {
        errorMessage = `Permission denied accessing directory: ${localPath}`;
      }

      return {
        valid: false,
        errors: [errorMessage],
        warnings: []
      };
    }

    const skillsPath = path.join(localPath, 'skills');
    if (!(await this.directoryExists(skillsPath))) {
      errors.push(`Missing required 'skills' directory: ${skillsPath}`);
    }

    const isValid = errors.length === 0;

    if (isValid) {
      this.logger.debug(`[LocalSkillsAdapter] Directory structure validation passed`);
    } else {
      this.logger.warn(`[LocalSkillsAdapter] Directory structure validation failed: ${errors.join(', ')}`);
    }

    return {
      valid: isValid,
      errors,
      warnings
    };
  }

  /**
   * Scan skills/ directory for skill folders
   */
  private async scanSkillsDirectory(): Promise<SkillItem[]> {
    const localPath = this.getLocalPath();
    const skillsPath = path.join(localPath, 'skills');

    this.logger.debug(`[LocalSkillsAdapter] Scanning skills directory: ${skillsPath}`);

    try {
      const entries = await readdir(skillsPath, { withFileTypes: true });
      const skills: SkillItem[] = [];

      const directories = entries.filter((entry) => entry.isDirectory());
      this.logger.debug(`[LocalSkillsAdapter] Found ${directories.length} directories in skills/`);

      for (const dir of directories) {
        try {
          const skill = await this.processSkillDirectory(dir.name, skillsPath);
          if (skill) {
            skills.push(skill);
          }
        } catch (error) {
          this.logger.warn(`[LocalSkillsAdapter] Failed to process skill directory ${dir.name}: ${error}`);
        }
      }

      return skills;
    } catch (error) {
      this.logger.error(`[LocalSkillsAdapter] Failed to scan skills directory: ${error}`);
      throw new Error(`Failed to scan skills directory: ${error}`);
    }
  }

  /**
   * Process a skill directory
   * @param skillId
   * @param skillsPath
   */
  private async processSkillDirectory(skillId: string, skillsPath: string): Promise<SkillItem | null> {
    const skillPath = path.join(skillsPath, skillId);
    const skillMdPath = path.join(skillPath, 'SKILL.md');

    this.logger.debug(`[LocalSkillsAdapter] Processing skill directory: ${skillId}`);

    try {
      try {
        await access(skillMdPath, fs.constants.R_OK);
      } catch {
        this.logger.debug(`[LocalSkillsAdapter] Skill ${skillId} missing SKILL.md, skipping`);
        return null;
      }

      const parsedSkillMd = await this.parseSkillMd(skillMdPath);

      const entries = await readdir(skillPath);
      const files = entries.filter((entry) => {
        const entryPath = path.join(skillPath, entry);
        try {
          return fs.statSync(entryPath).isFile();
        } catch {
          return false;
        }
      });
      // Calculate content hash of skill directory
      const contentHash = await this.calculateContentHash(skillPath, files);

      const skillItem: SkillItem = {
        id: skillId,
        name: parsedSkillMd.frontmatter.name || skillId,
        description: parsedSkillMd.frontmatter.description || 'No description',
        license: parsedSkillMd.frontmatter.license,
        path: `skills/${skillId}`,
        skillMdPath: `skills/${skillId}/SKILL.md`,
        files,
        contentHash,
        parsedSkillMd
      };

      this.logger.debug(`[LocalSkillsAdapter] Successfully processed skill: ${skillItem.name}`);
      return skillItem;
    } catch (error) {
      this.logger.error(`[LocalSkillsAdapter] Error processing skill ${skillId}: ${error}`);
      return null;
    }
  }

  /**
   * Parse SKILL.md file
   * @param skillMdPath
   */
  private async parseSkillMd(skillMdPath: string): Promise<ParsedSkillFile> {
    this.logger.debug(`[LocalSkillsAdapter] Parsing SKILL.md: ${skillMdPath}`);

    try {
      const raw = await readFile(skillMdPath, 'utf8');

      const frontmatterMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);

      if (!frontmatterMatch) {
        this.logger.warn(`[LocalSkillsAdapter] SKILL.md missing valid frontmatter`);
        return {
          frontmatter: { name: '', description: '' },
          content: raw,
          raw
        };
      }

      const frontmatterYaml = frontmatterMatch[1];
      const markdownContent = frontmatterMatch[2];

      let frontmatter: SkillFrontmatter;
      try {
        frontmatter = yaml.load(frontmatterYaml) as SkillFrontmatter;
      } catch (yamlError) {
        this.logger.warn(`[LocalSkillsAdapter] Failed to parse YAML frontmatter: ${yamlError}`);
        frontmatter = { name: '', description: '' };
      }

      return {
        frontmatter,
        content: markdownContent,
        raw
      };
    } catch (error) {
      this.logger.error(`[LocalSkillsAdapter] Failed to parse SKILL.md: ${error}`);
      throw error;
    }
  }

  /**
   * Create Bundle from SkillItem
   * @param skill
   */
  private createBundleFromSkill(skill: SkillItem): Bundle {
    const localPath = this.getLocalPath();
    const sourceName = path.basename(localPath);

    const bundleId = `local-skills-${sourceName}-${skill.id}`;

    const bundle: Bundle = {
      id: bundleId,
      name: skill.name,
      // Content hash drives hash-based versioning for update detection.
      version: this.formatSkillVersion(skill.contentHash),
      description: skill.description,
      author: 'Local',
      sourceId: this.source.id,
      environments: ['claude', 'vscode', 'claude-code'],
      tags: ['skill', 'anthropic', 'local'],
      lastUpdated: new Date().toISOString(),
      size: this.estimateSkillSize(skill.files),
      dependencies: [],
      license: skill.license || 'Unknown',
      repository: this.source.url,
      homepage: this.source.url,
      manifestUrl: this.getManifestUrl(bundleId),
      downloadUrl: this.getDownloadUrl(bundleId)
    };

    return bundle;
  }

  /**
   * Calculate a stable hash from skill file contents.
   * @param skillPath
   * @param files
   */
  private async calculateContentHash(skillPath: string, files: string[]): Promise<string> {
    const hash = crypto.createHash('sha256');
    const sortedFiles = files.toSorted((a, b) => a.localeCompare(b));

    for (const file of sortedFiles) {
      const filePath = path.join(skillPath, file);
      const content = await readFile(filePath);
      hash.update(file);
      hash.update(':');
      hash.update(content);
      hash.update('|');
    }

    return hash.digest('hex');
  }

  /**
   * Format skill version from content hash.
   * @param contentHash
   */
  private formatSkillVersion(contentHash?: string): string {
    return contentHash ? `hash:${contentHash}` : '1.0.0';
  }

  /**
   * Estimate skill size
   * @param files
   */
  private estimateSkillSize(files: string[]): string {
    const estimatedBytes = files.length * 4096;

    if (estimatedBytes < 1024) {
      return `${estimatedBytes} B`;
    }
    if (estimatedBytes < 1024 * 1024) {
      return `${(estimatedBytes / 1024).toFixed(1)} KB`;
    }
    return `${(estimatedBytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /**
   * Package skill as ZIP
   * @param skill
   */
  private async packageSkillAsZip(skill: SkillItem): Promise<Buffer> {
    const localPath = this.getLocalPath();
    const skillPath = path.join(localPath, skill.path);

    this.logger.debug(`[LocalSkillsAdapter] Packaging skill as ZIP: ${skill.id}`);

    try {
      const zip = new AdmZip();

      const deploymentManifest = this.generateDeploymentManifest(skill);
      const manifestYaml = yaml.dump(deploymentManifest);
      zip.addFile('deployment-manifest.yml', Buffer.from(manifestYaml, 'utf8'));

      // Use skills/{skill-id}/ structure to match CopilotSyncService expectations
      await this.addDirectoryToZip(zip, skillPath, `skills/${skill.id}`);

      const zipBuffer = zip.toBuffer();
      this.logger.debug(`[LocalSkillsAdapter] Created ZIP bundle: ${zipBuffer.length} bytes`);
      return zipBuffer;
    } catch (error) {
      this.logger.error(`[LocalSkillsAdapter] Failed to package skill ${skill.id}: ${error}`);
      throw new Error(`Failed to package skill as ZIP: ${error}`);
    }
  }

  /**
   * Add directory contents to ZIP recursively
   * @param zip
   * @param dirPath
   * @param zipPath
   */
  private async addDirectoryToZip(zip: AdmZip, dirPath: string, zipPath: string): Promise<void> {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const entryPath = path.join(dirPath, entry.name);
        const entryZipPath = `${zipPath}/${entry.name}`;

        if (entry.isFile()) {
          const content = await readFile(entryPath);
          zip.addFile(entryZipPath, content);
          this.logger.debug(`[LocalSkillsAdapter] Added file to ZIP: ${entryZipPath}`);
        } else if (entry.isDirectory()) {
          await this.addDirectoryToZip(zip, entryPath, entryZipPath);
        }
      }
    } catch (error) {
      this.logger.warn(`[LocalSkillsAdapter] Failed to add directory ${dirPath} to ZIP: ${error}`);
    }
  }

  /**
   * Generate deployment manifest
   * @param skill
   */
  private generateDeploymentManifest(skill: SkillItem): any {
    const localPath = this.getLocalPath();
    const sourceName = path.basename(localPath);

    return {
      id: `local-skills-${sourceName}-${skill.id}`,
      version: this.formatSkillVersion(skill.contentHash),
      name: skill.name,

      metadata: {
        manifest_version: '1.0',
        description: skill.description,
        author: 'Local',
        last_updated: new Date().toISOString(),
        repository: {
          type: 'local',
          url: this.source.url,
          directory: skill.path
        },
        license: skill.license || 'Unknown',
        keywords: ['skill', 'anthropic', 'local']
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
          file: `SKILL.md`,
          type: 'skill',
          tags: ['skill', 'anthropic', 'local']
        }
      ]
    };
  }

  /**
   * Validate local skills source
   */
  public async validate(): Promise<ValidationResult> {
    const warnings: string[] = [];

    try {
      this.logger.info(`[LocalSkillsAdapter] Validating local skills source: ${this.source.url}`);

      const structureValidation = await this.validateDirectoryStructure();
      if (!structureValidation.valid) {
        return structureValidation;
      }

      let skillCount = 0;
      try {
        const skills = await this.scanSkillsDirectory();
        skillCount = skills.length;

        if (skillCount === 0) {
          warnings.push('No valid skills found in skills/ directory (skills must have SKILL.md file)');
        } else {
          this.logger.info(`[LocalSkillsAdapter] Found ${skillCount} valid skill(s)`);
        }
      } catch (scanError) {
        warnings.push(`Failed to scan skills: ${scanError}`);
      }

      return {
        valid: true,
        errors: [],
        warnings,
        bundlesFound: skillCount
      };
    } catch (error) {
      return {
        valid: false,
        errors: [`Local skills source validation failed: ${error}`],
        warnings
      };
    }
  }

  /**
   * Fetch repository metadata
   */
  public async fetchMetadata(): Promise<SourceMetadata> {
    try {
      const localPath = this.getLocalPath();
      const skills = await this.scanSkillsDirectory();
      const stats = await stat(localPath);

      return {
        name: path.basename(localPath),
        description: 'Local Skills Repository',
        bundleCount: skills.length,
        lastUpdated: stats.mtime.toISOString(),
        version: '1.0.0'
      };
    } catch (error) {
      throw new Error(`Failed to fetch local skills metadata: ${error}`);
    }
  }

  /**
   * Fetch all skills as bundles
   */
  public async fetchBundles(): Promise<Bundle[]> {
    this.logger.info(`[LocalSkillsAdapter] Fetching skills from: ${this.source.url}`);

    try {
      const skills = await this.scanSkillsDirectory();
      this.logger.info(`[LocalSkillsAdapter] Found ${skills.length} skills`);

      const bundles: Bundle[] = [];
      for (const skill of skills) {
        try {
          const bundle = this.createBundleFromSkill(skill);
          bundles.push(bundle);
          this.logger.debug(`[LocalSkillsAdapter] Created bundle: ${bundle.id}`);
        } catch (error) {
          this.logger.warn(`[LocalSkillsAdapter] Failed to create bundle from skill ${skill.id}: ${error}`);
        }
      }

      this.logger.info(`[LocalSkillsAdapter] Successfully created ${bundles.length} bundles`);
      return bundles;
    } catch (error) {
      this.logger.error(`[LocalSkillsAdapter] Failed to fetch skills: ${error}`);
      throw new Error(`Failed to fetch local skills: ${error}`);
    }
  }

  /**
   * Get manifest URL
   * @param bundleId
   * @param _version
   */
  public getManifestUrl(bundleId: string, _version?: string): string {
    const localPath = this.getLocalPath();
    const sourceName = path.basename(localPath);
    const skillId = bundleId.replace(`local-skills-${sourceName}-`, '');
    return `file://${path.join(localPath, 'skills', skillId, 'SKILL.md')}`;
  }

  /**
   * Get download URL
   * @param bundleId
   * @param _version
   */
  public getDownloadUrl(bundleId: string, _version?: string): string {
    const localPath = this.getLocalPath();
    const sourceName = path.basename(localPath);
    const skillId = bundleId.replace(`local-skills-${sourceName}-`, '');
    return `file://${path.join(localPath, 'skills', skillId)}`;
  }

  /**
   * Download a skill bundle
   * @param bundle
   */
  public async downloadBundle(bundle: Bundle): Promise<Buffer> {
    const localPath = this.getLocalPath();
    const sourceName = path.basename(localPath);
    const skillId = bundle.id.replace(`local-skills-${sourceName}-`, '');

    this.logger.info(`[LocalSkillsAdapter] Downloading skill: ${skillId}`);

    try {
      const skills = await this.scanSkillsDirectory();
      const skill = skills.find((s) => s.id === skillId);

      if (!skill) {
        throw new Error(`Skill not found: ${skillId}`);
      }

      const zipBuffer = await this.packageSkillAsZip(skill);

      this.logger.info(`[LocalSkillsAdapter] Successfully packaged skill ${skillId} (${zipBuffer.length} bytes)`);
      return zipBuffer;
    } catch (error) {
      this.logger.error(`[LocalSkillsAdapter] Failed to download skill ${skillId}: ${error}`);
      throw new Error(`Failed to download skill ${skillId}: ${error}`);
    }
  }

  /**
   * Get the original source path for a skill (for symlink creation)
   * This is used by BundleInstaller to create symlinks instead of copying for local skills
   * @param bundle The bundle to get the source path for
   * @returns The absolute path to the skill directory
   */
  public getSkillSourcePath(bundle: Bundle): string {
    const localPath = this.getLocalPath();
    const sourceName = path.basename(localPath);
    const skillId = bundle.id.replace(`local-skills-${sourceName}-`, '');
    return path.join(localPath, 'skills', skillId);
  }

  /**
   * Get the skill name from a bundle ID
   * @param bundle The bundle to extract skill name from
   * @returns The skill name/ID
   */
  public getSkillName(bundle: Bundle): string {
    const localPath = this.getLocalPath();
    const sourceName = path.basename(localPath);
    return bundle.id.replace(`local-skills-${sourceName}-`, '');
  }
}
