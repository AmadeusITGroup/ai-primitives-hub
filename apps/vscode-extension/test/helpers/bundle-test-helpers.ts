/**
 * Shared test helpers for creating Bundle test data
 *
 * This module provides utilities for creating test bundles with consistent
 * structure across all test files.
 */

// ===== Filesystem Bundle Helpers =====

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  UpdateCheckResult,
} from '../../src/services/update-cache';
import {
  Bundle,
  InstalledBundle,
} from '../../src/types/registry';

/**
 * Constants for test data
 */
export const TEST_SOURCE_IDS = {
  GITHUB: 'github-source',
  LOCAL: 'local-source',
  AWESOME_COPILOT: 'awesome-copilot-source'
} as const;

export const TEST_DEFAULTS = {
  DESCRIPTION: 'Test bundle',
  AUTHOR: 'test',
  ENVIRONMENT: 'vscode',
  TAG: 'test',
  SIZE: '1MB',
  LICENSE: 'MIT'
} as const;

/**
 * Builder pattern for creating test bundles with fluent API
 * @example
 * const bundle = BundleBuilder.github('owner', 'repo')
 *     .withVersion('1.0.0')
 *     .withDescription('Custom description')
 *     .build();
 */
export class BundleBuilder {
  private readonly bundle: Partial<Bundle> = {
    description: TEST_DEFAULTS.DESCRIPTION,
    environments: [TEST_DEFAULTS.ENVIRONMENT],
    tags: [TEST_DEFAULTS.TAG],
    size: TEST_DEFAULTS.SIZE,
    dependencies: [],
    license: TEST_DEFAULTS.LICENSE,
    lastUpdated: new Date().toISOString()
  };

  /**
   * Create a builder for a GitHub bundle
   * @param owner
   * @param repo
   */
  public static github(owner: string, repo: string): BundleBuilder {
    const builder = new BundleBuilder();
    builder.bundle.sourceId = TEST_SOURCE_IDS.GITHUB;
    builder.bundle.name = `${owner}/${repo}`;
    builder.bundle.author = owner;
    builder.bundle.id = `${owner}-${repo}`;
    builder.bundle.manifestUrl = `https://github.com/${owner}/${repo}/releases/download/VERSION/manifest.yml`;
    builder.bundle.downloadUrl = `https://github.com/${owner}/${repo}/releases/download/VERSION/bundle.zip`;
    return builder;
  }

  /**
   * Create a builder for a non-GitHub bundle
   * @param bundleId
   * @param sourceType
   */
  public static fromSource(bundleId: string, sourceType: keyof typeof TEST_SOURCE_IDS): BundleBuilder {
    const builder = new BundleBuilder();
    builder.bundle.sourceId = TEST_SOURCE_IDS[sourceType];
    builder.bundle.id = bundleId;
    builder.bundle.name = bundleId;
    builder.bundle.author = TEST_DEFAULTS.AUTHOR;
    builder.bundle.manifestUrl = `https://example.com/${bundleId}/manifest.yml`;
    builder.bundle.downloadUrl = `https://example.com/${bundleId}/bundle.zip`;
    return builder;
  }

  /**
   * Set the version and update URLs accordingly
   * @param version
   */
  public withVersion(version: string): BundleBuilder {
    this.bundle.version = version;

    // Update ID to include version
    if (this.bundle.id) {
      // Remove existing version suffix (handles both GitHub and non-GitHub)
      const baseId = this.bundle.id.replace(/-v?\d+\.\d+\.\d+(-[\w.]+)?$/, '');
      this.bundle.id = `${baseId}-${version}`;
    }

    // Update URLs with actual version (handles both 'VERSION' placeholder and existing versions)
    if (this.bundle.manifestUrl) {
      this.bundle.manifestUrl = this.bundle.manifestUrl.replace(/VERSION|v?\d+\.\d+\.\d+(-[\w.]+)?/, version);
    }
    if (this.bundle.downloadUrl) {
      this.bundle.downloadUrl = this.bundle.downloadUrl.replace(/VERSION|v?\d+\.\d+\.\d+(-[\w.]+)?/, version);
    }

    return this;
  }

  public withDescription(description: string): BundleBuilder {
    this.bundle.description = description;
    return this;
  }

  public withAuthor(author: string): BundleBuilder {
    this.bundle.author = author;
    return this;
  }

  public withTags(tags: string[]): BundleBuilder {
    this.bundle.tags = tags;
    return this;
  }

  public withLastUpdated(date: string): BundleBuilder {
    this.bundle.lastUpdated = date;
    return this;
  }

