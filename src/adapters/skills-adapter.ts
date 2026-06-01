/**
 * Skills repository adapter
 * Handles GitHub repositories containing Anthropic-style skills with SKILL.md files
 *
 * Repository structure:
 * - skills/ folder at root
 * - Each subfolder is a skill (folder name = skill ID)
 * - Each skill has a SKILL.md file with YAML frontmatter (name, description) and markdown instructions
 */

import {
  GitHubClient,
  GitHubContentItem,
} from '../services/github-client';
import {
  GitHubNotFoundError,
} from '../services/github-client-errors';
import {
  Bundle,
  RegistrySource,
  SourceMetadata,
  ValidationResult,
} from '../types/registry';
import type {
  SkillItem,
} from '../types/skills';
import {
  Logger,
} from '../utils/logger';
import {
  calculateContentHash,
  formatSkillVersion,
  mapSkillToBundle,
  parseSkillMd,
} from './helpers/skill-parser';
import {
  RepositoryAdapter,
} from './repository-adapter';

const CONCURRENCY_LIMIT = 5;

/**
 * Skills adapter implementation for GitHub repositories
 * Discovers skills from skills/ directory with SKILL.md files
 */
export class SkillsAdapter extends RepositoryAdapter {
  public readonly type = 'skills';
  private readonly logger: Logger;
  private readonly client: GitHubClient;

  constructor(source: RegistrySource, client?: GitHubClient) {
    super(source);
    this.logger = Logger.getInstance();

    // Validates GitHub URL (throws on invalid)
    this.client = client ?? new GitHubClient({
      sourceUrl: source.url,
      explicitToken: source.token
    });
  }

  // ─── Private helpers ──────────────────────────────────────────────────

  /**
   * Scan skills/ directory for skill folders with SKILL.md files
   */
  private async scanSkillsDirectory(): Promise<SkillItem[]> {
    this.logger.debug(`[SkillsAdapter] Scanning skills directory`);

    try {
      const contents = await this.client.getContents('skills');
      const directories = contents.filter((item) => item.type === 'dir');
      this.logger.debug(`[SkillsAdapter] Found ${directories.length} directories in skills/`);

      const skills: SkillItem[] = [];

      for (let i = 0; i < directories.length; i += CONCURRENCY_LIMIT) {
        const chunk = directories.slice(i, i + CONCURRENCY_LIMIT);
        const chunkResults = await Promise.all(chunk.map(async (dir) => {
          try {
            return await this.processSkillDirectory(dir);
          } catch (error) {
            this.logger.warn(`[SkillsAdapter] Failed to process skill directory ${dir.name}: ${error}`);
            return null;
          }
        }));

        for (const skill of chunkResults) {
          if (skill) {
            skills.push(skill);
          }
        }
      }

      return skills;
    } catch (error) {
      this.logger.error(`[SkillsAdapter] Failed to scan skills directory: ${error}`);
      throw new Error(`Failed to scan skills directory: ${error}`);
    }
  }

  /**
   * Process a single skill directory
   * @param dir
   */
  private async processSkillDirectory(dir: GitHubContentItem): Promise<SkillItem | null> {
    const skillId = dir.name;
    const skillPath = dir.path;

    this.logger.debug(`[SkillsAdapter] Processing skill directory: ${skillId}`);

    try {
      const skillContents = await this.client.getContents(skillPath);

      const skillMdFile = skillContents.find((file) =>
        file.name === 'SKILL.md' && file.type === 'file'
      );

      if (!skillMdFile) {
        this.logger.debug(`[SkillsAdapter] Skill ${skillId} missing SKILL.md, skipping`);
        return null;
      }

      // Parse SKILL.md content
      const fileBuffer = await this.client.getFileContent(`${skillPath}/SKILL.md`);
      const parsedSkillMd = parseSkillMd(fileBuffer.toString('utf8'));

      // Collect all files recursively for hashing
      const allFiles = await this.collectSkillFiles(skillContents);

      const files = allFiles.map((item) => this.getRelativeSkillPath(item.path, skillPath));
      const contentHash = calculateContentHash(allFiles);

      return {
        id: skillId,
        name: parsedSkillMd.frontmatter.name || skillId,
        description: parsedSkillMd.frontmatter.description || 'No description',
        license: parsedSkillMd.frontmatter.license,
        path: skillPath,
        skillMdPath: `${skillPath}/SKILL.md`,
        files,
        contentHash,
        parsedSkillMd
      };
    } catch (error) {
      this.logger.error(`[SkillsAdapter] Error processing skill ${skillId}: ${error}`);
      return null;
    }
  }

  /**
   * Recursively collect all files within a skill directory
   * @param initialEntries
   */
  private async collectSkillFiles(initialEntries: GitHubContentItem[]): Promise<GitHubContentItem[]> {
    const files: GitHubContentItem[] = [];
    const queue: GitHubContentItem[] = [...initialEntries];

    while (queue.length > 0) {
      const entry = queue.shift()!;
      if (entry.type === 'file') {
        files.push(entry);
      } else if (entry.type === 'dir') {
        try {
          const nestedEntries = await this.client.getContents(entry.path);
          queue.push(...nestedEntries);
        } catch (error) {
          this.logger.warn(`[SkillsAdapter] Failed to read nested directory ${entry.path}: ${error}`);
        }
      }
    }

    return files;
  }

