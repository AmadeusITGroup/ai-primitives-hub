/**
 * Skills source adapter — discovers Anthropic-style skills (a `skills/`
 * folder at the repo root, one subfolder per skill, each with a
 * `SKILL.md` containing YAML frontmatter + markdown instructions) in a
 * GitHub repository.
 *
 * Ported from `src/adapters/skills-adapter.ts`. Bundle listing already
 * used the single Git Trees API call from the `c1fbb24` perf fix
 * (`GET /git/trees/{branch}?recursive=1`, replacing an O(skills + nested
 * dirs) Contents-API walk) — this port carries that approach forward
 * as-is, via `GitHubApi.getJson`. `downloadBundle`'s single-skill path
 * still uses the Contents API (walking just that one skill's subtree),
 * which remains the cheaper option when only one skill's files are
 * needed rather than the whole repo's tree.
 *
 * Deliberate deviations from `main`:
 * - Every URL/API call hardcoded the `main` branch, with no way to
 *   override it (`scanSkillsDirectory`'s local `branch = 'main'`,
 *   `getManifestUrl`, `getDownloadUrl`, the skill `homepage` field) -
 *   this port uses the adapter's configured `source.config?.branch`
 *   throughout instead, the same fix already applied to `ApmAdapter`'s
 *   `buildManifestUrl` and consistent with `AwesomeCopilotAdapter`'s
 *   existing branch support.
 * - Repository-accessibility validation no longer composes a nested
 *   `GitHubAdapter` instance just to call its `validate()` (which only
 *   checks the repo exists and has releases - the latter irrelevant for
 *   a skills repo); it checks repo existence directly via
 *   `GitHubApi.getJson('/repos/{owner}/{repo}')`, the same underlying
 *   check with one fewer indirection and no unrelated releases call.
 * - All raw HTTP/auth goes through the injected `GitHubApi` port; ZIP
 *   creation uses `archiver` (streaming), matching every other ported
 *   adapter, instead of `adm-zip`.
 * - Dropped the unused `parsedSkillMd`/`raw`/markdown-`content` fields
 *   carried on `SkillItem`/`ParsedSkillFile` - nothing in the adapter
 *   (bundle building, deployment-manifest generation, or archiving)
 *   ever reads a skill's parsed markdown body or raw file text, only
 *   `frontmatter.name`/`description`/`license`.
 * @module adapters/skills-adapter
 */
import * as crypto from 'node:crypto';
import type {
  Bundle,
  Clock,
  GitHubApi,
  RegistrySource,
  SourceMetadata,
  ValidationResult,
} from '@ai-primitives-hub/core';
import archiver from 'archiver';
import * as yaml from 'js-yaml';
import {
  BaseSourceAdapter,
} from './base-source-adapter';

const DEFAULT_BRANCH = 'main';
/** SKILL.md fetches (one per discovered skill) are batched this many at a time. */
const SKILL_FETCH_CONCURRENCY = 5;
const SKILL_ENVIRONMENTS = ['claude', 'vscode', 'claude-code'];
const SKILL_TAGS = ['skill', 'anthropic'];
/** Crude per-file size heuristic, matching `main`: actual byte sizes aren't available from the tree/contents listing without a further fetch per file. */
const ESTIMATED_BYTES_PER_FILE = 4096;

type ArchiverInstance = ReturnType<typeof archiver>;

/** A single blob/tree entry from the GitHub Git Trees API (recursive listing). */
interface GitTreeEntry {
  path: string;
  type: string;
  sha: string;
}

/** A single entry from the GitHub Contents API. */
interface GitHubContentItem {
  name: string;
  path: string;
  type: 'file' | 'dir';
  // eslint-disable-next-line @typescript-eslint/naming-convention -- matches external API response shape
  download_url?: string;
}

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

