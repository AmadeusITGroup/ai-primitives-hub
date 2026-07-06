/**
 * Intermediate base class for GitHub-backed repository adapters.
 *
 * `GitHubAdapter`, `AwesomeCopilotAdapter`, and `SkillsAdapter` are all backed by
 * GitHub and independently re-implemented the same concerns: URL parsing, the
 * GitHub authentication chain (explicit token → VS Code session → gh CLI), an
 * `https.get` wrapper with redirect/error handling, GitHub API + raw URL builders,
 * and a progressive chunked-fetch loop. This class hoists all of that so the three
 * adapters share one implementation.
 *
 * Hierarchy:
 *   RepositoryAdapter (abstract)
 *     └─ GitHubBackedAdapter (abstract)   ← this file
 *          ├─ GitHubAdapter
 *          ├─ AwesomeCopilotAdapter
 *          └─ SkillsAdapter
 */

import {
  exec,
} from 'node:child_process';
import * as https from 'node:https';
import {
  promisify,
} from 'node:util';
import * as vscode from 'vscode';
import {
  RegistrySource,
  ValidationResult,
} from '../types/registry';
import {
  Logger,
} from '../utils/logger';
import {
  RepositoryAdapter,
} from './repository-adapter';

const execAsync = promisify(exec);

/**
 * Response shape returned by the shared {@link GitHubBackedAdapter.httpGet} transport.
 */
interface HttpGetResult {
  status: number;
  statusMessage: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/**
 * Minimal GitHub release shape shared by adapters that read releases.
 */
export interface GitHubReleaseSummary {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- matches external API response shape
  tag_name?: string;
}

export abstract class GitHubBackedAdapter extends RepositoryAdapter {
  protected readonly logger: Logger;
  protected readonly apiBase = 'https://api.github.com';

  protected authToken: string | undefined;
  protected authMethod: 'vscode' | 'gh-cli' | 'explicit' | 'none' = 'none';
  protected readonly attemptedMethods: Set<string> = new Set();
  /**
   * Maximum authentication attempts to prevent infinite retry loops.
   * Tries: explicit token → VS Code auth → gh CLI
   */
  protected readonly maxAuthAttempts = 3;
  /**
   * Promise for an in-flight authentication attempt, so parallel requests wait
   * on the same attempt rather than racing to authenticate independently.
   */
  protected authPromise?: Promise<string | undefined>;

  /**
   * Maximum redirect depth to prevent infinite redirect loops.
   */
  protected readonly maxRedirects = 10;

  constructor(source: RegistrySource) {
    super(source);
    this.logger = Logger.getInstance();

    if (!this.isValidGitHubUrl(source.url)) {
      throw new Error(`Invalid GitHub URL: ${source.url}`);
    }
  }

  /**
   * Validate a GitHub URL (supports both HTTPS and SSH formats).
   * @param url
   */
  protected isValidGitHubUrl(url: string): boolean {
    // HTTPS format: https://github.com/owner/repo
    if (url.startsWith('https://')) {
      return url.includes('github.com');
    }
    // SSH format: git@github.com:owner/repo.git
    if (url.startsWith('git@')) {
      return url.includes('github.com:');
    }
    return false;
  }

  /**
   * Parse the source URL to extract owner and repo.
   */
  protected parseGitHubUrl(): { owner: string; repo: string } {
    const url = this.source.url.replace(/\.git$/, '');
    const match = url.match(/github\.com[/:]([^/]+)\/([^/]+)/);

    if (!match) {
      throw new Error(`Invalid GitHub URL format: ${this.source.url}`);
    }

    return {
      owner: match[1],
      repo: match[2]
    };
  }

  /**
   * Build a GitHub Contents API URL, optionally pinned to a ref/branch.
   * @param owner
   * @param repo
   * @param path
   * @param ref Optional branch/ref appended as ?ref=
   */
  protected buildContentsUrl(owner: string, repo: string, path: string, ref?: string): string {
    const base = `${this.apiBase}/repos/${owner}/${repo}/contents/${path}`;
    return ref ? `${base}?ref=${ref}` : base;
  }

  /**
   * Build a raw githubusercontent URL for a file at a branch.
   * @param owner
   * @param repo
   * @param branch
   * @param path
   */
  protected buildRawUrl(owner: string, repo: string, branch: string, path: string): string {
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
  }

