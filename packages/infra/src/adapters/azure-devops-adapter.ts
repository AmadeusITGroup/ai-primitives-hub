/**
 * Azure DevOps source adapter — fetches bundles from Azure DevOps Git
 * repositories using the collections manifest convention
 * (`collections/*.collection.yml`), mirroring `AwesomeCopilotAdapter`'s
 * bundle structure.
 *
 * Uses the ADO Items REST API to list repository contents and download
 * individual files. All requests are authenticated via the injected
 * `AzureDevOpsApi` client (HTTP Basic auth with a PAT), so private
 * repositories are fully supported as long as `source.private = true`
 * and the token is configured.
 * @module adapters/azure-devops-adapter
 */
import type {
  AzureDevOpsApi,
  Bundle,
  Clock,
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
const COLLECTION_FETCH_CONCURRENCY = 5;
const ADO_API_VERSION = '7.1';

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
  readme?: { path?: string };
  items: CollectionItem[];
  mcpServers?: Record<string, unknown>;
  mcp?: { items?: Record<string, unknown> };
}

/** A single entry from the ADO Items API. */
interface AdoItem {
  /** Absolute path starting with `/`, e.g. `/collections/my-bundle.collection.yml`. */
  path: string;
  isFolder: boolean;
  objectId: string;
  /** Absolute download URL (already includes auth-agnostic query params). */
  url: string;
}

interface AdoItemsResponse {
  value: AdoItem[];
}

interface AdoUrlParts {
  org: string;
  project: string;
  repo: string;
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

export class AzureDevOpsAdapter extends BaseSourceAdapter {
  public readonly type = 'azure-devops';
  private readonly branch: string;
  private readonly collectionsPath: string;
  private cache: { bundles: Bundle[]; cachedAtMs: number } | undefined;

  public constructor(
    source: RegistrySource,
    private readonly adoApi: AzureDevOpsApi,
    private readonly clock: Clock
  ) {
    super(source);
    if (!AzureDevOpsAdapter.isValidAdoUrl(source.url)) {
      throw new Error(`Invalid Azure DevOps URL for source: ${source.url}`);
    }
    this.branch = source.config?.branch ?? DEFAULT_BRANCH;
    this.collectionsPath = source.config?.collectionsPath ?? DEFAULT_COLLECTIONS_PATH;
  }

  private static isValidAdoUrl(url: string): boolean {
    return /^https:\/\/dev\.azure\.com\/[^/]+\/[^/]+\/_git\/[^/]+/.test(url);
  }

  private parseAdoUrl(): AdoUrlParts {
    const m = /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)/.exec(this.source.url);
    if (m) {
      return { org: m[1], project: m[2], repo: m[3] };
    }
    throw new Error(`Cannot parse Azure DevOps URL: ${this.source.url}`);
  }

  private itemsBase({ org, project, repo }: AdoUrlParts): string {
    return `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repo}/items`;
  }

  // --- Collection discovery -----------------------------------------------

  private async listCollectionFiles(): Promise<AdoItem[]> {
    const parts = this.parseAdoUrl();
    const base = this.itemsBase(parts);
    const response = await this.adoApi.getJson<AdoItemsResponse>(
      `${base}?scopePath=/${this.collectionsPath}&recursionLevel=oneLevel`
      + `&versionDescriptor.version=${this.branch}&api-version=${ADO_API_VERSION}`
    );
    return response.value.filter(
      (item) => !item.isFolder && item.path.endsWith('.collection.yml')
    );
  }

  private async fetchCollection(item: AdoItem): Promise<CollectionManifest> {
    const parts = this.parseAdoUrl();
    const base = this.itemsBase(parts);
    const yamlContent = await this.adoApi.getText(
      `${base}?path=${item.path}&versionDescriptor.version=${this.branch}&api-version=${ADO_API_VERSION}`
    );
    return yaml.load(yamlContent) as CollectionManifest;
  }

