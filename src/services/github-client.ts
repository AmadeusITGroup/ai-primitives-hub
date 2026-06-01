import {
  exec,
} from 'node:child_process';
import {
  promisify,
} from 'node:util';
import {
  Octokit,
} from '@octokit/rest';
import * as vscode from 'vscode';
import {
  CONCURRENCY_CONSTANTS,
} from '../utils/constants';
import {
  GitHubAuthError,
  GitHubClientError,
  GitHubNotFoundError,
  GitHubRateLimitError,
} from './github-client-errors';

const execAsync = promisify(exec);

export interface GitHubContentItem {
  name: string;
  path: string;
  type: 'file' | 'dir';
  // eslint-disable-next-line @typescript-eslint/naming-convention -- mirrors GitHub API JSON field names
  download_url?: string;
  sha?: string;
  size?: number;
}

export interface GitHubRelease {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- mirrors GitHub API JSON field names
  tag_name: string;
  name: string;
  body: string;
  assets: GitHubReleaseAsset[];
  // eslint-disable-next-line @typescript-eslint/naming-convention -- mirrors GitHub API JSON field names
  published_at: string;
}

export interface GitHubReleaseAsset {
  name: string;
  // eslint-disable-next-line @typescript-eslint/naming-convention -- mirrors GitHub API JSON field names
  browser_download_url: string;
  url: string;
  size: number;
}

export interface TreeEntry {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

export interface RepoMetadata {
  name: string;
  description: string;
  updatedAt: string;
}

export interface GitHubClientOptions {
  sourceUrl: string;
  explicitToken?: string;
  scopes?: string[];
}

export class GitHubClient {
  private static readonly MAX_REDIRECTS = 10;

  public readonly owner: string;
  public readonly repo: string;
  private octokit: Octokit;
  private authResolved = false;
  private authToken: string | undefined;
  private readonly explicitToken: string | undefined;
  private readonly scopes: string[];
  private authMethod: 'vscode' | 'explicit' | 'gh-cli' | 'none' = 'none';

  constructor(options: GitHubClientOptions) {
    const parsed = GitHubClient.parseGitHubUrl(options.sourceUrl);
    this.owner = parsed.owner;
    this.repo = parsed.repo;
    this.explicitToken = options.explicitToken;
    this.scopes = options.scopes ?? ['repo'];
    this.octokit = new Octokit();
  }

  private async execGhAuthToken(): Promise<string> {
    const { stdout } = await execAsync('gh auth token');
    return stdout.trim();
  }

  private async fetchBuffer(url: string, depth = 0): Promise<Buffer> {
    if (depth >= GitHubClient.MAX_REDIRECTS) {
      throw new GitHubClientError(`Too many redirects (max ${GitHubClient.MAX_REDIRECTS})`);
    }
    const https = await import('node:https');
    const headers: Record<string, string> = {
      'User-Agent': 'Prompt-Registry-VSCode-Extension'
    };
    if (this.authToken && this.isGitHubDomain(url)) {
      headers.Authorization = `token ${this.authToken}`;
    }

    return new Promise((resolve, reject) => {
      https.get(url, { headers }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const redirectUrl = res.headers.location;
          if (redirectUrl) {
            this.fetchBuffer(redirectUrl, depth + 1).then(resolve).catch(reject);
            return;
          }
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new GitHubClientError(`Download failed: ${res.statusCode}`, res.statusCode));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', (err) => reject(new GitHubClientError(`Download failed: ${err.message}`)));
    });
  }

  private isGitHubDomain(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.hostname.includes('github.com') || parsed.hostname.includes('githubusercontent.com');
    } catch {
      return false;
    }
  }

  private async ensureAuthenticated(): Promise<void> {
    if (!this.authResolved) {
      await this.authenticate();
    }
  }

