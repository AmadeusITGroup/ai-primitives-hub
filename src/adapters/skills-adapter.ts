/**
 * Skills repository adapter
 * Handles GitHub repositories containing Anthropic-style skills with SKILL.md files
 *
 * Repository structure:
 * - skills/ folder at root
 * - Each subfolder is a skill (folder name = skill ID)
 * - Each skill has a SKILL.md file with YAML frontmatter (name, description) and markdown instructions
 */

import * as crypto from 'node:crypto';
import * as yaml from 'js-yaml';
import {
  Bundle,
  SourceMetadata,
  ValidationResult,
} from '../types/registry';
import {
  GitHubContentItem,
  ParsedSkillFile,
  SkillFrontmatter,
  SkillItem,
} from '../types/skills';
import {
  GitHubBackedAdapter,
} from './github-backed-adapter';

/**
 * A single entry from the GitHub Git Trees API (recursive listing).
 */
type GitTreeEntry = { path: string; type: string; sha: string };

/**
 * A pre-computed work list for building skills: the resolved repo coordinates plus the
 * discovered skill ids and their tree blobs, ready to fan out through `processInChunks`.
 */
interface SkillWorkList {
  owner: string;
  repo: string;
  branch: string;
  ids: string[];
  filesBySkill: Map<string, GitTreeEntry[]>;
}

/**
 * Skills adapter implementation for GitHub repositories
 * Discovers skills from skills/ directory with SKILL.md files
 */
export class SkillsAdapter extends GitHubBackedAdapter {
  public readonly type = 'skills';
  private readonly defaultBranch = 'main';

  private collectSkillIds(tree: GitTreeEntry[]): Set<string> {
    const skillIds = new Set<string>();
    for (const entry of tree) {
      if (entry.type !== 'blob') {
        continue;
      }
      const segments = entry.path.split('/');
      if (segments[0] === 'skills' && segments.length === 3 && segments[2] === 'SKILL.md') {
        skillIds.add(segments[1]);
      }
    }
    return skillIds;
  }

