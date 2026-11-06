/**
 * Download a GitHub repository as a zipball into a fresh temporary directory.
 * No Git process runs and nothing in the archive is executed; the caller disposes the directory.
 * @module governance/github-repository-snapshot
 */
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  GitHubApi,
  GitHubRepositoryTarget,
} from '@ai-primitives-hub/core';
import {
  ZipBundleExtractor,
} from '../extractors/zip-bundle-extractor';

export interface RepositorySnapshot {
  dir: string;
  dispose(): Promise<void>;
}

/**
 * Fetch the repository at `ref` (default branch when omitted) and write its files to disk.
 * @param api Source-scoped GitHub API, so the source's own authentication is used.
 * @param target Repository to download.
 * @param ref Branch, tag or commit.
 */
export async function downloadGitHubRepository(
  api: GitHubApi, target: Pick<GitHubRepositoryTarget, 'owner' | 'repository'>, ref?: string
): Promise<RepositorySnapshot> {
  const suffix = ref === undefined ? '' : `/${ref.split('/').map((part) => encodeURIComponent(part)).join('/')}`;
  // The client asks API URLs for octet-stream (release assets); the zipball endpoint answers that with HTTP 415.
  const archive = await api.download(`/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}/zipball${suffix}`,
    { Accept: 'application/vnd.github+json' });
  // The extractor rejects absolute and parent-relative entry paths.
  const files = await new ZipBundleExtractor().extract(archive);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-primitives-hub-source-'));
  const dispose = () => rm(dir, { recursive: true, force: true });
  try {
    for (const [entry, bytes] of files) {
      // GitHub nests every entry under one "<owner>-<repo>-<sha>/" folder.
      const relative = entry.slice(entry.indexOf('/') + 1);
      if (!entry.includes('/') || relative === '') {
        continue;
      }
      const file = path.join(dir, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
    }
  } catch (error) {
    await dispose();
    throw error;
  }
  return { dir, dispose };
}
