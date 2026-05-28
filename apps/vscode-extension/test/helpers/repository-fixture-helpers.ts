/**
 * Shared E2E Repository Fixture Helpers
 *
 * Provides reusable test fixtures for GitHub repository-based E2E tests:
 * - Mock GitHub releases API configuration
 * - Bundle ZIP file creation
 * - Deployment manifest generation
 * - Mock source creation
 *
 * Requirements covered:
 * - 1.1: setupReleaseMocks() for GitHub releases API
 * - 1.2: createBundleZip() for valid bundle ZIP files
 * - 1.3: createDeploymentManifest() for deployment manifests
 * - 1.4: setupReleaseMocks() configures all required endpoints
 * - 1.5: createBundleZip() returns valid ZIP with manifest and prompts
 * - 1.6: RepositoryTestConfig interface for test configuration
 */

import AdmZip from 'adm-zip';
import {
  Context,
} from 'mocha';
import nock from 'nock';
import {
  RegistrySource,
} from '../../src/types/registry';

/**
 * Type alias for Mocha test context with skip() and timeout() methods.
 * Use this instead of inline `{ skip: () => void }` for better type safety.
 * @example
 * async function installBundleOrSkip(
 *     context: MochaTestContext,
 *     bundleId: string
 * ): Promise<void> {
 *     try {
 *         await install(bundleId);
 *     } catch (error) {
 *         if (error.message.includes('not yet implemented')) {
 *             context.skip();
 *         }
 *         throw error;
 *     }
 * }
 */
export type MochaTestContext = Context;

/**
 * Configuration for repository-based E2E test fixtures
 * @example
 * const config: RepositoryTestConfig = {
 *     owner: 'test-owner',
 *     repo: 'test-repo',
 *     manifestId: 'my-bundle',
 *     baseVersion: '1.0.0'
 * };
 */
export interface RepositoryTestConfig {
  /** GitHub repository owner */
  owner: string;
  /** GitHub repository name */
  repo: string;
  /** Bundle manifest ID */
  manifestId: string;
  /** Optional: Base version (default: '1.0.0') */
  baseVersion?: string;
}

/**
 * Configuration for a single GitHub release mock
 * @example
 * const release: ReleaseConfig = {
 *     tag: 'v1.0.0',
 *     version: '1.0.0',
 *     content: 'initial'
 * };
 */
export interface ReleaseConfig {
  /** Git tag (e.g., 'v1.0.0') */
  tag: string;
  /** Semantic version (e.g., '1.0.0') */
  version: string;
  /** Content identifier for test differentiation */
  content: string;
}

/**
 * Deployment manifest structure for bundle metadata
 */
export interface DeploymentManifestData {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  tags: string[];
  environments: string[];
  dependencies: string[];
  license: string;
}

// Constants for asset ID generation
const MANIFEST_ASSET_BASE_ID = 1000;
const BUNDLE_ASSET_BASE_ID = 2000;
const MS_PER_DAY = 86_400_000;

/**
 * Create a valid deployment manifest object
 * @param config - Repository test configuration
 * @param version - Semantic version string
 * @param content - Optional content identifier for test differentiation
 * @returns DeploymentManifestData object with all required fields
 * @example
 * const manifest = createDeploymentManifest(
 *     { owner: 'test', repo: 'repo', manifestId: 'bundle' },
 *     '1.0.0',
 *     'initial'
 * );
 */
export function createDeploymentManifest(
    config: RepositoryTestConfig,
    version: string,
    content = 'initial'
): DeploymentManifestData {
  return {
    id: config.manifestId,
    name: `Test Repository Bundle - ${content}`,
    version: version,
    description: `Test bundle for E2E tests - ${content}`,
    author: config.owner,
    tags: ['test', 'e2e', 'repository'],
    environments: ['development'],
    dependencies: [],
    license: 'MIT'
  };
}

/**
 * Create prompt file content for testing
 * @param content - Content identifier for test differentiation
 * @returns Markdown string for prompt file
 */
function createPromptContent(content: string): string {
  return `# Test Prompt
This is a test prompt for E2E testing.
Content: ${content}
`;
}

/**
 * Create a valid bundle ZIP file as Buffer
 *
 * Contains deployment-manifest.yml and prompts/test.prompt.md
 * @param config - Repository test configuration
 * @param version - Semantic version string
 * @param content - Optional content identifier for test differentiation
 * @returns Buffer containing valid ZIP archive
 * @example
 * const zipBuffer = createBundleZip(
 *     { owner: 'test', repo: 'repo', manifestId: 'bundle' },
 *     '1.0.0',
 *     'initial'
 * );
 */
