/**
 * Awesome Copilot source adapter — fetches bundles from `github/awesome-copilot`
 * style collection repositories (a `.collection.yml` file per bundle,
 * referencing a set of prompt/instruction/chatmode/agent/skill files by
 * path, built into a ZIP on demand).
 *
 * Ported from `src/adapters/awesome-copilot-adapter.ts`. As with
 * `GitHubAdapter`, all raw HTTP/auth now lives behind the injected
 * `GitHubApi` port. Three further deliberate deviations, each fixing a
 * latent issue while porting rather than carrying it forward uninspected:
 *
 * - `collectionFile` is recovered by parsing `Bundle.downloadUrl` (which
 *   already encodes it), instead of an ad hoc `(bundle as any).collectionFile`
 *   field that doesn't exist on `Bundle`'s real type - same reasoning as
 *   `GitHubAdapter`'s module doc for the `prompts`/`mcpServers` fields, but
 *   here the field was load-bearing (`downloadBundle`'s own fallback
 *   depended on it), not just a UI decoration, so it needs a real
 *   replacement rather than a drop.
 * - Item/skill file content is fetched as bytes (`GitHubApi.download`)
 *   rather than concatenated as a string (`GitHubApi.getText`) before being
 *   appended to the archive - main's `data += chunk` on a `Buffer` mangles
 *   non-UTF8 bytes, and skill directories aren't guaranteed to contain only
 *   text files.
 * - The cache is a plain nullable field instead of a `Map`: it was always
 *   keyed by `${source.url}-${branch}`, which can only ever take one value
 *   for a given adapter instance (both are fixed at construction), so the
 *   `Map` never held more than one entry.
 *
 * Ported (as with `GitHubAdapter`): the ad hoc `breakdown`/`mcpServers`
 * fields attached to the returned `Bundle` purely for the Marketplace
 * webview's content-breakdown UI. Neither is part of `Bundle`'s actual
 * type, so both stay the same ad hoc cast rather than becoming a real
 * `Bundle` field - a pure behavior-parity fix, not a type-system change.
 * @module adapters/awesome-copilot-adapter
 */
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

const CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_BRANCH = 'main';
const DEFAULT_COLLECTIONS_PATH = 'collections';
/** Collection files are fetched this many at a time, mirroring `GitHubAdapter`'s manifest-download batching. */
const COLLECTION_FETCH_CONCURRENCY = 5;

type ItemKind = 'prompt' | 'instruction' | 'chat-mode' | 'agent' | 'skill';
type ManifestPromptType = 'prompt' | 'instructions' | 'chatmode' | 'agent' | 'skill';

interface CollectionItem {
  path: string;
  kind: ItemKind;
}

interface CollectionManifest {
  id: string;
  name: string;
  description: string;
  version?: string;
  author?: string;
  tags?: string[];
  items: CollectionItem[];
  mcpServers?: Record<string, unknown>;
  mcp?: {
    items?: Record<string, unknown>;
  };
}

interface GitHubContentEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
}

const KIND_TO_MANIFEST_TYPE: Record<ItemKind, ManifestPromptType> = {
  prompt: 'prompt',
  instruction: 'instructions',
  'chat-mode': 'chatmode',
  agent: 'agent',
  skill: 'skill'
};

const TAG_TO_ENVIRONMENT: Record<string, string> = {
  azure: 'cloud',
  aws: 'cloud',
  gcp: 'cloud',
  frontend: 'web',
  backend: 'server',
  database: 'data',
  devops: 'infrastructure',
  testing: 'testing'
};

function inferEnvironments(tags: string[]): string[] {
  const environments = new Set<string>();
  for (const tag of tags) {
    const environment = TAG_TO_ENVIRONMENT[tag.toLowerCase()];
    if (environment) {
      environments.add(environment);
    }
  }
  return environments.size > 0 ? [...environments] : ['general'];
}