  private async fetchRepoTree(owner: string, repo: string, branch: string): Promise<GitTreeEntry[]> {
    const url = `${this.apiBase}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
    this.logger.debug(`[SkillsAdapter] Fetching repo tree: ${url}`);
    const result = await this.getJson<{ tree?: GitTreeEntry[]; truncated?: boolean }>(url);
    if (!Array.isArray(result.tree)) {
      throw new Error(`Unexpected response from Git Trees API for ${owner}/${repo}: missing tree array`);
    }
    if (result.truncated) {
      this.logger.warn(`[SkillsAdapter] Git tree for ${owner}/${repo} is truncated; proceeding with partial results`);
    }
    return result.tree;
  }

  /**
   * Build a SkillItem for a single skill from its pre-filtered tree blobs.
   * @param owner
   * @param repo
   * @param branch
   * @param skillId
   * @param entries
   */
  private async buildSkillFromTree(
    owner: string,
    repo: string,
    branch: string,
    skillId: string,
    entries: GitTreeEntry[]
  ): Promise<SkillItem | null> {
    const skillPath = `skills/${skillId}`;
    const rawSkillMdUrl = this.buildRawUrl(owner, repo, branch, `${skillPath}/SKILL.md`);

    try {
      const parsedSkillMd = await this.parseSkillMd(rawSkillMdUrl);
      const files = entries.map((entry) => this.getRelativeSkillPath(entry.path, skillPath));
      const contentHash = this.calculateContentHash(entries);

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
      this.logger.error(`[SkillsAdapter] Error building skill ${skillId} from tree: ${error}`);
      return null;
    }
  }

  /**
   * Produce the work list for a skills scan via a single Git Trees API call: resolve the
   * repo coordinates, group all blobs under skills/<id>/, and collect the valid skill ids.
   * The actual per-skill building is fanned out by the caller so it can stream partials.
   */
  private async collectSkillWorkList(): Promise<SkillWorkList> {
    const { owner, repo } = this.parseGitHubUrl();
    const branch = this.defaultBranch;

    this.logger.debug(`[SkillsAdapter] Scanning skills via git tree: ${owner}/${repo}@${branch}`);

    const tree = await this.fetchRepoTree(owner, repo, branch);

    // Single O(tree) pass: group all blobs under skills/<id>/. A skill id
    // requires a top-level SKILL.md — collectSkillIds is the single source of
    // truth for that rule (also used by validate()/fetchMetadata()).
    const filesBySkill = new Map<string, GitTreeEntry[]>();
    for (const entry of tree) {
      if (entry.type !== 'blob') {
        continue;
      }
      const segments = entry.path.split('/');
      if (segments[0] !== 'skills' || segments.length < 3) {
        continue;
      }
      const skillId = segments[1];
      if (!filesBySkill.has(skillId)) {
        filesBySkill.set(skillId, []);
      }
      filesBySkill.get(skillId)!.push(entry);
    }
    const ids = [...this.collectSkillIds(tree)];

    this.logger.debug(`[SkillsAdapter] Found ${ids.length} skills in tree`);

    return { owner, repo, branch, ids, filesBySkill };
  }

  /**
   * Parse SKILL.md file content (YAML frontmatter + markdown)
   * @param downloadUrl
   */
  private async parseSkillMd(downloadUrl: string): Promise<ParsedSkillFile> {
    this.logger.debug(`[SkillsAdapter] Parsing SKILL.md from: ${downloadUrl}`);

    try {
      const raw = await this.getText(downloadUrl);

      const frontmatterMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);

      if (!frontmatterMatch) {
        this.logger.warn(`[SkillsAdapter] SKILL.md missing valid frontmatter`);
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
        this.logger.warn(`[SkillsAdapter] Failed to parse YAML frontmatter: ${yamlError}`);
        frontmatter = { name: '', description: '' };
      }

      return {
        frontmatter,
        content: markdownContent,
        raw
      };
    } catch (error) {
      this.logger.error(`[SkillsAdapter] Failed to parse SKILL.md: ${error}`);
      throw error;
    }
  }

  /**
   * Create Bundle object from SkillItem
   * @param skill
   */
  private createBundleFromSkill(skill: SkillItem): Bundle {
    const { owner, repo } = this.parseGitHubUrl();

    const bundleId = `skills-${owner}-${repo}-${skill.id}`;

    const bundle: Bundle = {
      id: bundleId,
      name: skill.name,
      // Manifest version must match bundle version for install/update validation.
      version: this.formatSkillVersion(skill.contentHash),
      description: skill.description,
      author: owner,
      sourceId: this.source.id,
      environments: ['claude', 'vscode', 'claude-code'],
      tags: ['skill', 'anthropic'],
      lastUpdated: new Date().toISOString(),
      size: this.estimateSkillSize(skill.files),
      dependencies: [],
      license: skill.license || 'Unknown',
      repository: this.source.url,
      homepage: `https://github.com/${owner}/${repo}/tree/main/${skill.path}`,
      manifestUrl: this.getManifestUrl(bundleId),
      downloadUrl: this.getDownloadUrl(bundleId)
    };