  /**
   * Fetch a single skill by ID (optimized - doesn't scan all skills)
   * @param skillId
   */
  private async fetchSingleSkill(skillId: string): Promise<SkillItem | null> {
    const skillPath = `skills/${skillId}`;
    this.logger.debug(`[SkillsAdapter] Fetching single skill: ${skillId}`);

    try {
      const skillContents = await this.client.getContents(skillPath);

      const skillMdFile = skillContents.find((item) =>
        item.type === 'file' && item.name === 'SKILL.md'
      );

      if (!skillMdFile) {
        this.logger.warn(`[SkillsAdapter] No SKILL.md found for skill: ${skillId}`);
        return null;
      }

      const fileBuffer = await this.client.getFileContent(`${skillPath}/SKILL.md`);
      const parsedSkill = parseSkillMd(fileBuffer.toString('utf8'));

      const allFiles = await this.collectSkillFiles(skillContents);
      const files = allFiles.map((item) => this.getRelativeSkillPath(item.path, skillPath));
      const contentHash = calculateContentHash(allFiles);

      return {
        id: skillId,
        name: parsedSkill.frontmatter.name || skillId,
        description: parsedSkill.frontmatter.description || '',
        path: skillPath,
        skillMdPath: `${skillPath}/SKILL.md`,
        files,
        contentHash,
        license: parsedSkill.frontmatter.license
      };
    } catch (error) {
      this.logger.error(`[SkillsAdapter] Failed to fetch skill ${skillId}: ${error}`);
      return null;
    }
  }

  /**
   * Package a skill as a ZIP bundle
   * @param skill
   */
  private async packageSkillAsZip(skill: SkillItem): Promise<Buffer> {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- matches library export name
    const { default: AdmZip } = await import('adm-zip');
    const { default: yamlLib } = await import('js-yaml');

    this.logger.debug(`[SkillsAdapter] Packaging skill as ZIP: ${skill.id}`);

    try {
      const zip = new AdmZip();

      const deploymentManifest = this.generateDeploymentManifest(skill);
      const manifestYaml = yamlLib.dump(deploymentManifest);
      zip.addFile('deployment-manifest.yml', Buffer.from(manifestYaml, 'utf8'));

      const skillContents = await this.client.getContents(skill.path);

      for (const item of skillContents) {
        if (item.type === 'file') {
          try {
            const fileContent = await this.client.getFileContent(`${skill.path}/${item.name}`);
            const filePath = `skills/${skill.id}/${item.name}`;
            zip.addFile(filePath, fileContent);
            this.logger.debug(`[SkillsAdapter] Added file to ZIP: ${filePath}`);
          } catch (error) {
            this.logger.warn(`[SkillsAdapter] Failed to download file ${item.name}: ${error}`);
          }
        } else if (item.type === 'dir') {
          await this.addDirectoryToZip(zip, item.path, `skills/${skill.id}/${item.name}`);
        }
      }

      const zipBuffer = zip.toBuffer();
      this.logger.debug(`[SkillsAdapter] Created ZIP bundle: ${zipBuffer.length} bytes`);
      return zipBuffer;
    } catch (error) {
      this.logger.error(`[SkillsAdapter] Failed to package skill ${skill.id}: ${error}`);
      throw new Error(`Failed to package skill as ZIP: ${error}`);
    }
  }

  /**
   * Recursively add directory contents to ZIP
   * @param zip
   * @param dirPath
   * @param zipPath
   */
  private async addDirectoryToZip(zip: any, dirPath: string, zipPath: string): Promise<void> {
    try {
      const dirContents = await this.client.getContents(dirPath);

      for (const item of dirContents) {
        if (item.type === 'file') {
          try {
            const fileContent = await this.client.getFileContent(item.path);
            const filePath = `${zipPath}/${item.name}`;
            zip.addFile(filePath, fileContent);
          } catch (error) {
            this.logger.warn(`[SkillsAdapter] Failed to download nested file ${item.name}: ${error}`);
          }
        } else if (item.type === 'dir') {
          await this.addDirectoryToZip(zip, item.path, `${zipPath}/${item.name}`);
        }
      }
    } catch (error) {
      this.logger.warn(`[SkillsAdapter] Failed to add directory ${dirPath} to ZIP: ${error}`);
    }
  }