  public build(): Bundle {
    if (!this.bundle.id || !this.bundle.version) {
      throw new Error('Bundle must have id and version. Call withVersion() before build()');
    }

    return this.bundle as Bundle;
  }
}

/**
 * Create a mock InstalledBundle for testing
 *
 * Provides consistent InstalledBundle creation across test files.
 * Reduces 7-line inline object creation to a single function call.
 * @param bundleId - Bundle identifier
 * @param version - Bundle version
 * @param overrides - Optional partial overrides for any field
 * @returns Complete InstalledBundle object
 * @example
 * const bundle = createMockInstalledBundle('test-bundle', '1.0.0');
 * const customBundle = createMockInstalledBundle('test-bundle', '1.0.0', { scope: 'workspace' });
 */
export function createMockInstalledBundle(
    bundleId: string,
    version: string,
    overrides?: Partial<InstalledBundle>
): InstalledBundle {
  return {
    bundleId,
    version,
    installedAt: new Date().toISOString(),
    scope: 'user',
    installPath: `/mock/path/${bundleId}`,
    manifest: {} as any,
    ...overrides
  };
}

/**
 * Create a mock Bundle (metadata) for testing
 *
 * Simple factory function for creating Bundle objects.
 * Use this for mocking getBundleDetails() responses.
 * For more control, use BundleBuilder instead.
 * @param bundleId - Bundle identifier
 * @param overrides - Optional partial overrides for any field
 * @returns Complete Bundle object
 * @example
 * ```typescript
 * const bundle = createMockBundleDetails('test-bundle');
 * registryManager.getBundleDetails.resolves(bundle);
 * ```
 */
export function createMockBundleDetails(
    bundleId: string,
    overrides?: Partial<Bundle>
): Bundle {
  return {
    id: bundleId,
    name: `Bundle ${bundleId}`,
    version: '1.0.0',
    description: `Test bundle ${bundleId}`,
    author: TEST_DEFAULTS.AUTHOR,
    sourceId: 'test-source',
    environments: [TEST_DEFAULTS.ENVIRONMENT],
    tags: [TEST_DEFAULTS.TAG],
    lastUpdated: new Date().toISOString(),
    size: TEST_DEFAULTS.SIZE,
    dependencies: [],
    license: TEST_DEFAULTS.LICENSE,
    manifestUrl: `https://example.com/${bundleId}/manifest.yml`,
    downloadUrl: `https://example.com/${bundleId}/bundle.zip`,
    ...overrides
  };
}

/**
 * Create a mock UpdateCheckResult for testing
 *
 * Provides consistent UpdateCheckResult creation for update-related tests.
 * @param bundleId - Bundle identifier
 * @param currentVersion - Currently installed version
 * @param latestVersion - Latest available version
 * @param overrides - Optional partial overrides for any field
 * @returns Complete UpdateCheckResult object
 * @example
 * const update = createMockUpdateCheckResult('test-bundle', '1.0.0', '2.0.0');
 * const autoUpdate = createMockUpdateCheckResult('test-bundle', '1.0.0', '2.0.0', { autoUpdateEnabled: true });
 */
export function createMockUpdateCheckResult(
    bundleId: string,
    currentVersion: string,
    latestVersion: string,
    overrides?: Partial<UpdateCheckResult>
): UpdateCheckResult {
  return {
    bundleId,
    currentVersion,
    latestVersion,
    releaseDate: new Date().toISOString(),
    downloadUrl: 'https://example.com/bundle.zip',
    autoUpdateEnabled: false,
    ...overrides
  };
}

/**
 * Create a unique UpdateCheckResult for batch testing
 *
 * Generates UpdateCheckResult with predictable version increments.
 * Useful for batch update tests where multiple bundles need distinct versions.
 * @param index - Index for generating unique bundle ID and versions
 * @returns UpdateCheckResult with versions based on index
 * @example
 * const updates = Array.from({ length: 5 }, (_, i) => createUniqueUpdateCheckResult(i));
 * // Generates: bundle-0 (0.0.0 → 0.1.0), bundle-1 (1.0.0 → 1.1.0), etc.
 */
export function createUniqueUpdateCheckResult(index: number): UpdateCheckResult {
  return {
    bundleId: `bundle-${index}`,
    currentVersion: `${index}.0.0`,
    latestVersion: `${index}.1.0`,
    releaseDate: new Date().toISOString(),
    downloadUrl: 'https://example.com/bundle.zip',
    autoUpdateEnabled: true
  };
}

// ===== Mock Setup Helpers (consolidated from bundleCommandsTestHelpers) =====

