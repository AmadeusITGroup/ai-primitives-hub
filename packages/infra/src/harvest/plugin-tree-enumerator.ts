/**
 * Plugin tree enumerator.
 *
 * Unlike the single-bundle model where one repo = one bundle, a plugin
 * repo hosts many bundles — one per subdirectory of `<pluginsPath>/<id>/`
 * that contains `.github/plugin/plugin.json`. This enumerator:
 *
 *   1. Resolves the repo's commit sha (via the shared resolveCommitSha
 *      helper so ETag / smart-rebuild keeps working).
 *   2. Fetches the recursive git tree once.
 *   3. Discovers plugin manifests: any blob at
 *      `<pluginsPath>/<id>/.github/plugin/plugin.json`.
 *   4. Fetches each manifest's bytes, parses + derives items.
 *   5. For each item, adds the resolved entry file to that plugin's
 *      candidate list (SKILL.md / AGENT.md / *.prompt.md / ...).
 *
 * The manifest itself is included in the candidate set (path +
 * blobSha) so `GitHubSingleBundleProvider.readManifest()` can fetch
 * it by sha from the same blob cache later — no duplicate round trips.
 *
 * All blob size checks use the same default as the single-bundle
 * enumerator (256 KiB) to guard against accidentally pulling a huge
 * binary through the filter.
 */

import {
  BlobCache,
} from '../github/blob-cache';
import type {
  GitHubClient,
} from '../github/client';
import type {
  EtagStore,
} from '../github/etag-store';
import {
  derivePluginItems,
  parsePluginManifest,
  resolvePluginItemEntryPath,
} from './plugin-manifest';
import {
  resolveCommitSha,
} from './tree-enumerator';

export interface EnumeratePluginRepoOptions {
  owner: string;
  repo: string;
  ref: string;
  /** Subdir containing plugins, e.g. "plugins". */
  pluginsPath: string;
  /** Optional shared ETag store (passes through to resolveCommitSha). */
  etagStore?: EtagStore;
  /**
   * Inject an existing BlobCache so manifest reads hit the same blob
   * cache the caller uses elsewhere. When omitted, manifests are fetched
   * directly without caching (tests typically omit this).
   */
  cache?: BlobCache;
  /** GitHub client for API calls. */
  client: GitHubClient;
  /** Max blob size guard (default 256 KiB). */
  maxFileSize?: number;
}

/** One plugin discovered under `pluginsPath/`. */
export interface PluginDiscovery {
  /** Folder name under pluginsPath/, e.g. "skills-plugin". */
  pluginId: string;
  /** Full path under the repo root, e.g. "plugins/skills-plugin". */
  pluginRoot: string;
  /** The parsed manifest (kept as-is for downstream use). */
  manifest: unknown;
  /** File candidates to fetch: manifest + resolved entry files. */
  candidates: { path: string; blobSha: string; size: number }[];
}

export interface EnumeratePluginRepoResult {
  commitSha: string;
  plugins: PluginDiscovery[];
}

interface TreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

interface TreeResponse {
  sha: string;
  tree: TreeEntry[];
  truncated: boolean;
}

function indexBlobsByPath(tree: TreeResponse): Map<string, { sha: string; size: number }> {
  const blobByPath = new Map<string, { sha: string; size: number }>();
  for (const e of tree.tree) {
    if (e.type === 'blob') {
      blobByPath.set(e.path, { sha: e.sha, size: e.size ?? 0 });
    }
  }
  return blobByPath;
}

function filterManifestPaths(
  blobByPath: Map<string, { sha: string; size: number }>,
  prefix: string,
  manifestSuffix: string
): string[] {
  return [...blobByPath.keys()].filter(
    (p) => p.startsWith(prefix) && p.endsWith(manifestSuffix)
  );
}

async function fetchManifestResults(
  manifestPaths: string[],
  blobByPath: Map<string, { sha: string; size: number }>,
  client: GitHubClient,
  cache: BlobCache | undefined,
  owner: string,
  repo: string,
  maxFileSize: number
): Promise<{ manifestPath: string; bytes: string | undefined; manifestBlob: { sha: string; size: number } | undefined }[]> {
  return Promise.all(
    manifestPaths.map(async (manifestPath) => {
      const manifestBlob = blobByPath.get(manifestPath);
      if (!manifestBlob || manifestBlob.size > maxFileSize) {
        return { manifestPath, bytes: undefined as string | undefined, manifestBlob };
      }
      try {
        const bytes = await fetchManifestBytes(client, cache, owner, repo, manifestBlob.sha);
        return { manifestPath, bytes, manifestBlob };
      } catch {
        return { manifestPath, bytes: undefined, manifestBlob };
      }
    })
  );
}

function processManifestResult(
  result: { manifestPath: string; bytes: string | undefined; manifestBlob: { sha: string; size: number } | undefined },
  prefix: string,
  pluginsPath: string,
  blobByPath: Map<string, { sha: string; size: number }>,
  maxFileSize: number
): PluginDiscovery | null {
  const { manifestPath, bytes, manifestBlob } = result;
  if (!manifestBlob || bytes === undefined) {
    return null;
  }
  const pluginInfo = extractPluginInfo(manifestPath, prefix, pluginsPath);
  if (!pluginInfo) {
    return null;
  }
  const manifest = parseManifestSafely(bytes);
  if (!manifest || manifest.external === true) {
    return null;
  }
  const candidates = buildCandidates(manifest, pluginInfo.pluginRoot, manifestPath, manifestBlob, blobByPath, maxFileSize);
  return { pluginId: pluginInfo.pluginId, pluginRoot: pluginInfo.pluginRoot, manifest, candidates };
}