    return bundle;
  }

  /**
   * Calculate a stable hash from GitHub file metadata in the skill folder.
   * @param skillContents
   */
  private calculateContentHash(skillContents: (GitHubContentItem | GitTreeEntry)[]): string {
    const hash = crypto.createHash('sha256');
    const files = skillContents
      .filter((item) => item.type === 'file' || item.type === 'blob')
      .toSorted((a, b) => a.path.localeCompare(b.path));

    for (const file of files) {
      hash.update(file.path);
      hash.update(':');
      hash.update(file.sha ?? ('download_url' in file ? file.download_url : undefined) ?? '');
      hash.update('|');
    }

    return hash.digest('hex');
  }

  /**
   * Recursively collect all files within a skill directory for hashing/versioning.
   * @param owner
   * @param repo
   * @param initialEntries
   */
  private async collectSkillFiles(owner: string, repo: string, initialEntries: GitHubContentItem[]): Promise<GitHubContentItem[]> {
    const files: GitHubContentItem[] = [];
    const queue: GitHubContentItem[] = [...initialEntries];

    while (queue.length > 0) {
      const entry = queue.shift()!;

      if (entry.type === 'file') {
        files.push(entry);
        continue;
      }

      if (entry.type === 'dir') {
        try {
          const nestedEntries = await this.getJson<GitHubContentItem[]>(
            this.buildContentsUrl(owner, repo, entry.path)
          );
          queue.push(...nestedEntries);
        } catch (error) {
          this.logger.warn(`[SkillsAdapter] Failed to read nested directory ${entry.path}: ${error}`);
        }
      }
    }

    return files;
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
   * Format skill version from content hash.
   * @param contentHash
   */
  private formatSkillVersion(contentHash?: string): string {
    return contentHash ? `hash:${contentHash}` : '1.0.0';
  }

  /**
   * Estimate skill size based on file count
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
   * Fetch a single skill by ID (optimized - doesn't scan all skills)
   * @param skillId
   */
  private async fetchSingleSkill(skillId: string): Promise<SkillItem | null> {
    const { owner, repo } = this.parseGitHubUrl();
    const skillPath = `skills/${skillId}`;

    this.logger.debug(`[SkillsAdapter] Fetching single skill: ${skillId}`);

    try {
      // Get skill directory contents
      const skillContents = await this.getJson<GitHubContentItem[]>(
        this.buildContentsUrl(owner, repo, skillPath)
      );

      // Find SKILL.md
      const skillMdFile = skillContents.find((item) =>
        item.type === 'file' && item.name === 'SKILL.md'
      );

      if (!skillMdFile || !skillMdFile.download_url) {
        this.logger.warn(`[SkillsAdapter] No SKILL.md found for skill: ${skillId}`);
        return null;
      }

      // Parse SKILL.md
      const parsedSkill = await this.parseSkillMd(skillMdFile.download_url);
      if (!parsedSkill) {
        return null;
      }

      // Get file list
      const allFiles = await this.collectSkillFiles(owner, repo, skillContents);

      const files = allFiles.map((item) => this.getRelativeSkillPath(item.path, skillPath));

      // Keep download/install versions aligned with listings.
      const contentHash = this.calculateContentHash(allFiles);

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
    const { owner, repo } = this.parseGitHubUrl();
    // eslint-disable-next-line @typescript-eslint/naming-convention -- matches library export name
    const { default: AdmZip } = await import('adm-zip');
    const { default: yamlLib } = await import('js-yaml');

    this.logger.debug(`[SkillsAdapter] Packaging skill as ZIP: ${skill.id}`);

    try {
      const zip = new AdmZip();

      const deploymentManifest = this.generateDeploymentManifest(skill, owner, repo);
      const manifestYaml = yamlLib.dump(deploymentManifest);
      zip.addFile('deployment-manifest.yml', Buffer.from(manifestYaml, 'utf8'));

      const skillContents = await this.getJson<GitHubContentItem[]>(
        this.buildContentsUrl(owner, repo, skill.path)
      );

      // Use skills/{skill-id}/ structure to match CopilotSyncService expectations
      for (const item of skillContents) {
        if (item.type === 'file' && item.download_url) {
          try {
            const fileContent = await this.getBuffer(item.download_url);
            const filePath = `skills/${skill.id}/${item.name}`;
            zip.addFile(filePath, fileContent);

            this.logger.debug(`[SkillsAdapter] Added file to ZIP: ${filePath}`);
          } catch (error) {
            this.logger.warn(`[SkillsAdapter] Failed to download file ${item.name}: ${error}`);
          }
        } else if (item.type === 'dir') {
          await this.addDirectoryToZip(zip, owner, repo, item.path, `skills/${skill.id}/${item.name}`);
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
   * @param owner
   * @param repo
   * @param dirPath
   * @param zipPath
   */
  private async addDirectoryToZip(zip: any, owner: string, repo: string, dirPath: string, zipPath: string): Promise<void> {
    try {
      const dirContents = await this.getJson<GitHubContentItem[]>(
        this.buildContentsUrl(owner, repo, dirPath)
      );

      for (const item of dirContents) {
        if (item.type === 'file' && item.download_url) {
          try {
            const fileContent = await this.getBuffer(item.download_url);
            const filePath = `${zipPath}/${item.name}`;
            zip.addFile(filePath, fileContent);
          } catch (error) {
            this.logger.warn(`[SkillsAdapter] Failed to download nested file ${item.name}: ${error}`);
          }
        } else if (item.type === 'dir') {
          await this.addDirectoryToZip(zip, owner, repo, item.path, `${zipPath}/${item.name}`);
        }
      }
    } catch (error) {
      this.logger.warn(`[SkillsAdapter] Failed to add directory ${dirPath} to ZIP: ${error}`);
    }
  }

  /**
   * Generate deployment manifest for a skill
   * @param skill
   * @param owner
   * @param repo
   */
  private generateDeploymentManifest(skill: SkillItem, owner: string, repo: string): any {
    return {
      id: `skills-${owner}-${repo}-${skill.id}`,
      version: this.formatSkillVersion(skill.contentHash),
      name: skill.name,

      metadata: {
        manifest_version: '1.0',
        description: skill.description,
        author: owner,
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
          // Use skills/<skill-id>/SKILL.md so repository scope can map and install
          file: `skills/${skill.id}/SKILL.md`,
          type: 'skill',
          tags: ['skill', 'anthropic']
        }
      ]
    };
  }

  /**
   * Fetch all skills from the repository as bundles
   * Each skill becomes a separate bundle. Skills are built in bounded-size chunks; after each
   * chunk the optional callback receives a growing snapshot so the UI can render progressively.
   * @param onPartialBundles Optional callback invoked with a growing snapshot after each chunk
   */
  public async fetchBundles(
    onPartialBundles?: (bundles: Bundle[]) => void | Promise<void>
  ): Promise<Bundle[]> {
    this.logger.info(`[SkillsAdapter] Fetching skills from repository: ${this.source.url}`);

    try {
      const { owner, repo, branch, ids, filesBySkill } = await this.collectSkillWorkList();

      const bundles = await this.processInChunks(
        ids,
        15,
        async (skillId) => {
          const skill = await this.buildSkillFromTree(owner, repo, branch, skillId, filesBySkill.get(skillId) ?? []);
          return skill ? this.createBundleFromSkill(skill) : null;
        },
        onPartialBundles
      );

      this.logger.info(`[SkillsAdapter] Found ${ids.length} skills in repository`);
      this.logger.info(`[SkillsAdapter] Successfully created ${bundles.length} bundles`);
      return bundles;
    } catch (error) {
      this.logger.error(`[SkillsAdapter] Failed to fetch skills: ${error}`);
      throw new Error(`Failed to fetch skills: ${error}`);
    }
  }

  /**
   * Validate skills repository structure
   */
  public async validate(): Promise<ValidationResult> {
    this.logger.info(`[SkillsAdapter] Validating skills repository: ${this.source.url}`);

    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      const { owner, repo } = this.parseGitHubUrl();

      const baseValidation = await this.validateGitHubRepository();
      if (!baseValidation.valid) {
        return baseValidation;
      }

      let hasSkillsDir = false;
      try {
        await this.getJson(this.buildContentsUrl(owner, repo, 'skills'));
        hasSkillsDir = true;
        this.logger.debug(`[SkillsAdapter] Found skills/ directory`);
      } catch (error) {
        if (error instanceof Error && error.message.includes('404')) {
          errors.push(`Missing required 'skills' directory at repository root`);
        } else {
          errors.push(`Failed to access skills directory: ${error}`);
        }
      }

      if (!hasSkillsDir) {
        return {
          valid: false,
          errors,
          warnings,
          bundlesFound: 0
        };
      }

      let skillCount = 0;
      try {
        const tree = await this.fetchRepoTree(owner, repo, this.defaultBranch);
        skillCount = this.collectSkillIds(tree).size;

        if (skillCount === 0) {
          warnings.push('No valid skills found in skills/ directory (skills must have SKILL.md file)');
        } else {
          this.logger.info(`[SkillsAdapter] Found ${skillCount} valid skill(s)`);
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
   * Fetch repository metadata
   */
  public async fetchMetadata(): Promise<SourceMetadata> {
    try {
      const { owner, repo } = this.parseGitHubUrl();
      const tree = await this.fetchRepoTree(owner, repo, this.defaultBranch);

      return {
        name: `${owner}/${repo}`,
        description: 'Skills Repository',
        bundleCount: this.collectSkillIds(tree).size,
        lastUpdated: new Date().toISOString(),
        version: '1.0.0'
      };
    } catch (error) {
      throw new Error(`Failed to fetch skills repository metadata: ${error}`);
    }
  }

  /**
   * Get manifest URL for a skill
   * @param bundleId
   * @param _version
   */
  public getManifestUrl(bundleId: string, _version?: string): string {
    const { owner, repo } = this.parseGitHubUrl();
    const skillId = bundleId.replace(`skills-${owner}-${repo}-`, '');
    return this.buildRawUrl(owner, repo, 'main', `skills/${skillId}/SKILL.md`);
  }

  /**
   * Get download URL for a skill
   * @param _bundleId
   * @param _version
   */
  public getDownloadUrl(_bundleId: string, _version?: string): string {
    const { owner, repo } = this.parseGitHubUrl();
    return `https://github.com/${owner}/${repo}/archive/refs/heads/main.zip`;
  }

  /**
   * Download a skill bundle
   * Creates a ZIP with the skill folder and deployment manifest
   * @param bundle
   */
  public async downloadBundle(bundle: Bundle): Promise<Buffer> {
    const { owner, repo } = this.parseGitHubUrl();
    const skillId = bundle.id.replace(`skills-${owner}-${repo}-`, '');

    this.logger.info(`[SkillsAdapter] Downloading skill: ${skillId}`);

    try {
      // Fetch only the specific skill instead of scanning all skills
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
}