/**
 * Setup mock for update available scenario
 * Consolidates mock configuration for single bundle updates
 * @param mockRegistryManager
 * @param bundleId
 * @param bundleName
 * @param currentVersion
 * @param latestVersion
 */
export function setupUpdateAvailable(
    mockRegistryManager: any,
    bundleId: string,
    bundleName = 'Test Bundle',
    currentVersion = '1.0.0',
    latestVersion = '2.0.0'
): void {
  const update = createMockUpdateCheckResult(bundleId, currentVersion, latestVersion);
  mockRegistryManager.checkUpdates.resolves([update]);

  // Create bundle with the specified name, not derived from bundleId
  const bundle = BundleBuilder.fromSource(bundleId, 'GITHUB')
    .withVersion(latestVersion)
    .withDescription('Test bundle')
    .build();

  // Override the name with the provided bundleName
  bundle.name = bundleName;

  mockRegistryManager.getBundleDetails.withArgs(bundleId).resolves(bundle);
}

/**
 * Setup mock for no updates available scenario
 * @param mockRegistryManager
 */
export function setupNoUpdatesAvailable(mockRegistryManager: any): void {
  mockRegistryManager.checkUpdates.resolves([]);
}

/**
 * Setup VS Code progress mock with default behavior
 * @param sandbox
 */
export function setupProgressMock(sandbox: any): any {
  const mockWithProgress = sandbox.stub(require('vscode').window, 'withProgress');
  mockWithProgress.callsFake(async (_options: any, callback: any) => {
    return await callback({ report: sandbox.stub() }, { isCancellationRequested: false, onCancellationRequested: sandbox.stub() });
  });
  return mockWithProgress;
}

/**
 * Reset all common mocks used in bundle command tests
 * @param mockRegistryManager
 * @param mockShowQuickPick
 * @param mockShowInformationMessage
 * @param mockWithProgress
 */
export function resetBundleCommandsMocks(
    mockRegistryManager: any,
    mockShowQuickPick: any,
    mockShowInformationMessage: any,
    mockWithProgress: any
): void {
  mockRegistryManager.checkUpdates.reset();
  mockRegistryManager.getBundleDetails.reset();
  mockRegistryManager.updateBundle.reset();
  mockRegistryManager.listInstalledBundles.reset();
  mockShowQuickPick.reset();
  mockShowInformationMessage.reset();
  mockWithProgress.reset();

  // Re-setup default withProgress behavior after reset
  mockWithProgress.callsFake(async (_options: any, callback: any) => {
    return await callback({ report: require('sinon').stub() }, { isCancellationRequested: false, onCancellationRequested: require('sinon').stub() });
  });

  // Setup default listInstalledBundles behavior
  mockRegistryManager.listInstalledBundles.resolves([]);
}

/**
 * Generate test data for multiple bundle updates
 * @param count
 */
export function generateMultipleUpdates(count: number): UpdateCheckResult[] {
  return Array.from({ length: count }, (_, i) =>
    createUniqueUpdateCheckResult(i)
  );
}

/**
 * Generate test bundles with corresponding updates
 * @param updates
 */
export function generateBundlesWithUpdates(updates: UpdateCheckResult[]): Bundle[] {
  return updates.map((update) =>
    BundleBuilder.fromSource(update.bundleId, 'GITHUB')
      .withVersion(update.latestVersion)
      .build()
  );
}

/**
 * Test suite for BundleBuilder (can be imported and run in test files)
 */
export function testBundleBuilder() {
  const assert = require('node:assert');

  suite('BundleBuilder', () => {
    suite('withVersion', () => {
      test('should handle multiple version updates correctly', () => {
        const builder = BundleBuilder.github('owner', 'repo');

        // Set version 1.0.0
        const bundle1 = builder.withVersion('1.0.0').build();
        assert.strictEqual(bundle1.version, '1.0.0');
        assert.strictEqual(bundle1.id, 'owner-repo-1.0.0');
        assert.ok(bundle1.downloadUrl.includes('1.0.0'));

        // Update to version 2.0.0 (should replace, not append)
        const bundle2 = BundleBuilder.github('owner', 'repo').withVersion('2.0.0').build();
        assert.strictEqual(bundle2.version, '2.0.0');
        assert.strictEqual(bundle2.id, 'owner-repo-2.0.0');
        assert.ok(bundle2.downloadUrl.includes('2.0.0'));
        assert.ok(!bundle2.downloadUrl.includes('1.0.0'));
      });

      test('should handle version updates for non-GitHub bundles', () => {
        const builder = BundleBuilder.fromSource('my-bundle', 'LOCAL');

        const bundle1 = builder.withVersion('1.0.0').build();
        assert.strictEqual(bundle1.id, 'my-bundle-1.0.0');

        // Create new builder and update version
        const bundle2 = BundleBuilder.fromSource('my-bundle', 'LOCAL').withVersion('2.0.0').build();
        assert.strictEqual(bundle2.id, 'my-bundle-2.0.0');
        assert.ok(!bundle2.id.includes('1.0.0'));
      });

      test('should update URLs with version', () => {
        const bundle = BundleBuilder.github('owner', 'repo')
          .withVersion('1.5.0')
          .build();

        assert.ok(bundle.downloadUrl.includes('1.5.0'));
        assert.ok(bundle.manifestUrl.includes('1.5.0'));
        assert.ok(!bundle.manifestUrl.includes('VERSION'));
      });
    });
  });
}