function extractPluginInfo(manifestPath: string, prefix: string, pluginsPath: string): { pluginId: string; pluginRoot: string } | null {
  const rel = manifestPath.slice(prefix.length);
  const sepIdx = rel.indexOf('/');
  if (sepIdx === -1) {
    return null;
  }
  const pluginId = rel.slice(0, sepIdx);
  const pluginRoot = `${pluginsPath}/${pluginId}`;
  return { pluginId, pluginRoot };
}

function parseManifestSafely(bytes: string): ReturnType<typeof parsePluginManifest> | null {
  try {
    return parsePluginManifest(bytes);
  } catch {
    return null;
  }
}

function buildCandidates(
  manifest: ReturnType<typeof parsePluginManifest>,
  pluginRoot: string,
  manifestPath: string,
  manifestBlob: { sha: string; size: number },
  blobByPath: Map<string, { sha: string; size: number }>,
  maxFileSize: number
): PluginDiscovery['candidates'] {
  const candidates: PluginDiscovery['candidates'] = [
    { path: manifestPath, blobSha: manifestBlob.sha, size: manifestBlob.size }
  ];
  const items = derivePluginItems(manifest);
  for (const item of items) {
    const entryPath = resolvePluginItemEntryPath(pluginRoot, item);
    const blob = blobByPath.get(entryPath);
    if (!blob || blob.size > maxFileSize) {
      continue;
    }
    candidates.push({ path: entryPath, blobSha: blob.sha, size: blob.size });
  }
  return candidates;
}

/**
 * Enumerate all plugins in a repo, returning one PluginDiscovery per
 * subdir under pluginsPath/ that contains a plugin.json.
 * @param client - Authorised GitHub API client.
 * @param opts - Repo coordinates + pluginsPath + optional ETag/blob cache.
 * @throws {Error} if the tree is truncated (we can't guarantee all blobs).
 */
export async function enumeratePluginRepo(
  client: GitHubClient,
  opts: EnumeratePluginRepoOptions
): Promise<EnumeratePluginRepoResult> {
  const { owner, repo, ref, pluginsPath, etagStore, maxFileSize = 256 * 1024 } = opts;
  const commitSha = await resolveCommitSha(client, { owner, repo, ref, etagStore });
  const tree = await fetchTree(client, owner, repo, commitSha);

  const { prefix, manifestSuffix } = buildPluginPaths(pluginsPath);
  const blobByPath = indexBlobsByPath(tree);
  const manifestPaths = filterManifestPaths(blobByPath, prefix, manifestSuffix);
  const manifestResults = await fetchManifestResults(
    manifestPaths,
    blobByPath,
    client,
    opts.cache,
    owner,
    repo,
    maxFileSize
  );

  const plugins = processManifestResults(manifestResults, prefix, pluginsPath, blobByPath, maxFileSize);
  return { commitSha, plugins };
}

async function fetchTree(client: GitHubClient, owner: string, repo: string, commitSha: string): Promise<TreeResponse> {
  const tree = await client.getJson<TreeResponse>(
    `/repos/${owner}/${repo}/git/trees/${commitSha}?recursive=1`
  );
  if (tree.truncated) {
    throw new Error(`plugin tree truncated for ${owner}/${repo}@${commitSha}: too many entries`);
  }
  return tree;
}

function buildPluginPaths(pluginsPath: string): { prefix: string; manifestSuffix: string } {
  const prefix = `${pluginsPath.replace(/\/+$/u, '')}/`;
  const manifestSuffix = '/.github/plugin/plugin.json';
  return { prefix, manifestSuffix };
}

function processManifestResults(
  manifestResults: { manifestPath: string; bytes: string | undefined; manifestBlob: { sha: string; size: number } | undefined }[],
  prefix: string,
  pluginsPath: string,
  blobByPath: Map<string, { sha: string; size: number }>,
  maxFileSize: number
): PluginDiscovery[] {
  const plugins: PluginDiscovery[] = [];
  for (const result of manifestResults) {
    const plugin = processManifestResult(result, prefix, pluginsPath, blobByPath, maxFileSize);
    if (plugin) {
      plugins.push(plugin);
    }
  }
  return plugins;
}

async function fetchManifestBytes(
  client: GitHubClient,
  cache: BlobCache | undefined,
  owner: string,
  repo: string,
  sha: string
): Promise<string> {
  const url = `/repos/${owner}/${repo}/git/blobs/${sha}`;
  if (cache) {
    const cachedBytes = await cache.getOrFetch(sha, async () => {
      const cachedRes = await client.getJson<{ encoding: string; content: string; sha: string }>(url);
      return cachedRes.encoding === 'base64'
        ? Buffer.from(cachedRes.content, 'base64')
        : Buffer.from(cachedRes.content, 'utf8');
    });
    // Skip empty cached data (stale from previous test runs)
    if (cachedBytes.length === 0) {
      const freshRes = await client.getJson<{ encoding: string; content: string; sha: string }>(url);
      const freshBytes = freshRes.encoding === 'base64'
        ? Buffer.from(freshRes.content, 'base64')
        : Buffer.from(freshRes.content, 'utf8');
      await cache.put(sha, freshBytes);
      return freshBytes.toString('utf8');
    }
    return cachedBytes.toString('utf8');
  }
  // Fallback: direct fetch without cache
  const res = await client.getJson<{ encoding: string; content: string; sha: string }>(url);
  const bytes = res.encoding === 'base64'
    ? Buffer.from(res.content, 'base64')
    : Buffer.from(res.content, 'utf8');
  return bytes.toString('utf8');
}