  /**
   * Generate deployment manifest for a skill
   * @param skill
   */
  private generateDeploymentManifest(skill: SkillItem): any {
    return {
      id: `skills-${this.client.owner}-${this.client.repo}-${skill.id}`,
      version: formatSkillVersion(skill.contentHash || ''),
      name: skill.name,

      metadata: {
        manifest_version: '1.0',
        description: skill.description,
        author: this.client.owner,
        last_updated: new Date().toISOString(),
        repository: {
          type: 'git',
          url: this.source.url,
          directory: skill.path
        },
        license: skill.license || 'Unknown',
        keywords: ['skill', 'anthropic']
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
          file: `skills/${skill.id}/SKILL.md`,
          type: 'skill',
          tags: ['skill', 'anthropic']
        }
      ]
    };
  }

  private getRelativeSkillPath(fullPath: string, skillPath: string): string {
    if (fullPath.startsWith(`${skillPath}/`)) {
      return fullPath.slice(skillPath.length + 1);
    }
    if (fullPath === skillPath) {
      return fullPath.split('/').pop() ?? fullPath;
    }
    return fullPath;
  }

  /**
   * Fetch all skills from the repository as bundles
   */
  public async fetchBundles(): Promise<Bundle[]> {
    this.logger.info(`[SkillsAdapter] Fetching skills from repository: ${this.source.url}`);

    try {
      const skills = await this.scanSkillsDirectory();
      this.logger.info(`[SkillsAdapter] Found ${skills.length} skills in repository`);

      const bundles: Bundle[] = [];
      for (const skill of skills) {
        try {
          const bundle = mapSkillToBundle(
            skill,
            this.client.owner,
            this.client.repo,
            this.source.id,
            this.source.url
          );
          bundles.push(bundle);
          this.logger.debug(`[SkillsAdapter] Created bundle: ${bundle.id}`);
        } catch (error) {
          this.logger.warn(`[SkillsAdapter] Failed to create bundle from skill ${skill.id}: ${error}`);
        }
      }

      this.logger.info(`[SkillsAdapter] Successfully created ${bundles.length} bundles`);
      return bundles;
    } catch (error) {
      this.logger.error(`[SkillsAdapter] Failed to fetch skills: ${error}`);
      throw new Error(`Failed to fetch skills: ${error}`);
    }
  }

  /**
   * Download a skill bundle
   * Creates a ZIP with the skill folder and deployment manifest
   * @param bundle
   */
  public async downloadBundle(bundle: Bundle): Promise<Buffer> {
    const skillId = bundle.id.replace(`skills-${this.client.owner}-${this.client.repo}-`, '');

    this.logger.info(`[SkillsAdapter] Downloading skill: ${skillId}`);

    try {
      const skill = await this.fetchSingleSkill(skillId);
      if (!skill) {
        throw new Error(`Skill not found: ${skillId}`);
      }

      const zipBuffer = await this.packageSkillAsZip(skill);
      this.logger.info(`[SkillsAdapter] Successfully packaged skill ${skillId} (${zipBuffer.length} bytes)`);
      return zipBuffer;
    } catch (error) {
      this.logger.error(`[SkillsAdapter] Failed to download skill ${skillId}: ${error}`);
      throw new Error(`Failed to download skill ${skillId}: ${error}`);
    }
  }

  /**
   * Fetch repository metadata
   */
  public async fetchMetadata(): Promise<SourceMetadata> {
    try {
      const skills = await this.scanSkillsDirectory();
      return {
        name: `${this.client.owner}/${this.client.repo}`,
        description: 'Skills Repository',
        bundleCount: skills.length,
        lastUpdated: new Date().toISOString(),
        version: '1.0.0'
      };
    } catch (error) {
      throw new Error(`Failed to fetch skills repository metadata: ${error}`);
    }
  }

  /**
   * Validate skills repository structure
   */
  public async validate(): Promise<ValidationResult> {
    this.logger.info(`[SkillsAdapter] Validating skills repository: ${this.source.url}`);

    const warnings: string[] = [];

    try {
      // Check repo accessible
      await this.client.getRepository();

      // Check skills/ dir exists
      try {
        await this.client.getContents('skills');
      } catch (error) {
        if (error instanceof GitHubNotFoundError) {
          return {
            valid: false,
            errors: [`Missing required 'skills' directory at repository root`],
            warnings: [],
            bundlesFound: 0
          };
        }
        return {
          valid: false,
          errors: [`Failed to access skills directory: ${error}`],
          warnings: [],
          bundlesFound: 0
        };
      }

      // Scan skills for count
      let skillCount = 0;
      try {
        const skills = await this.scanSkillsDirectory();
        skillCount = skills.length;

        if (skillCount === 0) {
          warnings.push('No valid skills found in skills/ directory (skills must have SKILL.md file)');
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
        errors: [`Skills repository validation failed: ${error}`],
        warnings: [],
        bundlesFound: 0
      };
    }
  }

  /**
   * Get manifest URL for a skill
   * @param bundleId
   * @param _version
   */
  public getManifestUrl(bundleId: string, _version?: string): string {
    const skillId = bundleId.replace(`skills-${this.client.owner}-${this.client.repo}-`, '');
    return `https://raw.githubusercontent.com/${this.client.owner}/${this.client.repo}/main/skills/${skillId}/SKILL.md`;
  }

  /**
   * Get download URL for a skill
   * @param _bundleId
   * @param _version
   */
  public getDownloadUrl(_bundleId: string, _version?: string): string {
    return `https://github.com/${this.client.owner}/${this.client.repo}/archive/refs/heads/main.zip`;
  }
}