  private handleApiError(error: any, path?: string): never {
    if (error.status === 404) {
      throw new GitHubNotFoundError(this.owner, this.repo, path);
    }
    if (error.status === 401 || error.status === 403) {
      const rateLimitReset = error.response?.headers?.['x-ratelimit-reset'];
      if (rateLimitReset && error.status === 403) {
        throw new GitHubRateLimitError(new Date(Number(rateLimitReset) * 1000));
      }
      throw new GitHubAuthError(error.message, error.status);
    }
    throw new GitHubClientError(error.message, error.status);
  }

  private static parseGitHubUrl(url: string): { owner: string; repo: string } {
    const cleaned = url.replace(/\.git$/, '');
    const match = cleaned.match(/github\.com[/:]([^/]+)\/([^/]+)/);

    if (!match) {
      throw new GitHubClientError(`Invalid GitHub URL: ${url}`);
    }

    return { owner: match[1], repo: match[2] };
  }

  public getAuthMethod(): string {
    return this.authMethod;
  }

  public async authenticate(): Promise<void> {
    if (this.authResolved) {
      return;
    }

    // 1. VS Code GitHub authentication (primary)
    try {
      const session = await vscode.authentication.getSession('github', this.scopes, { createIfNone: false });
      if (session) {
        this.authToken = session.accessToken;
        this.authMethod = 'vscode';
        this.octokit = new Octokit({ auth: this.authToken });
        this.authResolved = true;
        return;
      }
    } catch {
      // Fall through to next method
    }

    // 2. Explicit token from source configuration
    if (this.explicitToken && this.explicitToken.trim().length > 0) {
      this.authToken = this.explicitToken.trim();
      this.authMethod = 'explicit';
      this.octokit = new Octokit({ auth: this.authToken });
      this.authResolved = true;
      return;
    }

    // 3. GitHub CLI
    try {
      const token = await this.execGhAuthToken();
      if (token && token.trim().length > 0) {
        this.authToken = token.trim();
        this.authMethod = 'gh-cli';
        this.octokit = new Octokit({ auth: this.authToken });
        this.authResolved = true;
        return;
      }
    } catch {
      // Fall through to unauthenticated
    }

    // 4. No authentication
    this.authMethod = 'none';
    this.octokit = new Octokit();
    this.authResolved = true;
  }

  public async forceReauthenticate(): Promise<void> {
    this.authResolved = false;
    this.authToken = undefined;
    this.authMethod = 'none';

    const session = await vscode.authentication.getSession('github', this.scopes, { forceNewSession: true });
    if (session) {
      this.authToken = session.accessToken;
      this.authMethod = 'vscode';
      this.octokit = new Octokit({ auth: this.authToken });
      this.authResolved = true;
    }
  }