export function createBundleZip(
    config: RepositoryTestConfig,
    version: string,
    content = 'initial'
): Buffer {
  const zip = new AdmZip();

  // Create YAML manifest content
  const manifestYaml = `id: ${config.manifestId}
name: Test Repository Bundle - ${content}
version: ${version}
description: Test bundle for E2E tests - ${content}
author: ${config.owner}
tags:
  - test
  - e2e
  - repository
environments:
  - development
dependencies: []
license: MIT
prompts:
  - id: test-prompt
    name: Test Prompt
    description: A test prompt for E2E testing
    file: prompts/test.prompt.md
    type: prompt
`;

  zip.addFile('deployment-manifest.yml', Buffer.from(manifestYaml));
  zip.addFile('prompts/test.prompt.md', Buffer.from(createPromptContent(content)));

  return zip.toBuffer();
}

/**
 * Set up nock mocks for GitHub releases API
 *
 * Configures interceptors for:
 * - GET /repos/{owner}/{repo}/releases
 * - GET /repos/{owner}/{repo} (repo metadata)
 * - GET /repos/{owner}/{repo}/releases/assets/{id} (manifest)
 * - GET /repos/{owner}/{repo}/releases/assets/{id} (bundle zip)
 * - Redirect to objects.githubusercontent.com for bundle download
 * @param config - Repository test configuration
 * @param releases - Array of release configurations to mock
 * @example
 * setupReleaseMocks(
 *     { owner: 'test', repo: 'repo', manifestId: 'bundle' },
 *     [{ tag: 'v1.0.0', version: '1.0.0', content: 'initial' }]
 * );
 */
export function setupReleaseMocks(
    config: RepositoryTestConfig,
    releases: ReleaseConfig[]
): void {
  // Clean existing mocks and configure nock
  nock.cleanAll();
  nock.disableNetConnect();
  nock.enableNetConnect('127.0.0.1');

  // Build releases response
  const releasesResponse = releases.map((r, index) => ({
    tag_name: r.tag,
    name: `Release ${r.version}`,
    body: `Release notes for ${r.version}`,
    published_at: new Date(Date.now() - index * MS_PER_DAY).toISOString(),
    assets: [
      {
        name: 'deployment-manifest.yml',
        url: `https://api.github.com/repos/${config.owner}/${config.repo}/releases/assets/${MANIFEST_ASSET_BASE_ID + index}`,
        browser_download_url: `https://github.com/${config.owner}/${config.repo}/releases/download/${r.tag}/deployment-manifest.yml`,
        size: 512
      },
      {
        name: 'bundle.zip',
        url: `https://api.github.com/repos/${config.owner}/${config.repo}/releases/assets/${BUNDLE_ASSET_BASE_ID + index}`,
        browser_download_url: `https://github.com/${config.owner}/${config.repo}/releases/download/${r.tag}/bundle.zip`,
        size: 2048
      }
    ]
  }));

  // Mock releases endpoint
  nock('https://api.github.com')
    .persist()
    .get(`/repos/${config.owner}/${config.repo}/releases`)
    .reply(200, releasesResponse);

  // Mock repository metadata endpoint
  nock('https://api.github.com')
    .persist()
    .get(`/repos/${config.owner}/${config.repo}`)
    .reply(200, {
      name: config.repo,
      description: 'Test repository',
      updated_at: new Date().toISOString()
    });

  // Mock individual release assets
  releases.forEach((r, index) => {
    const manifest = createDeploymentManifest(config, r.version, r.content);
    const bundleZip = createBundleZip(config, r.version, r.content);

    // Mock manifest asset download
    nock('https://api.github.com')
      .persist()
      .get(`/repos/${config.owner}/${config.repo}/releases/assets/${MANIFEST_ASSET_BASE_ID + index}`)
      .reply(200, JSON.stringify(manifest));

    // Mock bundle asset download (redirect to githubusercontent)
    nock('https://api.github.com')
      .persist()
      .get(`/repos/${config.owner}/${config.repo}/releases/assets/${BUNDLE_ASSET_BASE_ID + index}`)
      .reply(302, '', {
        location: `https://objects.githubusercontent.com/${config.owner}/${config.repo}/${r.tag}/bundle.zip`
      });

    // Mock actual bundle download from githubusercontent
    nock('https://objects.githubusercontent.com')
      .persist()
      .get(`/${config.owner}/${config.repo}/${r.tag}/bundle.zip`)
      .reply(200, bundleZip);
  });
}

