/**
 * APM source adapter — discovers `apm.yml`-described packages in a GitHub
 * repository and installs them via the third-party `apm` CLI.
 *
 * Ported from `src/adapters/apm-adapter.ts` (plus the manifest-mapping
 * logic from `src/adapters/apm-package-mapper.ts`, inlined here rather
 * than kept as a separate class, matching `AwesomeCopilotAdapter`'s
 * self-contained style). All GitHub HTTP now goes through the injected
 * `GitHubApi` port; all subprocess execution goes through the new
 * `ProcessRunner` port; all disk I/O for the install/archive step goes
 * through the `FileSystem` port. Several deliberate deviations from `main`:
 *
 * - No VS Code-specific runtime auto-install UX (`ApmRuntimeManager`'s
 *   `setupRuntime`/`installLocalUv`/`showInstallInstructions`, all of which
 *   depend on `vscode.window`/`vscode.workspace`). Headless infra can't pop
 *   up progress notifications or open an editor tab; it simply reports
 *   whether the runtime is available and lets the caller (eventually,
 *   `apps/vscode-extension`, per migration plan §6.3) decide how to guide
 *   the user through installing it. Runtime *detection* is kept, trimmed to
 *   exactly what this adapter's own control flow reads (`installed`,
 *   `uvxAvailable`, `version`) — the doctor-style diagnostics
 *   (`installMethod`, `pythonVersion`, executable `path`) were never read
 *   by `ApmAdapter` itself, only surfaced for UI display elsewhere.
 * - No VS Code GitHub-authentication-session strategy in the token chain
 *   (same reasoning as `infra/auth/gh-cli-token-provider.ts`'s module doc:
 *   that strategy belongs in `apps/vscode-extension`). Callers inject
 *   whichever `TokenProvider` fits their delivery context; it is used only
 *   to set `GITHUB_TOKEN` for the `apm install` subprocess (GitHub API
 *   reads go through `GitHubApi`, which resolves its own auth).
 * - `apmPackageRef` is recovered by parsing `Bundle.downloadUrl` (which
 *   already encodes owner/repo/subpath) instead of an ad hoc
 *   `(bundle as ApmBundle).apmPackageRef` field that doesn't exist on
 *   `Bundle`'s real type — same fix as `AwesomeCopilotAdapter`'s
 *   `collectionFile` recovery.
 * - `ApmPackageMapper.buildManifestUrl` hardcoded the `main` branch
 *   regardless of the adapter's configured branch; the ported version uses
 *   the adapter's actual `branch`.
 * - Dropped `ApmCliWrapper.validateTargetPath`: the target directory is
 *   always one this adapter generates itself (never user/repo-controlled),
 *   so the check could never fail in practice. `validatePackageRef` is
 *   kept — the package ref *is* derived from repo-controlled path segments.
 * - Dropped the unused `enableVirtualPackages`/`cacheTtl` config knobs
 *   (never read anywhere in the original class); the bundle-list cache TTL
 *   is a fixed constant, matching `AwesomeCopilotAdapter`.
 * @module adapters/apm-adapter
 */
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  Bundle,
  Clock,
  FileSystem,
  GitHubApi,
  ProcessRunner,
  RegistrySource,
  SourceMetadata,
  TokenProvider,
  ValidationResult,
} from '@ai-primitives-hub/core';
import archiver from 'archiver';
import * as yaml from 'js-yaml';
import {
  BaseSourceAdapter,
} from './base-source-adapter';

const GITHUB_URL_PATTERN = /^https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)(\.git)?$/;
const DEFAULT_BRANCH = 'main';
const BUNDLE_CACHE_TTL_MS = 5 * 60 * 1000;
const RUNTIME_STATUS_CACHE_TTL_MS = 60 * 1000;
const VERSION_CHECK_TIMEOUT_MS = 10 * 1000;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ID_LENGTH = 200;
const MAX_VERSION_LENGTH = 100;
const MAX_SCAN_DEPTH = 5;