  public async getContents(path: string, ref?: string): Promise<GitHubContentItem[]> {
    await this.ensureAuthenticated();
    try {
      const response = await this.octokit.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path,
        ...(ref ? { ref } : {})
      });
      const data = Array.isArray(response.data) ? response.data : [response.data];
      return data.map((item: any) => ({
        name: item.name,
        path: item.path,
        type: item.type as 'file' | 'dir',
        download_url: item.download_url ?? undefined,
        sha: item.sha,
        size: item.size
      }));
    } catch (error: any) {
      this.handleApiError(error, path);
    }
  }

  public async getContentsRecursive(path: string, ref?: string): Promise<GitHubContentItem[]> {
    await this.ensureAuthenticated();
    const items: GitHubContentItem[] = [];
    const queue = [path];

    while (queue.length > 0) {
      const currentPath = queue.shift()!;
      const contents = await this.getContents(currentPath, ref);
      for (const item of contents) {
        items.push(item);
        if (item.type === 'dir') {
          queue.push(item.path);
        }
      }
    }

    return items;
  }

  public async getFileContent(path: string, ref?: string): Promise<Buffer> {
    await this.ensureAuthenticated();
    try {
      const response = await this.octokit.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path,
        ...(ref ? { ref } : {})
      });
      const data = response.data as any;
      if (data.content && data.encoding === 'base64') {
        return Buffer.from(data.content, 'base64');
      }
      throw new GitHubClientError(`Unexpected content format for ${path}`);
    } catch (error: any) {
      if (error instanceof GitHubClientError) {
        throw error;
      }
      this.handleApiError(error, path);
    }
  }

  public async listReleases(): Promise<GitHubRelease[]> {
    await this.ensureAuthenticated();
    try {
      const response = await this.octokit.repos.listReleases({
        owner: this.owner,
        repo: this.repo,
        per_page: 100
      });
      return response.data as unknown as GitHubRelease[];
    } catch (error: any) {
      this.handleApiError(error);
    }
  }

  public async getReleaseByTag(tag: string): Promise<GitHubRelease> {
    await this.ensureAuthenticated();
    try {
      const response = await this.octokit.repos.getReleaseByTag({
        owner: this.owner,
        repo: this.repo,
        tag
      });
      return response.data as unknown as GitHubRelease;
    } catch (error: any) {
      this.handleApiError(error);
    }
  }

  public async getTree(sha: string, recursive?: boolean): Promise<TreeEntry[]> {
    await this.ensureAuthenticated();
    try {
      const response = await this.octokit.git.getTree({
        owner: this.owner,
        repo: this.repo,
        tree_sha: sha,
        recursive: recursive ? 'true' : undefined
      });
      return response.data.tree.map((entry: any) => ({
        path: entry.path,
        type: entry.type,
        sha: entry.sha,
        size: entry.size
      }));
    } catch (error: any) {
      this.handleApiError(error);
    }
  }

  public async getRepository(): Promise<RepoMetadata> {
    await this.ensureAuthenticated();
    try {
      const response = await this.octokit.repos.get({
        owner: this.owner,
        repo: this.repo
      });
      return {
        name: response.data.name,
        description: response.data.description || '',
        updatedAt: response.data.updated_at
      };
    } catch (error: any) {
      this.handleApiError(error);
    }
  }

  public async downloadAsset(url: string): Promise<Buffer> {
    await this.ensureAuthenticated();

    // If it's a GitHub API asset URL, use octokit
    const assetIdMatch = url.match(/\/releases\/assets\/(\d+)$/);
    if (assetIdMatch) {
      const response = await this.octokit.repos.getReleaseAsset({
        owner: this.owner,
        repo: this.repo,
        asset_id: Number(assetIdMatch[1]),
        headers: { accept: 'application/octet-stream' }
      });
      const data = response.data as unknown;
      if (data instanceof ArrayBuffer) {
        return Buffer.from(data);
      }
      if (Buffer.isBuffer(data)) {
        return data;
      }
      // Fallback for string responses (binary encoding preserves byte values)
      return Buffer.from(data as string, 'binary');
    }

    // For other URLs (e.g., browser_download_url), use direct fetch
    return this.fetchBuffer(url);
  }

  public async downloadAssetsParallel(
    urls: string[],
    concurrency?: number
  ): Promise<Map<string, Buffer>> {
    const limit = concurrency ?? CONCURRENCY_CONSTANTS.MANIFEST_DOWNLOAD_CONCURRENCY;
    const results = new Map<string, Buffer>();

    for (let i = 0; i < urls.length; i += limit) {
      const batch = urls.slice(i, i + limit);
      const batchResults = await Promise.allSettled(
        batch.map(async (url) => {
          const buffer = await this.downloadAsset(url);
          return { url, buffer };
        })
      );

      for (const [j, result] of batchResults.entries()) {
        if (result.status === 'fulfilled') {
          results.set(result.value.url, result.value.buffer);
        } else {
          console.warn(`[GitHubClient] Download failed for ${batch[j]}: ${result.reason?.message || result.reason}`);
        }
      }
    }

    return results;
  }

  public async downloadRawContent(url: string): Promise<Buffer> {
    await this.ensureAuthenticated();
    return this.fetchBuffer(url);
  }
}