  private async getBranchHeadCommit(): Promise<string> {
    const { org, project, repo } = this.parseAdoUrl();
    try {
      const response = await this.adoApi.getJson<{ value: { commitId: string }[] }>(
        `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repo}/commits`
        + `?searchCriteria.itemVersion.version=${this.branch}&$top=1&api-version=${ADO_API_VERSION}`
      );
      return response.value[0]?.commitId ?? this.branch;
    } catch {
      return this.branch;
    }
  }

  private async listDirectoryFilesRecursively(dirPath: string): Promise<AdoItem[]> {
    const base = this.itemsBase(this.parseAdoUrl());
    try {
      const response = await this.adoApi.getJson<AdoItemsResponse>(
        `${base}?scopePath=${dirPath}&recursionLevel=full`
        + `&versionDescriptor.version=${this.branch}&api-version=${ADO_API_VERSION}`
      );
      return response.value.filter((item) => !item.isFolder);
    } catch {
      // Best-effort: degrade gracefully on inaccessible subdirectory.
      return [];
    }
  }

  // --- Bundle construction ------------------------------------------------

  private buildBundle(collection: CollectionManifest, readmeRevision: string): Bundle {
    const parts = this.parseAdoUrl();
    const manifestUrl = this.getManifestUrl(collection.id);
    const readmeUrl = collection.readme?.path
      ? `${this.itemsBase(parts)}?path=${collection.readme.path}`
      + `&versionDescriptor.version=${this.branch}&api-version=${ADO_API_VERSION}`
      : undefined;

    const bundle: Bundle = {
      id: collection.id,
      name: collection.name,
      version: collection.version ?? '1.0.0',
      description: collection.description,
      author: collection.author ?? parts.org,
      sourceId: this.source.id,
      repository: this.source.url,
      tags: collection.tags ?? [],
      environments: inferEnvironments(collection.tags ?? []),
      manifestUrl,
      downloadUrl: manifestUrl,
      lastUpdated: this.clock.nowIso(),
      size: `${collection.items.length} items`,
      dependencies: [],
      license: 'MIT',
      readmeUrl,
      readmeRevision
    };

    const mcpServers = collection.mcpServers ?? collection.mcp?.items;
    (bundle as Bundle & { breakdown?: unknown }).breakdown = calculateBreakdown(collection.items, mcpServers);
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      (bundle as Bundle & { mcpServers?: unknown }).mcpServers = mcpServers;
    }
    return bundle;
  }

  private createDeploymentManifest(collection: CollectionManifest): Record<string, unknown> {
    const { org } = this.parseAdoUrl(); // only org needed here
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
    return {
      id: collection.id,
      name: collection.name,
      version: collection.version ?? '1.0.0',
      description: collection.description,
      author: collection.author ?? org,
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

    archive.append(yaml.dump(this.createDeploymentManifest(collection)), {
      name: 'deployment-manifest.yml'
    });

    const parts = this.parseAdoUrl();
    for (const item of collection.items) {
      if (item.kind === 'skill') {
        const skillDir = `/${item.path.slice(0, item.path.lastIndexOf('/'))}`;
        const skillFiles = await this.listDirectoryFilesRecursively(skillDir);
        for (const adoItem of skillFiles) {
          const content = await this.adoApi.download(adoItem.url);
          // Strip the leading '/' from the ADO path for the zip entry name.
          archive.append(Buffer.from(content), { name: adoItem.path.replace(/^\//, '') });
        }
      } else {
        const fileUrl = `${this.itemsBase(parts)}?path=/${item.path}`
          + `&versionDescriptor.version=${this.branch}&api-version=${ADO_API_VERSION}`;
        const content = await this.adoApi.download(fileUrl);
        const filename = item.path.split('/').pop() ?? 'unknown';
        archive.append(Buffer.from(content), { name: `prompts/${filename}` });
      }
    }

    await archive.finalize();
    return finished;
  }

  // --- Public API ---------------------------------------------------------

  public async fetchBundles(): Promise<Bundle[]> {
    if (this.cache && this.clock.now() - this.cache.cachedAtMs < CACHE_TTL_MS) {
      return this.cache.bundles;
    }

    let collectionItems: AdoItem[];
    try {
      collectionItems = await this.listCollectionFiles();
    } catch (error) {
      throw new Error(`Failed to list Azure DevOps collections: ${error instanceof Error ? error.message : error}`);
    }

    const bundles: Bundle[] = [];
    const readmeRevision = await this.getBranchHeadCommit();
    for (let i = 0; i < collectionItems.length; i += COLLECTION_FETCH_CONCURRENCY) {
      const batch = collectionItems.slice(i, i + COLLECTION_FETCH_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (collectionItem) => this.buildBundle(await this.fetchCollection(collectionItem), readmeRevision))
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
      const pathMatch = /[?&]path=([^&]+)/.exec(bundle.downloadUrl);
      if (!pathMatch) {
        throw new Error(`Cannot determine collection path from downloadUrl: ${bundle.downloadUrl}`);
      }
      const collectionPath = decodeURIComponent(pathMatch[1]);
      const fileUrl = `${this.itemsBase(this.parseAdoUrl())}?path=${collectionPath}`
        + `&versionDescriptor.version=${this.branch}&api-version=${ADO_API_VERSION}`;
      const fakeItem: AdoItem = { path: collectionPath, isFolder: false, objectId: '', url: fileUrl };
      const collection = await this.fetchCollection(fakeItem);
      return await this.createBundleArchive(collection);
    } catch (error) {
      throw new Error(`Failed to download bundle: ${error instanceof Error ? error.message : error}`);
    }
  }

  public async fetchMetadata(): Promise<SourceMetadata> {
    try {
      const { org, project, repo } = this.parseAdoUrl();
      const collectionItems = await this.listCollectionFiles();
      return {
        name: `${org}/${project}/${repo}`,
        description: 'Azure DevOps Collections Repository',
        bundleCount: collectionItems.length,
        lastUpdated: this.clock.nowIso(),
        version: '1.0.0'
      };
    } catch (error) {
      throw new Error(`Failed to fetch metadata: ${error instanceof Error ? error.message : error}`);
    }
  }

  public async validate(): Promise<ValidationResult> {
    const { org, project, repo } = this.parseAdoUrl();
    const repoUrl = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repo}?api-version=${ADO_API_VERSION}`;

    try {
      await this.adoApi.getJson(repoUrl);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        valid: false,
        errors: [
          `Azure DevOps repository validation failed: ${msg}`,
          `Repository URL: ${this.source.url}` // TODO. remove from PR
        ],
        warnings: [],
        bundlesFound: 0
      };
    }

    let collectionItems: AdoItem[];
    try {
      collectionItems = await this.listCollectionFiles();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        valid: false,
        errors: [msg.includes('404') ? `No collections directory found at '${this.collectionsPath}'` : `Failed to access collections directory: ${msg}`],
        warnings: [],
        bundlesFound: 0
      };
    }

    if (collectionItems.length === 0) {
      return {
        valid: false,
        errors: [`No .collection.yml files found in ${this.collectionsPath}/ directory`],
        warnings: [],
        bundlesFound: 0
      };
    }

    return { valid: true, errors: [], warnings: [], bundlesFound: collectionItems.length };
  }

  public getManifestUrl(bundleId: string): string {
    return `${this.itemsBase(this.parseAdoUrl())}`
      + `?path=/${this.collectionsPath}/${bundleId}.collection.yml`
      + `&versionDescriptor.version=${this.branch}&api-version=${ADO_API_VERSION}`;
  }

  public getDownloadUrl(bundleId: string): string {
    return this.getManifestUrl(bundleId);
  }

  public clearCache(): void {
    this.cache = undefined;
  }
}