const PROMPT_EXTENSIONS = ['.prompt.md', '.instructions.md', '.chatmode.md', '.agent.md'];
const SKIP_DIRECTORIES = ['node_modules', 'apm_modules', '.git', 'dist', 'build'];

const ENV_TAG_MAP: Record<string, string> = {
  azure: 'cloud',
  aws: 'cloud',
  gcp: 'cloud',
  frontend: 'web',
  backend: 'server',
  devops: 'infrastructure',
  testing: 'testing',
  security: 'security'
};

/** Security: only allow alphanumeric, hyphens, underscores, dots, and forward slashes. */
const VALID_PACKAGE_REF_PATTERN = /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_./-]+$/;

const DANGEROUS_PACKAGE_REF_PATTERNS = [
  /[;&|`$(){}[\]<>]/, // Shell metacharacters
  /\n|\r/, // Newlines
  /^https?:/, // URLs
  /^\//, // Absolute paths (Unix)
  /^[A-Za-z]:/, // Absolute paths (Windows)
  /\.\./ // Path traversal
];

interface ApmManifest {
  name: string;
  version?: string;
  description?: string;
  author?: string;
  tags?: string[];
  license?: string;
  dependencies?: {
    apm?: string[];
    mcp?: string[];
  };
}

/** Only `path` is read: the manifest-discovery filter matches on path shape alone, mirroring `main`'s behavior. */
interface GitTreeEntry {
  path: string;
}

interface ApmRuntimeStatus {
  installed: boolean;
  uvxAvailable: boolean;
  version?: string;
}

interface PackageContext {
  owner: string;
  repo: string;
  path: string;
}

function inferEnvironments(tags?: string[]): string[] {
  if (!tags || tags.length === 0) {
    return ['general'];
  }
  const environments = new Set<string>();
  for (const tag of tags) {
    const environment = ENV_TAG_MAP[tag.toLowerCase()];
    if (environment) {
      environments.add(environment);
    }
  }
  return environments.size > 0 ? [...environments] : ['general'];
}

function mapDependencies(apmDeps?: string[]): Bundle['dependencies'] {
  if (!apmDeps || apmDeps.length === 0) {
    return [];
  }
  return apmDeps.map((dep) => ({ bundleId: dep, versionRange: '*', optional: false }));
}

function formatDependencyCount(deps?: string[]): string {
  const count = deps?.length ?? 0;
  if (count === 0) {
    return 'No dependencies';
  }
  return `${count} dependenc${count === 1 ? 'y' : 'ies'}`;
}

function titleCase(value: string): string {
  return value
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function detectFileType(filename: string): 'prompt' | 'instructions' | 'chatmode' | 'agent' {
  if (filename.endsWith('.instructions.md')) {
    return 'instructions';
  }
  if (filename.endsWith('.chatmode.md')) {
    return 'chatmode';
  }
  if (filename.endsWith('.agent.md')) {
    return 'agent';
  }
  return 'prompt';
}

/**
 * Security: prevents injection via `apm --version`'s output before it's used as a Bundle field.
 * @param version - Raw stdout from `apm --version`.
 */
function sanitizeVersion(version: string): string {
  const truncated = version.substring(0, MAX_VERSION_LENGTH);
  const withoutHtmlChars = truncated.replace(/[<>'"&]/g, '');
  // eslint-disable-next-line no-control-regex -- control characters are intentionally matched
  return withoutHtmlChars.replace(/[\u0000-\u001F\u007F]/g, '').trim();
}

/**
 * Security: prevents command/YAML injection through a maliciously crafted repository tree.
 * @param ref - Candidate package reference (e.g. `owner/repo` or `owner/repo/path`).
 */
function isValidPackageRef(ref: string): boolean {
  if (!ref || ref.trim().length === 0) {
    return false;
  }
  if (DANGEROUS_PACKAGE_REF_PATTERNS.some((pattern) => pattern.test(ref))) {
    return false;
  }
  if (!VALID_PACKAGE_REF_PATTERN.test(ref) || ref.endsWith('/')) {
    return false;
  }
  return ref.includes('/') && !ref.startsWith('/');
}

export class ApmAdapter extends BaseSourceAdapter {
  public readonly type = 'apm';

  private readonly branch: string;
  private bundleCache: { bundles: Bundle[]; cachedAtMs: number } | undefined;
  private runtimeStatusCache: { status: ApmRuntimeStatus; cachedAtMs: number } | undefined;
  private tempDirSequence = 0;

  public constructor(
    source: RegistrySource,
    private readonly githubApi: GitHubApi,
    private readonly processRunner: ProcessRunner,
    private readonly fs: FileSystem,
    private readonly clock: Clock,
    private readonly tokenProvider?: TokenProvider
  ) {
    super(source);
    if (!GITHUB_URL_PATTERN.test(source.url)) {
      throw new Error(`Invalid GitHub URL: ${source.url}. Use format: https://github.com/owner/repo`);
    }
    this.branch = source.config?.branch ?? DEFAULT_BRANCH;
  }

  private parseGitHubUrl(): { owner: string; repo: string } {
    const match = GITHUB_URL_PATTERN.exec(this.source.url);
    if (!match) {
      throw new Error(`Invalid GitHub URL: ${this.source.url}`);
    }
    return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
  }

  private buildManifestUrl(context: PackageContext): string {
    const pathPrefix = context.path ? `${context.path}/` : '';
    return `https://raw.githubusercontent.com/${context.owner}/${context.repo}/${this.branch}/${pathPrefix}apm.yml`;
  }

  private packageRefFromDownloadUrl(downloadUrl: string): string {
    const { owner, repo } = this.parseGitHubUrl();
    const prefix = `https://raw.githubusercontent.com/${owner}/${repo}/${this.branch}/`;
    const suffix = '/apm.yml';
    if (!downloadUrl.startsWith(prefix) || !downloadUrl.endsWith(suffix)) {
      throw new Error(`Cannot determine package reference from downloadUrl: ${downloadUrl}`);
    }
    const subpath = downloadUrl.slice(prefix.length, -suffix.length);
    return subpath ? `${owner}/${repo}/${subpath}` : `${owner}/${repo}`;
  }

  // --- Bundle listing -------------------------------------------------

  private generateBundleId(manifest: ApmManifest, context: PackageContext): string {
    const sanitizedName = manifest.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();
    return `${context.owner}-${sanitizedName}`.substring(0, MAX_ID_LENGTH);
  }

  private buildBundle(manifest: ApmManifest, context: PackageContext): Bundle {
    const packageRef = context.path ? `${context.owner}/${context.repo}/${context.path}` : `${context.owner}/${context.repo}`;
    const tags = manifest.tags ? [...manifest.tags] : [];
    if (!tags.includes('apm')) {
      tags.push('apm');
    }
    const manifestUrl = this.buildManifestUrl(context);

    return {
      id: this.generateBundleId(manifest, context),
      name: manifest.name,
      version: manifest.version ?? '1.0.0',
      description: manifest.description ?? `APM package from ${packageRef}`,
      author: manifest.author ?? context.owner,
      sourceId: this.source.id,
      environments: inferEnvironments(manifest.tags),
      tags,
      lastUpdated: this.clock.nowIso(),
      size: formatDependencyCount(manifest.dependencies?.apm),
      dependencies: mapDependencies(manifest.dependencies?.apm),
      license: manifest.license ?? 'MIT',
      manifestUrl,
      downloadUrl: manifestUrl,
      repository: `https://github.com/${context.owner}/${context.repo}`
    };
  }

  private async fetchGitTree(owner: string, repo: string): Promise<GitTreeEntry[]> {
    try {
      const result = await this.githubApi.getJson<{ tree?: GitTreeEntry[] }>(
        `/repos/${owner}/${repo}/git/trees/${this.branch}?recursive=1`
      );
      return result.tree ?? [];
    } catch {
      return [];
    }
  }

  private async fetchApmManifest(owner: string, repo: string, subpath: string): Promise<ApmManifest | undefined> {
    const pathPrefix = subpath ? `${subpath}/` : '';
    try {
      const content = await this.githubApi.getText(
        `https://raw.githubusercontent.com/${owner}/${repo}/${this.branch}/${pathPrefix}apm.yml`
      );
      return yaml.load(content) as ApmManifest;
    } catch {
      return undefined;
    }
  }

  /**
   * Root `apm.yml`, plus one immediate-subdirectory `apm.yml` per non-skipped directory.
   * @param tree - Flattened git tree entries (recursive listing) for the repository.
   */
  private findManifestPaths(tree: GitTreeEntry[]): string[] {
    return tree
      .filter((item) => {
        if (item.path === 'apm.yml') {
          return true;
        }
        const parts = item.path.split('/');
        return parts.length === 2 && parts[1] === 'apm.yml' && !SKIP_DIRECTORIES.includes(parts[0]);
      })
      .map((item) => item.path);
  }

  private async fetchFromGitHub(): Promise<Bundle[]> {
    const { owner, repo } = this.parseGitHubUrl();
    const tree = await this.fetchGitTree(owner, repo);
    const manifestPaths = this.findManifestPaths(tree);

    const bundles: Bundle[] = [];
    for (const manifestPath of manifestPaths) {
      const dir = path.dirname(manifestPath);
      const subpath = dir === '.' ? '' : dir;
      const manifest = await this.fetchApmManifest(owner, repo, subpath);
      if (manifest) {
        bundles.push(this.buildBundle(manifest, { owner, repo, path: subpath }));
      }
    }
    return bundles;
  }

  // --- Runtime detection ------------------------------------------------

  private async detectRuntimeStatus(): Promise<ApmRuntimeStatus> {
    let installed = false;
    let version: string | undefined;
    try {
      const { stdout } = await this.processRunner.exec('apm --version', { timeoutMs: VERSION_CHECK_TIMEOUT_MS });
      const sanitized = sanitizeVersion(stdout.trim());
      if (sanitized.length > 0) {
        installed = true;
        version = sanitized;
      }
    } catch {
      installed = false;
    }

    let uvxAvailable = false;
    try {
      await this.processRunner.exec('uvx --version', { timeoutMs: VERSION_CHECK_TIMEOUT_MS });
      uvxAvailable = true;
    } catch {
      uvxAvailable = false;
    }

    return { installed, uvxAvailable, version };
  }

  private async getRuntimeStatus(): Promise<ApmRuntimeStatus> {
    if (this.runtimeStatusCache && this.clock.now() - this.runtimeStatusCache.cachedAtMs < RUNTIME_STATUS_CACHE_TTL_MS) {
      return this.runtimeStatusCache.status;
    }
    const status = await this.detectRuntimeStatus();
    this.runtimeStatusCache = { status, cachedAtMs: this.clock.now() };
    return status;
  }

  private async ensureRuntimeAvailable(): Promise<void> {
    const status = await this.getRuntimeStatus();
    if (!status.installed && !status.uvxAvailable) {
      throw new Error('APM runtime is not available. Please install apm-cli or uv.');
    }
  }

  // --- Install + archive ------------------------------------------------

  private createTempDirPath(): string {
    return path.join(os.tmpdir(), 'ai-primitives-hub-apm', `install-${this.clock.now()}-${this.tempDirSequence++}`);
  }

  private async cleanupTempDir(dir: string): Promise<void> {
    try {
      await this.fs.remove(dir, { recursive: true });
    } catch {
      // Best-effort cleanup; a leftover temp directory doesn't affect correctness.
    }
  }

  private async installPackage(packageRef: string, targetDir: string): Promise<void> {
    if (!isValidPackageRef(packageRef)) {
      throw new Error(`Invalid package reference: ${packageRef}. Use format: owner/repo`);
    }

    await this.fs.mkdir(targetDir, { recursive: true });
    const apmYmlPath = path.join(targetDir, 'apm.yml');
    if (!(await this.fs.exists(apmYmlPath))) {
      const manifest = `name: temp-install\nversion: 1.0.0\ndependencies:\n  apm:\n    - ${packageRef}\n`;
      await this.fs.writeFile(apmYmlPath, manifest);
    }

    const status = await this.getRuntimeStatus();
    const commandPrefix = status.installed ? 'apm' : 'uvx apm';
    const token = await this.tokenProvider?.getToken('github.com');

    try {
      await this.processRunner.exec(`${commandPrefix} install`, {
        cwd: targetDir,
        env: token ? { GITHUB_TOKEN: token } : undefined,
        timeoutMs: INSTALL_TIMEOUT_MS
      });
    } catch (error) {
      throw new Error(`Failed to install package: ${error instanceof Error ? error.message : error}`);
    }
  }

  private async listFilesRecursively(dirPath: string, relativePrefix = ''): Promise<string[]> {
    const entries = await this.fs.readDirEntries(dirPath);
    const results: string[] = [];
    for (const entry of entries) {
      const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        results.push(...(await this.listFilesRecursively(path.join(dirPath, entry.name), relativePath)));
      } else {
        results.push(relativePath);
      }
    }
    return results;
  }

  private async findPromptFiles(dir: string, recursive = true): Promise<string[]> {
    const files: string[] = [];
    const scan = async (currentDir: string, depth: number): Promise<void> => {
      if ((!recursive && depth > 0) || depth > MAX_SCAN_DEPTH) {
        return;
      }
      let entries;
      try {
        entries = await this.fs.readDirEntries(currentDir);
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory) {
          if (!entry.name.startsWith('.') && !SKIP_DIRECTORIES.includes(entry.name)) {
            await scan(fullPath, depth + 1);
          }
        } else if (PROMPT_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
          files.push(fullPath);
        }
      }
    };
    await scan(dir, 0);
    return files;
  }

  private async createDeploymentManifest(bundle: Bundle, installDir: string): Promise<Record<string, unknown>> {
    const apmManifestPath = path.join(installDir, 'apm.yml');
    let apmManifest: ApmManifest = { name: bundle.name };
    if (await this.fs.exists(apmManifestPath)) {
      apmManifest = (yaml.load(await this.fs.readFile(apmManifestPath)) as ApmManifest | undefined) ?? { name: bundle.name };
    }

    const promptFiles = await this.findPromptFiles(installDir);
    const prompts = promptFiles.map((file) => {
      const filename = path.basename(file);
      const id = filename.replace(/\.(prompt|instructions|agent|chatmode)\.md$/, '');
      return {
        id,
        name: titleCase(id.replace(/-/g, ' ')),
        description: `From ${bundle.name}`,
        file: `prompts/${filename}`,
        type: detectFileType(filename),
        tags: apmManifest.tags ?? []
      };
    });

    return {
      // Deployment-manifest.yml schema field names below are snake_case by contract
      // (see `test/services/deployment-manifest-validator.test.ts`), not our own naming choice.
      metadata: {
        manifest_version: '1.0.0',
        description: bundle.description,
        author: bundle.author
      },
      common: {
        directories: ['prompts'],
        files: [],
        include_patterns: ['**/*.md'],
        exclude_patterns: []
      },
      bundle_settings: {
        include_common_in_environment_bundles: true,
        create_common_bundle: true,
        compression: 'zip' as const,
        naming: {
          common_bundle: bundle.id,
          environment_bundle: `${bundle.id}-{{environment}}`
        }
      },
      prompts
    };
  }

  private async createBundleArchive(bundle: Bundle, installDir: string): Promise<Buffer> {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks: Buffer[] = [];
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));

    const finished = new Promise<Buffer>((resolve, reject) => {
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      archive.on('error', (err: Error) => reject(new Error(`Failed to create ZIP archive: ${err.message}`)));
    });

    const manifest = await this.createDeploymentManifest(bundle, installDir);
    archive.append(yaml.dump(manifest), { name: 'deployment-manifest.yml' });

    const apmDir = path.join(installDir, '.apm');
    if (await this.fs.exists(apmDir)) {
      for (const relativePath of await this.listFilesRecursively(apmDir)) {
        const contents = await this.fs.readFile(path.join(apmDir, relativePath));
        archive.append(contents, { name: `prompts/${relativePath}` });
      }
    }

    const modulesDir = path.join(installDir, 'apm_modules');
    if (await this.fs.exists(modulesDir)) {
      for (const file of await this.findPromptFiles(modulesDir)) {
        archive.append(await this.fs.readFile(file), { name: `prompts/${path.basename(file)}` });
      }
    }

    for (const file of await this.findPromptFiles(installDir, false)) {
      archive.append(await this.fs.readFile(file), { name: `prompts/${path.basename(file)}` });
    }

    await archive.finalize();
    return finished;
  }

  // --- Public API ----------------------------------------------------------

  public async fetchBundles(): Promise<Bundle[]> {
    if (this.bundleCache && this.clock.now() - this.bundleCache.cachedAtMs < BUNDLE_CACHE_TTL_MS) {
      return this.bundleCache.bundles;
    }
    await this.ensureRuntimeAvailable();
    const bundles = await this.fetchFromGitHub();
    this.bundleCache = { bundles, cachedAtMs: this.clock.now() };
    return bundles;
  }

  public async downloadBundle(bundle: Bundle): Promise<Buffer> {
    await this.ensureRuntimeAvailable();
    const packageRef = this.packageRefFromDownloadUrl(bundle.downloadUrl);
    const tempDir = this.createTempDirPath();
    try {
      await this.installPackage(packageRef, tempDir);
      return await this.createBundleArchive(bundle, tempDir);
    } finally {
      await this.cleanupTempDir(tempDir);
    }
  }

  public async fetchMetadata(): Promise<SourceMetadata> {
    const { owner, repo } = this.parseGitHubUrl();
    const bundles = await this.fetchBundles();
    const status = await this.getRuntimeStatus();
    return {
      name: `${owner}/${repo}`,
      description: `APM packages from ${this.source.url}`,
      bundleCount: bundles.length,
      lastUpdated: this.clock.nowIso(),
      version: status.version ?? '1.0.0'
    };
  }

  public async validate(): Promise<ValidationResult> {
    const status = await this.getRuntimeStatus();
    if (!status.installed) {
      return {
        valid: false,
        errors: ['APM CLI is not installed. Install with: pip install apm-cli'],
        warnings: [],
        bundlesFound: 0
      };
    }

    try {
      const bundles = await this.fetchBundles();
      return {
        valid: true,
        errors: [],
        warnings: bundles.length === 0 ? ['No APM packages found'] : [],
        bundlesFound: bundles.length
      };
    } catch (error) {
      return {
        valid: false,
        errors: [`Failed to fetch packages: ${error instanceof Error ? error.message : error}`],
        warnings: [],
        bundlesFound: 0
      };
    }
  }

  public getManifestUrl(): string {
    const { owner, repo } = this.parseGitHubUrl();
    return `https://raw.githubusercontent.com/${owner}/${repo}/${this.branch}/apm.yml`;
  }

  public getDownloadUrl(): string {
    return this.getManifestUrl();
  }
}