/**
 * Create a mock RegistrySource for GitHub
 * @param id - Unique source identifier
 * @param config - Repository test configuration
 * @returns RegistrySource object configured for GitHub
 * @example
 * const source = createMockGitHubSource(
 *     'my-source',
 *     { owner: 'test', repo: 'repo', manifestId: 'bundle' }
 * );
 */
export function createMockGitHubSource(
    id: string,
    config: RepositoryTestConfig
): RegistrySource {
  return {
    id,
    name: 'Test GitHub Source',
    type: 'github',
    url: `https://github.com/${config.owner}/${config.repo}`,
    enabled: true,
    priority: 1,
    token: 'test-token'
  };
}

/**
 * Clear all nock mocks and reset state
 *
 * Call this in teardown to ensure clean state between tests
 * @example
 * teardown(() => {
 *     cleanupReleaseMocks();
 * });
 */
export function cleanupReleaseMocks(): void {
  nock.cleanAll();
  nock.enableNetConnect();
}

/**
 * Compute the expected bundle ID for a GitHub repository bundle
 * @param config - Repository test configuration
 * @param version - Semantic version string
 * @returns Expected bundle ID string
 * @example
 * const bundleId = computeBundleId(
 *     { owner: 'test', repo: 'repo', manifestId: 'bundle' },
 *     '1.0.0'
 * );
 * // Returns: 'test-repo-bundle-1.0.0'
 */
export function computeBundleId(
    config: RepositoryTestConfig,
    version: string
): string {
  return `${config.owner}-${config.repo}-${config.manifestId}-${version}`;
}

/**
 * Create a standard test configuration with common defaults
 * @param overrides - Optional partial overrides for the configuration
 * @returns Complete RepositoryTestConfig object
 * @example
 * const config = createTestConfig({ manifestId: 'custom-bundle' });
 */
export function createTestConfig(
    overrides?: Partial<RepositoryTestConfig>
): RepositoryTestConfig {
  return {
    owner: 'test-owner',
    repo: 'test-repo',
    manifestId: 'test-bundle',
    baseVersion: '1.0.0',
    ...overrides
  };
}

/**
 * Dependencies required for setupSourceWithCustomConfig helper.
 * Pass these from your test context to avoid tight coupling.
 */
export interface SourceSetupDependencies {
  /** RegistryManager instance for adding/syncing sources */
  registryManager: {
    addSource(source: RegistrySource): Promise<void>;
    syncSource(sourceId: string): Promise<void>;
  };
  /** Storage instance for retrieving cached bundles */
  storage: {
    getCachedSourceBundles(sourceId: string): Promise<{ id: string }[]>;
  };
}

/**
 * Set up a GitHub source with custom configuration and return the synced bundle.
 *
 * This is a higher-level helper that combines setupReleaseMocks, createMockGitHubSource,
 * and source registration into a single call. Useful when testing multiple bundles
 * with different configurations.
 * @param deps - Test context dependencies (registryManager, storage)
 * @param testId - Base test ID for generating unique source IDs
 * @param sourceIdSuffix - Suffix to append to testId for unique source identification
 * @param config - Repository test configuration
 * @param content - Content identifier for test differentiation
 * @returns Object containing sourceId and the found bundle
 * @throws {Error} if bundle matching config.manifestId is not found
 * @example
 * const { sourceId, bundle } = await setupSourceWithCustomConfig(
 *     { registryManager: testContext.registryManager, storage: testContext.storage },
 *     testId,
 *     'my-source',
 *     { owner: 'test', repo: 'repo', manifestId: 'bundle' },
 *     'test-content'
 * );
 */
export async function setupSourceWithCustomConfig(
    deps: SourceSetupDependencies,
    testId: string,
    sourceIdSuffix: string,
    config: RepositoryTestConfig,
    content: string
): Promise<{ sourceId: string; bundle: { id: string } }> {
  const sourceId = `${testId}-${sourceIdSuffix}`;
  const source = createMockGitHubSource(sourceId, config);
  const releases: ReleaseConfig[] = [{ tag: 'v1.0.0', version: '1.0.0', content }];
  setupReleaseMocks(config, releases);

  await deps.registryManager.addSource(source);
  await deps.registryManager.syncSource(sourceId);

  const bundles = await deps.storage.getCachedSourceBundles(sourceId);
  const bundle = bundles.find((b) => b.id.includes(config.manifestId));

  if (!bundle) {
    throw new Error(
      `Should find bundle containing '${config.manifestId}', `
      + `found: ${bundles.map((b) => b.id).join(', ') || 'none'}`
    );
  }

  return { sourceId, bundle };
}
