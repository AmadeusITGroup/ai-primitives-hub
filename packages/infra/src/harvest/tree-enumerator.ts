/**
 * Git tree enumerator.
 *
 * Answers "what primitive-candidate files live in this repo at this ref?"
 * in one recursive tree call. Returns each candidate with its blob sha so
 * downstream code can fetch + cache by sha without hitting /contents/.
 *
 * GitHub returns `truncated: true` when a tree has more than ~100k
 * entries; we throw a descriptive error in that case so the caller can
 * decide whether to walk subtrees. None of the primitive-registry hubs we
 * expect to harvest come close to that threshold, but the error must be
 * explicit rather than silent.
 */

import type {
  GitHubClient,
} from '../github/client';
import type {
  EtagStore,
} from '../github/etag-store';

export interface TreeEntry {
  path: string;
  blobSha: string;
  size: number;
}

export interface EnumerateOptions {
  owner: string;
  repo: string;
  /** Branch, tag or commit sha. */
  ref: string;
  /** Optional path prefix (e.g. "collections/") for awesome-copilot sources. */
  pathPrefix?: string;
  /** Injectable filter; defaults to `isPrimitiveCandidatePath`. */
  filter?: (path: string) => boolean;
  /**
   * Optional ETag store; when provided, the /commits/:ref lookup becomes
   * conditional. On 304 we replay the cached sha and skip the whole
   * tree call (caller only needed the sha for smart-rebuild anyway).
   */
  etagStore?: EtagStore;
  /**
   * Drop entries whose blob size exceeds this many bytes. Default 256 KiB —
   * safe ceiling for a single primitive file. Guards against accidentally
   * pulling a huge doc/binary in through the candidate filter.
   */
  maxFileSize?: number;
}

export interface EnumerateShaOnlyResult {
  kind: 'sha-only';
  commitSha: string;
}

export interface EnumerateFullResult {
  kind: 'full';
  commitSha: string;
  candidates: TreeEntry[];
}

export interface EnumerateResult {
  commitSha: string;
  candidates: TreeEntry[];
}

interface CommitResponse {
  sha: string;
}

interface TreeResponse {
  sha: string;
  truncated: boolean;
  tree: { path: string; type: string; sha: string; size?: number }[];
}

/**
 * ETag-aware commit sha lookup. Returns the current commit sha for
 * owner/repo@ref, reusing the cached value on 304. This is the cheap
 * warm-path check the harvester uses to decide whether to re-harvest.
 * @param client - Authorised GitHub API client.
 * @param opts - Owner/repo/ref + etag store.
 * @param opts.owner
 * @param opts.repo
 * @param opts.ref
 * @param opts.etagStore
 */
export async function resolveCommitSha(
  client: GitHubClient,
  opts: { owner: string; repo: string; ref: string; etagStore?: EtagStore }
): Promise<string> {
  const urlPath = `/repos/${opts.owner}/${opts.repo}/commits/${encodeURIComponent(opts.ref)}`;
  if (opts.etagStore) {
    const cached = opts.etagStore.getEntry(urlPath);
    const result = await client.getJsonWithEtag<CommitResponse>(urlPath, cached?.etag);
    if (result.status === 'notModified' && cached?.value) {
      return (cached.value as CommitResponse).sha;
    }
    if (result.status === 'ok') {
      if (result.etag) {
        await opts.etagStore.set(urlPath, result.etag, { sha: result.value.sha });
      }
      return result.value.sha;
    }
    // 304 without cached value -> fall through to an unconditional fetch.
  }
  const commit = await client.getJson<CommitResponse>(urlPath);
  return commit.sha;
}

/**
 * Resolve ref -> commit sha, fetch the recursive tree, filter to primitive
 * candidates.
 * @param client - Authorised GitHub API client.
 * @param opts - Owner/repo/ref plus optional path prefix + filter.
 */
export async function enumerateRepoTree(
  client: GitHubClient,
  opts: EnumerateOptions
): Promise<EnumerateResult> {
  const {
    owner, repo, ref, pathPrefix,
    filter = isPrimitiveCandidatePath,
    maxFileSize = 256 * 1024
  } = opts;
  const commit = await client.getJson<CommitResponse>(
    `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`
  );
  const tree = await client.getJson<TreeResponse>(
    `/repos/${owner}/${repo}/git/trees/${commit.sha}?recursive=1`
  );
  if (tree.truncated) {
    throw new Error(`tree truncated for ${owner}/${repo}@${commit.sha}: too many entries`);
  }
  const prefix = pathPrefix ?? '';
  const candidates: TreeEntry[] = [];
  for (const e of tree.tree) {
    if (e.type !== 'blob') {
      continue;
    }
    if (prefix && !e.path.startsWith(prefix)) {
      continue;
    }
    if (!filter(e.path)) {
      continue;
    }
    const size = e.size ?? 0;
    if (size > maxFileSize) {
      continue; // silently drop; the filter is conservative and users can raise maxFileSize
    }
    candidates.push({ path: e.path, blobSha: e.sha, size });
  }
  return { commitSha: commit.sha, candidates };
}

/**
 * Conservative primitive-candidate filter. Matches the heuristics the
 * library extractor already understands (prompt.md, instructions.md,
 * chatmode.md, agent.md, SKILL.md, mcp.json, collection.yml, .vscode/mcp.json).
 * Kept intentionally generous on the recall side — filtering happens on
 * extraction (frontmatter + content heuristics) rather than on file name.
 * @param p - Path to check.
 */
export function isPrimitiveCandidatePath(p: string): boolean {
  const lower = p.toLowerCase();
  // Noise filters: dependency trees, build outputs, test fixtures, and any
  // path under a dot-directory (.github, .vscode — except .vscode/mcp.json
  // which is handled below). These are pure false-positive eliminators;
  // the rest of the filter remains generous on recall.
  if (lower.includes('/node_modules/') || lower.startsWith('node_modules/')) {
    return false;
  }
  if (lower.startsWith('dist/') || lower.includes('/dist/')) {
    return false;
  }
  if (lower.startsWith('build/') || lower.includes('/build/')) {
    return false;
  }
  // Anything under .github/ is project infra (workflows, issue templates),
  // never a primitive.
  if (lower.startsWith('.github/')) {
    return false;
  }
  if (lower.endsWith('.prompt.md')) {
    return true;
  }
  if (lower.endsWith('.instructions.md')) {
    return true;
  }
  if (lower.endsWith('.chatmode.md')) {
    return true;
  }
  if (lower.endsWith('.agent.md') || lower.endsWith('/agent.md')) {
    return true;
  }
  if (lower.endsWith('skill.md') || lower.endsWith('/skill.md')) {
    return true;
  }
  if (lower.endsWith('mcp.json') || lower.endsWith('/mcp.json')) {
    return true;
  }
  if (lower.endsWith('.vscode/mcp.json')) {
    return true;
  }
  if (lower.endsWith('collection.yml') || lower.endsWith('/collection.yml')
    || lower.endsWith('collection.yaml') || lower.endsWith('/collection.yaml')) {
    return true;
  }
  if (lower.endsWith('deployment-manifest.yml') || lower.endsWith('/deployment-manifest.yml')
    || lower.endsWith('deployment-manifest.yaml') || lower.endsWith('/deployment-manifest.yaml')) {
    return true;
  }
  return false;
}