function getRelativeSkillPath(fullPath: string, skillPath: string): string {
  if (fullPath.startsWith(`${skillPath}/`)) {
    return fullPath.slice(skillPath.length + 1);
  }
  return fullPath === skillPath ? (fullPath.split('/').pop() ?? fullPath) : fullPath;
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

/**
 * Stable hash over sorted (path, sha) pairs, so re-ordering the tree/directory listing never changes the result.
 * @param files - Files to hash, each with a path and a content-identifying sha.
 */
function calculateContentHash(files: { path: string; sha?: string }[]): string {
  const hash = crypto.createHash('sha256');
  for (const file of files.toSorted((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path);
    hash.update(':');
    hash.update(file.sha ?? '');
    hash.update('|');
  }
  return hash.digest('hex');
}

export class SkillsAdapter extends BaseSourceAdapter {
  public readonly type = 'skills';

  private readonly branch: string;

  public constructor(
    source: RegistrySource,
    private readonly githubApi: GitHubApi,
    private readonly clock: Clock
  ) {
    super(source);
    if (!SkillsAdapter.isValidGitHubUrl(source.url)) {
      throw new Error(`Invalid GitHub URL for skills source: ${source.url}`);
    }
    this.branch = source.config?.branch ?? DEFAULT_BRANCH;
  }

  private static isValidGitHubUrl(url: string): boolean {
    if (url.startsWith('https://')) {
      return url.includes('github.com');
    }
    if (url.startsWith('git@')) {
      return url.includes('github.com:');
    }
    return false;
  }

  private parseGitHubUrl(): { owner: string; repo: string } {
    const url = this.source.url.replace(/\.git$/, '');
    const match = /github\.com[/:]([^/]+)\/([^/]+)/.exec(url);
    if (!match) {
      throw new Error(`Invalid GitHub URL format: ${this.source.url}`);
    }
    return { owner: match[1], repo: match[2] };
  }

  private buildBundleId(owner: string, repo: string, skillId: string): string {
    return `skills-${owner}-${repo}-${skillId}`;
  }

  private skillIdFromBundleId(bundleId: string, owner: string, repo: string): string {
    return bundleId.replace(`skills-${owner}-${repo}-`, '');
  }

  private async buildSkillFromTree(owner: string, repo: string, skillId: string, entries: GitTreeEntry[]): Promise<SkillItem | undefined> {
    const skillPath = `skills/${skillId}`;
    try {
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${this.branch}/${skillPath}/SKILL.md`;
      const frontmatter = parseFrontmatter(await this.githubApi.getText(rawUrl));
      return {
        id: skillId,
        name: frontmatter.name || skillId,
        description: frontmatter.description || 'No description',
        license: frontmatter.license,
        path: skillPath,
        files: entries.map((entry) => getRelativeSkillPath(entry.path, skillPath)),
        contentHash: calculateContentHash(entries)
      };
    } catch {
      return undefined;
    }
  }

  /** Single Git Trees API call, grouping blobs by top-level `skills/<id>/` folder (the `c1fbb24` perf fix). */
  private async scanSkillsDirectory(): Promise<SkillItem[]> {
    const { owner, repo } = this.parseGitHubUrl();
    const tree = await this.githubApi.getJson<{ tree?: GitTreeEntry[] }>(
      `/repos/${owner}/${repo}/git/trees/${this.branch}?recursive=1`
    );

    const filesBySkill = new Map<string, GitTreeEntry[]>();
    const skillIds = new Set<string>();
    for (const entry of tree.tree ?? []) {
      if (entry.type !== 'blob') {
        continue;
      }
      const segments = entry.path.split('/');
      if (segments[0] !== 'skills' || segments.length < 3) {
        continue;
      }
      const skillId = segments[1];
      const files = filesBySkill.get(skillId) ?? [];
      files.push(entry);
      filesBySkill.set(skillId, files);
      if (segments.length === 3 && segments[2] === 'SKILL.md') {
        skillIds.add(skillId);
      }
    }

    const ids = [...skillIds];
    const skills: SkillItem[] = [];
    for (let i = 0; i < ids.length; i += SKILL_FETCH_CONCURRENCY) {
      const batch = ids.slice(i, i + SKILL_FETCH_CONCURRENCY);
      const results = await Promise.all(batch.map((id) => this.buildSkillFromTree(owner, repo, id, filesBySkill.get(id) ?? [])));
      skills.push(...results.filter((skill): skill is SkillItem => skill !== undefined));
    }
    return skills;
  }

  private createBundleFromSkill(skill: SkillItem, owner: string, repo: string): Bundle {
    const bundleId = this.buildBundleId(owner, repo, skill.id);
    return {
      id: bundleId,
      name: skill.name,
      // Manifest version must match bundle version for install/update validation.
      version: formatSkillVersion(skill.contentHash),
      description: skill.description,
      author: owner,
      sourceId: this.source.id,
      environments: SKILL_ENVIRONMENTS,
      tags: SKILL_TAGS,
      lastUpdated: this.clock.nowIso(),
      size: estimateSkillSize(skill.files.length),
      dependencies: [],
      license: skill.license || 'Unknown',
      repository: this.source.url,
      homepage: `https://github.com/${owner}/${repo}/tree/${this.branch}/${skill.path}`,
      manifestUrl: this.getManifestUrl(bundleId),
      downloadUrl: this.getDownloadUrl()
    };
  }

  // --- Single-skill fetch (download path) -----------------------------

  private async collectSkillFiles(owner: string, repo: string, initialEntries: GitHubContentItem[]): Promise<GitHubContentItem[]> {
    const files: GitHubContentItem[] = [];
    const queue = [...initialEntries];
    while (queue.length > 0) {
      const entry = queue.shift();
      if (!entry) {
        continue;
      }
      if (entry.type === 'file') {
        files.push(entry);
        continue;
      }
      try {
        queue.push(...(await this.githubApi.getJson<GitHubContentItem[]>(`/repos/${owner}/${repo}/contents/${entry.path}`)));
      } catch {
        // Best-effort: a nested directory that can't be listed is skipped, not fatal to the rest of the skill.
      }
    }
    return files;
  }

  private async fetchSingleSkill(skillId: string): Promise<SkillItem | undefined> {
    const { owner, repo } = this.parseGitHubUrl();
    const skillPath = `skills/${skillId}`;

    try {
      const skillContents = await this.githubApi.getJson<GitHubContentItem[]>(`/repos/${owner}/${repo}/contents/${skillPath}`);
      const skillMdFile = skillContents.find((item) => item.type === 'file' && item.name === 'SKILL.md');
      if (!skillMdFile?.download_url) {
        return undefined;
      }

      const frontmatter = parseFrontmatter(await this.githubApi.getText(skillMdFile.download_url));
      const allFiles = await this.collectSkillFiles(owner, repo, skillContents);

      return {
        id: skillId,
        name: frontmatter.name || skillId,
        description: frontmatter.description || '',
        license: frontmatter.license,
        path: skillPath,
        files: allFiles.map((item) => getRelativeSkillPath(item.path, skillPath)),
        contentHash: calculateContentHash(allFiles)
      };
    } catch {
      return undefined;
    }
  }

  // --- Archive creation -------------------------------------------------

  private createDeploymentManifest(skill: SkillItem, owner: string, repo: string): Record<string, unknown> {
    return {
      // Field names below are dictated by the deployment-manifest.yml schema
      // (see `test/services/deployment-manifest-validator.test.ts`), not our own naming choice.
      id: this.buildBundleId(owner, repo, skill.id),
      version: formatSkillVersion(skill.contentHash),
      name: skill.name,
      metadata: {
        manifest_version: '1.0',
        description: skill.description,
        author: owner,
        last_updated: this.clock.nowIso(),
        repository: {
          type: 'git',
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
          file: `skills/${skill.id}/SKILL.md`,
          type: 'skill',
          tags: SKILL_TAGS
        }
      ]
    };
  }

  private async addDirectoryToArchive(archive: ArchiverInstance, owner: string, repo: string, dirPath: string, zipPath: string): Promise<void> {
    let dirContents: GitHubContentItem[];
    try {
      dirContents = await this.githubApi.getJson<GitHubContentItem[]>(`/repos/${owner}/${repo}/contents/${dirPath}`);
    } catch {
      return;
    }

    for (const item of dirContents) {
      if (item.type === 'file' && item.download_url) {
        const content = await this.githubApi.download(item.download_url);
        archive.append(Buffer.from(content), { name: `${zipPath}/${item.name}` });
      } else if (item.type === 'dir') {
        await this.addDirectoryToArchive(archive, owner, repo, item.path, `${zipPath}/${item.name}`);
      }
    }
  }

  private async createBundleArchive(skill: SkillItem, owner: string, repo: string): Promise<Buffer> {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks: Buffer[] = [];
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));

    const finished = new Promise<Buffer>((resolve, reject) => {
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      archive.on('error', (err: Error) => reject(new Error(`Failed to create ZIP archive: ${err.message}`)));
    });

    const manifestYaml = yaml.dump(this.createDeploymentManifest(skill, owner, repo));
    archive.append(manifestYaml, { name: 'deployment-manifest.yml' });

    const skillContents = await this.githubApi.getJson<GitHubContentItem[]>(`/repos/${owner}/${repo}/contents/${skill.path}`);
    for (const item of skillContents) {
      if (item.type === 'file' && item.download_url) {
        const content = await this.githubApi.download(item.download_url);
        archive.append(Buffer.from(content), { name: `skills/${skill.id}/${item.name}` });
      } else if (item.type === 'dir') {
        await this.addDirectoryToArchive(archive, owner, repo, item.path, `skills/${skill.id}/${item.name}`);
      }
    }

    await archive.finalize();
    return finished;
  }

  // --- Public API ---------------------------------------------------------

  public async fetchBundles(): Promise<Bundle[]> {
    const { owner, repo } = this.parseGitHubUrl();
    let skills: SkillItem[];
    try {
      skills = await this.scanSkillsDirectory();
    } catch (error) {
      throw new Error(`Failed to fetch skills: ${error instanceof Error ? error.message : error}`);
    }
    return skills.map((skill) => this.createBundleFromSkill(skill, owner, repo));
  }

  public async downloadBundle(bundle: Bundle): Promise<Buffer> {
    const { owner, repo } = this.parseGitHubUrl();
    const skillId = this.skillIdFromBundleId(bundle.id, owner, repo);

    try {
      const skill = await this.fetchSingleSkill(skillId);
      if (!skill) {
        throw new Error(`Skill not found: ${skillId}`);
      }
      return await this.createBundleArchive(skill, owner, repo);
    } catch (error) {
      throw new Error(`Failed to download skill ${skillId}: ${error instanceof Error ? error.message : error}`);
    }
  }

  public async fetchMetadata(): Promise<SourceMetadata> {
    try {
      const { owner, repo } = this.parseGitHubUrl();
      const skills = await this.scanSkillsDirectory();
      return {
        name: `${owner}/${repo}`,
        description: 'Skills Repository',
        bundleCount: skills.length,
        lastUpdated: this.clock.nowIso(),
        version: '1.0.0'
      };
    } catch (error) {
      throw new Error(`Failed to fetch skills repository metadata: ${error instanceof Error ? error.message : error}`);
    }
  }

  public getManifestUrl(bundleId: string): string {
    const { owner, repo } = this.parseGitHubUrl();
    const skillId = this.skillIdFromBundleId(bundleId, owner, repo);
    return `https://raw.githubusercontent.com/${owner}/${repo}/${this.branch}/skills/${skillId}/SKILL.md`;
  }

  public getDownloadUrl(): string {
    const { owner, repo } = this.parseGitHubUrl();
    return `https://github.com/${owner}/${repo}/archive/refs/heads/${this.branch}.zip`;
  }

  public async validate(): Promise<ValidationResult> {
    const { owner, repo } = this.parseGitHubUrl();

    try {
      await this.githubApi.getJson(`/repos/${owner}/${repo}`);
    } catch (error) {
      return {
        valid: false,
        errors: [`Skills repository validation failed: ${error instanceof Error ? error.message : error}`],
        warnings: [],
        bundlesFound: 0
      };
    }

    try {
      await this.githubApi.getJson(`/repos/${owner}/${repo}/contents/skills`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        valid: false,
        errors: [message.includes('404') ? `Missing required 'skills' directory at repository root` : `Failed to access skills directory: ${message}`],
        warnings: [],
        bundlesFound: 0
      };
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
}