/**
 * Options for creating a mock bundle directory on the filesystem
 */
export interface MockBundleDirectoryOptions {
  /** Base path where the bundle directory will be created */
  basePath: string;
  /** Bundle identifier */
  bundleId: string;
  /** Bundle version (default: '1.0.0') */
  version?: string;
  /** Files to include in the bundle */
  files?: {
    /** Filename (e.g., 'test.prompt.md') */
    name: string;
    /** File content */
    content: string;
    /** File type for manifest (default: 'prompt') */
    type?: string;
  }[];
}

/**
 * Create a mock bundle directory on the filesystem for testing
 *
 * This helper creates a complete bundle directory structure with:
 * - deployment-manifest.yml with proper prompts array
 * - All specified files
 *
 * Supports two usage patterns:
 * 1. Simple: Just bundleId and version (creates single test-prompt.md)
 * 2. Advanced: Custom files array with types
 * @param options
 * @example Simple usage (for symlink tests):
 * ```typescript
 * const bundlePath = createMockBundleDirectory({
 *     basePath: tempDir,
 *     bundleId: 'test-bundle',
 *     version: '1.0.0'
 * });
 * ```
 * @example Advanced usage (for file type tests):
 * ```typescript
 * const bundlePath = createMockBundleDirectory({
 *     basePath: tempDir,
 *     bundleId: 'mixed-bundle',
 *     files: [
 *         { name: 'prompt1.prompt.md', content: '# Prompt', type: 'prompt' },
 *         { name: 'coding.instructions.md', content: '# Instructions', type: 'instructions' }
 *     ]
 * });
 * ```
 */
export function createMockBundleDirectory(options: MockBundleDirectoryOptions): string {
  const { basePath, bundleId, version = '1.0.0', files } = options;

  // Create bundle path - include version in directory name for uniqueness
  const bundlePath = path.join(basePath, `${bundleId}-v${version}`);
  fs.mkdirSync(bundlePath, { recursive: true });

  // Default to single test prompt if no files specified
  const bundleFiles = files ?? [
    { name: 'test-prompt.md', content: `# Test Prompt v${version}`, type: 'prompt' }
  ];

  // Create prompts array for manifest
  const prompts = bundleFiles.map((f) => {
    // Extract id by removing type extensions
    const id = f.name
      .replace(/\.(prompt|instructions|agent|chatmode|skill)\.md$/, '')
      .replace(/\.md$/, '');
    return {
      id,
      name: f.name,
      file: f.name,
      type: f.type || 'prompt'
    };
  });

  // Create deployment manifest
  const manifestContent = `id: ${bundleId}
version: "${version}"
prompts:
${prompts.map((p) => `  - id: ${p.id}
    name: ${p.name}
    file: ${p.file}
    type: ${p.type}`).join('\n')}`;

  fs.writeFileSync(path.join(bundlePath, 'deployment-manifest.yml'), manifestContent);

  // Create files
  for (const file of bundleFiles) {
    fs.writeFileSync(path.join(bundlePath, file.name), file.content);
  }

  return bundlePath;
}

/**
 * Simplified helper for creating a basic mock bundle
 *
 * Convenience wrapper around createMockBundleDirectory for simple test cases
 * that just need a bundle with a single prompt file.
 * @param basePath - Directory where bundle will be created
 * @param bundleId - Bundle identifier
 * @param version - Bundle version
 * @returns Path to created bundle directory
 * @example
 * ```typescript
 * const bundlePath = createSimpleMockBundle(tempDir, 'test-bundle', '1.0.0');
 * await service.syncBundle('test-bundle', bundlePath);
 * ```
 */
export function createSimpleMockBundle(basePath: string, bundleId: string, version: string): string {
  return createMockBundleDirectory({ basePath, bundleId, version });
}