  // ===== Authentication =====

  /**
   * Get an authentication token using the canonical fallback chain:
   * 1. Explicit token from source configuration
   * 2. VS Code GitHub authentication session
   * 3. gh CLI (`gh auth token`)
   * 4. No authentication
   *
   * Uses promise memoization so parallel requests share one authentication attempt.
   */
  protected async getAuthenticationToken(): Promise<string | undefined> {
    if (this.authToken !== undefined) {
      this.logger.debug(`[${this.type}] Using cached token (method: ${this.authMethod})`);
      return this.authToken;
    }

    if (this.authPromise) {
      this.logger.debug(`[${this.type}] Authentication in progress, waiting...`);
      return this.authPromise;
    }

    if (this.attemptedMethods.size >= this.maxAuthAttempts) {
      this.logger.error(`[${this.type}] Maximum authentication attempts (${this.maxAuthAttempts}) exceeded`);
      this.logger.error(`[${this.type}] Attempted methods: ${Array.from(this.attemptedMethods).join(', ')}`);
      return undefined;
    }

    this.authPromise = this.performAuthentication();

    try {
      const token = await this.authPromise;
      this.authToken = token;
      return token;
    } finally {
      this.authPromise = undefined;
    }
  }

  /**
   * Perform the actual authentication attempt through the fallback chain.
   * Separated from {@link getAuthenticationToken} to enable promise memoization.
   */
  protected async performAuthentication(): Promise<string | undefined> {
    this.logger.info(`[${this.type}] Attempting authentication...`);

    // 1. Explicit token from source configuration
    if (this.attemptedMethods.has('explicit')) {
      this.logger.debug(`[${this.type}] Skipping explicit token (already attempted)`);
    } else {
      const explicitToken = this.getAuthToken();
      if (explicitToken && explicitToken.trim().length > 0) {
        this.authMethod = 'explicit';
        this.logger.info(`[${this.type}] ✓ Using explicit token from configuration`);
        const token = explicitToken.trim();
        this.logger.debug(`[${this.type}] Token preview: ${token.substring(0, 8)}...`);
        return token;
      }
      this.logger.debug(`[${this.type}] No explicit token configured`);
    }

    // 2. VS Code GitHub authentication
    if (this.attemptedMethods.has('vscode')) {
      this.logger.debug(`[${this.type}] Skipping VSCode auth (already attempted)`);
    } else {
      const vscodeToken = await this.getVscodeSessionToken(true);
      if (vscodeToken) {
        this.authMethod = 'vscode';
        this.logger.info(`[${this.type}] ✓ Using VSCode GitHub authentication`);
        this.logger.debug(`[${this.type}] Token preview: ${vscodeToken.substring(0, 8)}...`);
        return vscodeToken;
      }
    }

    // 3. gh CLI authentication
    if (this.attemptedMethods.has('gh-cli')) {
      this.logger.debug(`[${this.type}] Skipping gh CLI (already attempted)`);
    } else {
      const cliToken = await this.getGhCliToken();
      if (cliToken) {
        this.authMethod = 'gh-cli';
        this.logger.info(`[${this.type}] ✓ Using gh CLI authentication`);
        this.logger.debug(`[${this.type}] Token preview: ${cliToken.substring(0, 8)}...`);
        return cliToken;
      }
    }

    // 4. No authentication available
    this.authMethod = 'none';
    if (this.attemptedMethods.size > 0) {
      this.logger.error(`[${this.type}] ✗ All authentication methods exhausted`);
      this.logger.error(`[${this.type}] Attempted methods: ${Array.from(this.attemptedMethods).join(', ')}`);
    } else {
      this.logger.warn(`[${this.type}] ✗ No authentication available - API rate limits will apply and private repos will be inaccessible`);
    }
    return undefined;
  }