function titleCase(value: string): string {
  return value
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Content breakdown by item kind, plus an MCP server count - read by the
 * Marketplace webview's content-breakdown UI (`bundle.breakdown`).
 * @param items - Collection items to count by kind.
 * @param mcpServers - Raw MCP server config map, if the collection declares any.
 */
function calculateBreakdown(items: CollectionItem[], mcpServers?: Record<string, unknown>): Record<string, number> {
  const breakdown = {
    prompts: 0,
    instructions: 0,
    chatmodes: 0,
    agents: 0,
    skills: 0,
    mcpServers: mcpServers ? Object.keys(mcpServers).length : 0
  };

  for (const item of items) {
    switch (item.kind) {
      case 'prompt': {
        breakdown.prompts++;
        break;
      }
      case 'instruction': {
        breakdown.instructions++;
        break;
      }
      case 'chat-mode': {
        breakdown.chatmodes++;
        break;
      }
      case 'agent': {
        breakdown.agents++;
        break;
      }
      case 'skill': {
        breakdown.skills++;
        break;
      }
    }
  }

  return breakdown;
}

export class AwesomeCopilotAdapter extends BaseSourceAdapter {
  public readonly type = 'awesome-copilot';

  private readonly branch: string;
  private readonly collectionsPath: string;
  private cache: { bundles: Bundle[]; cachedAtMs: number } | undefined;

  public constructor(
    source: RegistrySource,
    private readonly githubApi: GitHubApi,
    private readonly clock: Clock
  ) {
    super(source);
    this.branch = source.config?.branch ?? DEFAULT_BRANCH;
    this.collectionsPath = source.config?.collectionsPath ?? DEFAULT_COLLECTIONS_PATH;
  }

  private parseGitHubUrl(): { owner: string; repo: string } {
    const url = this.source.url.replace(/\.git$/, '');
    const match = /github\.com[/:]([^/]+)\/([^/]+)/.exec(url);
    if (!match) {
      throw new Error(`Invalid GitHub URL: ${this.source.url}`);
    }
    return { owner: match[1], repo: match[2] };
  }

  private buildApiPath(path: string): string {
    const { owner, repo } = this.parseGitHubUrl();
    return `/repos/${owner}/${repo}/contents/${path}?ref=${this.branch}`;
  }

  private buildRawUrl(path: string): string {
    const { owner, repo } = this.parseGitHubUrl();
    return `https://raw.githubusercontent.com/${owner}/${repo}/${this.branch}/${path}`;
  }

  private async listCollectionFiles(): Promise<string[]> {
    const entries = await this.githubApi.getJson<GitHubContentEntry[]>(this.buildApiPath(this.collectionsPath));
    return entries.filter((entry) => entry.type === 'file' && entry.name.endsWith('.collection.yml')).map((entry) => entry.name);
  }

  /**
   * File paths (relative to the repo root) under `dirPath`, recursed via
   * repeated Contents-API calls (one per subdirectory). Silently returns
   * whatever was found so far on failure, matching `main`'s behavior of
   * degrading a single skill's file list rather than failing the archive.
   * @param dirPath - Directory to walk, relative to the repo root.
   */
  private async listDirectoryFilesRecursively(dirPath: string): Promise<string[]> {
    const filePaths: string[] = [];
    let entries: GitHubContentEntry[];
    try {
      entries = await this.githubApi.getJson<GitHubContentEntry[]>(this.buildApiPath(dirPath));
    } catch {
      return filePaths;
    }
    for (const entry of entries) {
      if (entry.type === 'file') {
        filePaths.push(entry.path);
      } else {
        filePaths.push(...(await this.listDirectoryFilesRecursively(entry.path)));
      }
    }
    return filePaths;
  }

  private async fetchCollection(collectionFile: string): Promise<CollectionManifest> {
    const yamlContent = await this.githubApi.getText(this.buildRawUrl(`${this.collectionsPath}/${collectionFile}`));
    return yaml.load(yamlContent) as CollectionManifest;
  }

  private buildBundle(collection: CollectionManifest, collectionFile: string): Bundle {
    const { owner } = this.parseGitHubUrl();
    const rawUrl = this.buildRawUrl(`${this.collectionsPath}/${collectionFile}`);
    const bundle: Bundle = {
      id: collection.id,
      name: collection.name,
      version: collection.version ?? '1.0.0',
      description: collection.description,
      author: collection.author ?? owner,
      sourceId: this.source.id,
      repository: this.source.url,
      tags: collection.tags ?? [],
      environments: inferEnvironments(collection.tags ?? []),
      manifestUrl: rawUrl,
      downloadUrl: rawUrl,
      lastUpdated: this.clock.nowIso(),
      size: `${collection.items.length} items`,
      dependencies: [],
      license: 'MIT'
    };

    // Attach a content breakdown + raw MCP servers for the Marketplace
    // webview's content-breakdown UI. Not part of `Bundle`'s real type -
    // see this module's own doc.
    const mcpServers = collection.mcpServers ?? collection.mcp?.items;
    (bundle as Bundle & { breakdown?: unknown }).breakdown = calculateBreakdown(collection.items, mcpServers);
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      (bundle as Bundle & { mcpServers?: unknown }).mcpServers = mcpServers;
    }

    return bundle;
  }

  private createDeploymentManifest(collection: CollectionManifest): Record<string, unknown> {
    const prompts = collection.items.map((item) => {
      if (item.kind === 'skill') {
        const skillMatch = /skills\/([^/]+)\/SKILL\.md/.exec(item.path);
        const skillName = skillMatch ? skillMatch[1] : 'unknown-skill';
        return {
          id: skillName,
          name: titleCase(skillName.replace(/-/g, ' ')),
          description: `Skill from ${collection.name}`,
          file: item.path,
          type: 'skill' as const,
          tags: collection.tags ?? []
        };
      }

      const filename = item.path.split('/').pop() ?? 'unknown';
      const id = filename.replace(/\.(prompt|instructions|chatmode|agent)\.md$/, '');
      return {
        id,
        name: titleCase(id.replace(/-/g, ' ')),
        description: `From ${collection.name}`,
        file: `prompts/${filename}`,
        type: KIND_TO_MANIFEST_TYPE[item.kind],
        tags: collection.tags ?? []
      };
    });

    const mcpServers = collection.mcpServers ?? collection.mcp?.items;
    const { owner } = this.parseGitHubUrl();

    return {
      id: collection.id,
      name: collection.name,
      version: collection.version ?? '1.0.0',
      description: collection.description,
      author: collection.author ?? owner,
      repository: this.source.url,
      license: 'MIT',
      tags: collection.tags ?? [],
      prompts,
      ...(mcpServers && Object.keys(mcpServers).length > 0 ? { mcpServers } : {})
    };
  }

  private async createBundleArchive(collection: CollectionManifest): Promise<Buffer> {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks: Buffer[] = [];
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));

    const finished = new Promise<Buffer>((resolve, reject) => {
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      archive.on('error', (err: Error) => reject(new Error(`Failed to create ZIP archive: ${err.message}`)));
    });

    const manifestYaml = yaml.dump(this.createDeploymentManifest(collection));
    archive.append(manifestYaml, { name: 'deployment-manifest.yml' });

    for (const item of collection.items) {
      if (item.kind === 'skill') {
        const skillDir = item.path.slice(0, item.path.lastIndexOf('/'));
        const skillFiles = await this.listDirectoryFilesRecursively(skillDir);
        for (const filePath of skillFiles) {
          const content = await this.githubApi.download(this.buildRawUrl(filePath));
          archive.append(Buffer.from(content), { name: filePath });
        }
      } else {
        const content = await this.githubApi.download(this.buildRawUrl(item.path));
        const filename = item.path.split('/').pop() ?? 'unknown';
        archive.append(Buffer.from(content), { name: `prompts/${filename}` });
      }
    }
    await archive.finalize();

    return finished;
  }

  public async fetchBundles(): Promise<Bundle[]> {
    if (this.cache && this.clock.now() - this.cache.cachedAtMs < CACHE_TTL_MS) {
      return this.cache.bundles;
    }

    let collectionFiles: string[];
    try {
      collectionFiles = await this.listCollectionFiles();
    } catch (error) {
      throw new Error(`Failed to list awesome-copilot collections: ${error instanceof Error ? error.message : error}`);
    }

    const bundles: Bundle[] = [];
    for (let i = 0; i < collectionFiles.length; i += COLLECTION_FETCH_CONCURRENCY) {
      const batch = collectionFiles.slice(i, i + COLLECTION_FETCH_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (collectionFile) => this.buildBundle(await this.fetchCollection(collectionFile), collectionFile))
      );
      for (const result of results) {
        if (result.status === 'fulfilled') {
          bundles.push(result.value);
        }
      }
    }

    this.cache = { bundles, cachedAtMs: this.clock.now() };
    return bundles;
  }

  public async downloadBundle(bundle: Bundle): Promise<Buffer> {
    try {
      const collectionFile = bundle.downloadUrl.split('/').pop();
      if (!collectionFile) {
        throw new Error(`Cannot determine collection file from downloadUrl: ${bundle.downloadUrl}`);
      }
      const collection = await this.fetchCollection(collectionFile);
      return await this.createBundleArchive(collection);
    } catch (error) {
      throw new Error(`Failed to download bundle: ${error instanceof Error ? error.message : error}`);
    }
  }

  public async fetchMetadata(): Promise<SourceMetadata> {
    try {
      const { owner, repo } = this.parseGitHubUrl();
      const collectionFiles = await this.listCollectionFiles();
      return {
        name: `${owner}/${repo}`,
        description: `Awesome Copilot collections from ${this.source.url}`,
        bundleCount: collectionFiles.length,
        lastUpdated: this.clock.nowIso(),
        version: '1.0.0'
      };
    } catch (error) {
      throw new Error(`Failed to fetch metadata: ${error instanceof Error ? error.message : error}`);
    }
  }

  public getManifestUrl(bundleId: string): string {
    return this.buildRawUrl(`${this.collectionsPath}/${bundleId}.collection.yml`);
  }

  public getDownloadUrl(bundleId: string): string {
    return this.getManifestUrl(bundleId);
  }

  public async validate(): Promise<ValidationResult> {
    try {
      const collectionFiles = await this.listCollectionFiles();
      if (collectionFiles.length === 0) {
        return { valid: false, errors: ['No .collection.yml files found in collections directory'], warnings: [], bundlesFound: 0 };
      }
      return { valid: true, errors: [], warnings: [], bundlesFound: collectionFiles.length };
    } catch (error) {
      return {
        valid: false,
        errors: [`Failed to validate repository: ${error instanceof Error ? error.message : error}`],
        warnings: [],
        bundlesFound: 0
      };
    }
  }

  /**
   * Clear the collections cache. Called by consumers (e.g. a manual,
   * user-initiated source re-sync) that need to guarantee fresh data
   * rather than whatever was cached from an earlier `fetchBundles` call -
   * same reasoning as `GitHubAdapter.clearManifestCache`.
   */
  public clearCache(): void {
    this.cache = undefined;
  }
}