  /**
   * Resolve a token from a VS Code GitHub authentication session.
   * @param createIfNone Whether to prompt the user to sign in when no session exists
   */
  protected async getVscodeSessionToken(createIfNone: boolean): Promise<string | undefined> {
    try {
      this.logger.debug(`[${this.type}] Trying VSCode GitHub authentication...`);
      const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone });
      if (session) {
        return session.accessToken;
      }
      this.logger.debug(`[${this.type}] VSCode auth session not found`);
    } catch (error) {
      this.logger.warn(`[${this.type}] VSCode auth failed: ${error}`);
    }
    return undefined;
  }

  /**
   * Resolve a token from the gh CLI (`gh auth token`).
   */
  protected async getGhCliToken(): Promise<string | undefined> {
    try {
      this.logger.debug(`[${this.type}] Trying gh CLI authentication...`);
      const { stdout } = await execAsync('gh auth token');
      const token = stdout.trim();
      if (token.length > 0) {
        return token;
      }
      this.logger.debug(`[${this.type}] gh CLI returned empty token`);
    } catch (error) {
      this.logger.warn(`[${this.type}] gh CLI auth failed: ${error}`);
    }
    return undefined;
  }

  /**
   * Invalidate the cached authentication token, forcing re-authentication with the
   * next method in the chain on the following request.
   * @param reason Optional reason for invalidation (e.g., "401 Unauthorized")
   */
  protected invalidateAuthCache(reason?: string): void {
    const previousMethod = this.authMethod;
    this.logger.info(`[${this.type}] Invalidating authentication cache${reason ? `: ${reason}` : ''}`);
    if (previousMethod !== 'none') {
      this.logger.debug(`[${this.type}] Previous auth method: ${previousMethod}`);
      this.attemptedMethods.add(previousMethod);
    }
    this.authToken = undefined;
    this.authMethod = 'none';
  }

  // ===== HTTP transport =====

  /**
   * Determine whether a URL points at a GitHub domain (auth is only attached to these).
   * @param urlString
   */
  protected isGitHubDomain(urlString: string): boolean {
    try {
      const urlObj = new URL(urlString);
      return urlObj.hostname.includes('github.com')
        || urlObj.hostname.includes('githubusercontent.com');
    } catch {
      return false;
    }
  }

  /**
   * Single `https.get` wrapper: resolves auth, attaches headers, follows 301/302
   * redirects (up to {@link maxRedirects}), and resolves with the raw status + body.
   * Does NOT throw on 4xx/5xx — callers interpret the status.
   * @param url
   * @param opts Optional extra request headers
   * @param opts.headers Additional headers merged over the defaults
   * @param redirectDepth
   */
  protected async httpGet(
    url: string,
    opts: { headers?: Record<string, string> } = {},
    redirectDepth = 0
  ): Promise<HttpGetResult> {
    if (redirectDepth >= this.maxRedirects) {
      this.logger.error(`[${this.type}] Maximum redirect depth (${this.maxRedirects}) exceeded`);
      throw new Error(`Maximum redirect depth (${this.maxRedirects}) exceeded`);
    }

    const headers: Record<string, string> = {
      'User-Agent': 'Prompt-Registry-VSCode-Extension',
      Accept: 'application/json',
      ...opts.headers
    };

    // Only attach auth for GitHub domains (redirects can point at third parties, e.g. S3).
    const token = await this.getAuthenticationToken();
    if (token && this.isGitHubDomain(url)) {
      headers.Authorization = `token ${token}`;
      this.logger.debug(`[${this.type}] Request to ${url} with auth (method: ${this.authMethod})`);
    } else {
      this.logger.debug(`[${this.type}] Request to ${url} WITHOUT auth`);
    }

    const sanitizedHeaders = { ...headers };
    if (sanitizedHeaders.Authorization) {
      sanitizedHeaders.Authorization = sanitizedHeaders.Authorization.substring(0, 15) + '...';
    }
    this.logger.debug(`[${this.type}] Request headers: ${JSON.stringify(sanitizedHeaders)}`);

    return new Promise<HttpGetResult>((resolve, reject) => {
      https.get(url, { headers }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const redirectUrl = res.headers.location;
          if (redirectUrl) {
            this.logger.debug(`[${this.type}] Following redirect (depth ${redirectDepth + 1}) to: ${redirectUrl}`);
            this.httpGet(redirectUrl, opts, redirectDepth + 1).then(resolve).catch(reject);
            return;
          }
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(Buffer.from(chunk));
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            statusMessage: res.statusMessage ?? '',
            headers: res.headers,
            body: Buffer.concat(chunks)
          });
        });
      }).on('error', (error) => {
        this.logger.error(`[${this.type}] Network error: ${error.message}`);
        reject(new Error(`GitHub request failed: ${error.message}`));
      });
    });
  }

  /**
   * Validate response Content-Type and detect HTML error pages returned for auth failures.
   * @param headers
   * @param body
   */
  protected validateResponse(
    headers: Record<string, string | string[] | undefined>,
    body: string
  ): { isValid: boolean; error?: string } {
    const contentType = (headers['content-type'] as string) || '';

    if (contentType.includes('text/html')) {
      this.logger.warn(`[${this.type}] Received HTML response instead of JSON (Content-Type: ${contentType})`);

      let htmlError = 'HTML error page received';
      const bodyMatch = body.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      if (bodyMatch) {
        const bodyText = bodyMatch[1]
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (bodyText.length > 0) {
          htmlError = bodyText.substring(0, 200);
        }
      }

      return {
        isValid: false,
        error: `Received HTML error page instead of JSON response. This typically indicates an authentication or access issue. Error: ${htmlError}`
      };
    }

    if (!contentType.includes('application/json') && !contentType.includes('application/octet-stream')) {
      this.logger.warn(`[${this.type}] Unexpected Content-Type: ${contentType}`);
      return {
        isValid: false,
        error: `Unexpected Content-Type: ${contentType}. Expected application/json.`
      };
    }

    return { isValid: true };
  }

  /**
   * Build a helpful error message for a failed GitHub API response.
   * @param status
   * @param statusMessage
   */
  protected buildApiErrorMessage(status: number, statusMessage: string): string {
    let errorMsg = `GitHub API error: ${status} ${statusMessage}`;
    switch (status) {
      case 404: {
        errorMsg += ' - Repository not found or not accessible. Check authentication.';
        break;
      }
      case 401: {
        errorMsg += ' - Authentication failed. Token may be invalid or expired.';
        if (this.attemptedMethods.size > 0) {
          errorMsg += ` Attempted methods: ${Array.from(this.attemptedMethods).join(', ')}`;
        }
        break;
      }
      case 403: {
        errorMsg += ' - Access forbidden. Token may lack required scopes (repo).';
        if (this.attemptedMethods.size > 0) {
          errorMsg += ` Attempted methods: ${Array.from(this.attemptedMethods).join(', ')}`;
        }
        break;
      }
      // No default
    }
    return errorMsg;
  }

  /**
   * GET a GitHub API endpoint and parse the JSON response.
   * On 401/403 it invalidates the auth cache and retries once with the next auth method;
   * on final failure it throws a helpful, status-specific error.
   * @param url
   * @param retryCount
   */
  protected async getJson<T>(url: string, retryCount = 0): Promise<T> {
    const res = await this.httpGet(url);
    const data = res.body.toString('utf8');

    if (res.status >= 400) {
      this.logger.error(`[${this.type}] HTTP ${res.status}: ${res.statusMessage}`);
      this.logger.error(`[${this.type}] URL: ${url}`);
      this.logger.error(`[${this.type}] Auth method: ${this.authMethod}`);
      this.logger.error(`[${this.type}] Response: ${data.substring(0, 500)}`);

      const { isValid, error } = this.validateResponse(res.headers, data);
      if (!isValid) {
        this.logger.error(`[${this.type}] ${error}`);
      }

      const isAuthError = res.status === 401 || res.status === 403;
      const canRetry = retryCount < this.maxAuthAttempts && this.attemptedMethods.size < this.maxAuthAttempts;
      if (isAuthError && canRetry) {
        this.logger.warn(`[${this.type}] Authentication error detected, invalidating cache and retrying...`);
        this.invalidateAuthCache(`${res.status} ${res.statusMessage}`);
        try {
          return await this.getJson<T>(url, retryCount + 1);
        } catch (retryError) {
          this.logger.error(`[${this.type}] Retry failed: ${retryError}`);
          // Fall through to the original response's error message below.
        }
      }

      // HTML error pages surface their own message; otherwise use the status switch.
      throw new Error(!isValid && error ? error : this.buildApiErrorMessage(res.status, res.statusMessage));
    }

    const validation = this.validateResponse(res.headers, data);
    if (!validation.isValid) {
      this.logger.error(`[${this.type}] ${validation.error}`);
      throw new Error(validation.error);
    }

    this.logger.debug(`[${this.type}] Response OK (${res.status})`);
    try {
      return JSON.parse(data) as T;
    } catch (error) {
      this.logger.error(`[${this.type}] Failed to parse response: ${error}`);
      throw new Error(`Failed to parse GitHub response as JSON: ${error}`);
    }
  }

  /**
   * GET a URL and return the response body as text. Throws on any non-2xx status.
   * @param url
   */
  protected async getText(url: string): Promise<string> {
    const res = await this.httpGet(url);
    if (res.status >= 400) {
      this.logger.error(`[${this.type}] HTTP ${res.status}: ${res.statusMessage}`);
      this.logger.error(`[${this.type}] URL: ${url}`);
      throw new Error(this.buildApiErrorMessage(res.status, res.statusMessage));
    }
    this.logger.debug(`[${this.type}] Response OK (${res.status}), ${res.body.length} bytes`);
    return res.body.toString('utf8');
  }

  /**
   * GET a URL and return the response body as a Buffer. For GitHub API asset URLs it
   * requests octet-stream so the raw file content is returned rather than JSON metadata.
   * @param url
   */
  protected async getBuffer(url: string): Promise<Buffer> {
    const headers: Record<string, string> = {};
    if (url.startsWith(this.apiBase)) {
      headers.Accept = 'application/octet-stream';
    }
    this.logger.debug(`[${this.type}] Downloading ${url} (auth method: ${this.authMethod})`);
    const res = await this.httpGet(url, { headers });
    if (res.status >= 400) {
      this.logger.error(`[${this.type}] Download failed: HTTP ${res.status}`);
      this.logger.error(`[${this.type}] URL: ${url}`);
      this.logger.error(`[${this.type}] Auth method: ${this.authMethod}`);
      throw new Error(`Download failed: ${res.status} ${res.statusMessage}`);
    }
    this.logger.debug(`[${this.type}] Download complete: ${res.body.length} bytes`);
    return res.body;
  }

  // ===== Progressive chunked fetch =====

  /**
   * Process `items` in bounded-size chunks, invoking `processItem` concurrently within
   * each chunk (`Promise.allSettled`, so one failure drops only that item). After each
   * chunk, `onPartial` receives a fresh snapshot array of everything accumulated so far,
   * letting the UI render progressively during large syncs.
   *
   * An empty input list never runs the loop, so `onPartial` is not invoked and the
   * result is `[]`.
   * @param items
   * @param chunkSize
   * @param processItem Maps an item to a result, or null/undefined to drop it
   * @param onPartial Optional callback invoked with a growing snapshot after each chunk
   */
  protected async processInChunks<TItem, TResult>(
    items: TItem[],
    chunkSize: number,
    processItem: (item: TItem) => Promise<TResult | null | undefined>,
    onPartial?: (accumulated: TResult[]) => void | Promise<void>
  ): Promise<TResult[]> {
    const size = Math.max(1, chunkSize);
    const accumulated: TResult[] = [];

    for (let i = 0; i < items.length; i += size) {
      const chunk = items.slice(i, i + size);
      const settled = await Promise.allSettled(chunk.map((item) => processItem(item)));

      for (const result of settled) {
        if (result.status === 'fulfilled' && result.value !== null && result.value !== undefined) {
          accumulated.push(result.value);
        }
      }

      await onPartial?.([...accumulated]);
    }

    return accumulated;
  }

  // ===== Shared validation =====

  /**
   * GitHub-style repository validation: confirms the repo is accessible and reports the
   * release count. Subclasses either use this directly (default {@link validate}) or call
   * it as a base check before adding source-type-specific validation.
   */
  protected async validateGitHubRepository(): Promise<ValidationResult> {
    try {
      const { owner, repo } = this.parseGitHubUrl();
      await this.getJson(`${this.apiBase}/repos/${owner}/${repo}`);

      const releases = await this.getJson<GitHubReleaseSummary[]>(
        `${this.apiBase}/repos/${owner}/${repo}/releases`
      );

      return {
        valid: true,
        errors: [],
        warnings: releases.length === 0 ? ['No releases found in repository'] : [],
        bundlesFound: releases.length
      };
    } catch (error) {
      return {
        valid: false,
        errors: [`GitHub validation failed: ${error}`],
        warnings: [],
        bundlesFound: 0
      };
    }
  }

  /**
   * Default validation delegates to {@link validateGitHubRepository}. Subclasses with
   * source-type-specific structure (collections, skills) override this.
   */
  public async validate(): Promise<ValidationResult> {
    return this.validateGitHubRepository();
  }
}
