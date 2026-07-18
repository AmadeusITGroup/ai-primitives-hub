/**
 * E2E Test Utilities
 *
 * Provides test context management for E2E tests including:
 * - Isolated temporary storage directories
 * - Mock VS Code ExtensionContext setup
 * - Automatic cleanup of test artifacts
 *
 * Requirements: 3.1, 3.2, 3.3
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  LockfileManager,
} from '../../src/services/lockfile-manager';
import {
  RegistryManager,
} from '../../src/services/registry-manager';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';

/**
 * E2E Test Context interface
 * Provides isolated test environment with automatic cleanup
 */
export interface E2ETestContext {
  /** Unique temporary storage path for this test */
  tempStoragePath: string;
  /** Mock VS Code ExtensionContext configured for testing */
  mockContext: vscode.ExtensionContext;
  /** RegistryManager instance for this test */
  registryManager: RegistryManager;
  /** RegistryStorage instance for this test */
  storage: RegistryStorage;
  /** Cleanup function to remove all test artifacts */
  cleanup: () => Promise<void>;
}

/**
 * Create an isolated E2E test context
 *
 * Creates a unique temporary directory for test data, sets up mock VS Code context,
 * and initializes RegistryManager and RegistryStorage instances.
 * @returns E2ETestContext with isolated storage and cleanup function
 * @example
 * let testContext: E2ETestContext;
 *
 * setup(async function() {
 *     this.timeout(30000);
 *     testContext = await createE2ETestContext();
 * });
 *
 * teardown(async function() {
 *     this.timeout(10000);
 *     await testContext.cleanup();
 * });
 */
export async function createE2ETestContext(): Promise<E2ETestContext> {
  RegistryManager.resetInstance();
  LockfileManager.resetInstance();

  // Create unique temporary storage directory
  const tempStoragePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'e2e-bundle-update-test-')
  );
  const tempExtensionPath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'e2e-extension-test-')
  );
  const tempWorkspaceRoot = path.join(tempStoragePath, 'test-workspace');
  const tempUserDir = path.join(tempStoragePath, 'User');
  const tempGlobalStoragePath = path.join(tempUserDir, 'globalStorage', 'prompt-registry');

  fs.mkdirSync(tempWorkspaceRoot, { recursive: true });
  (globalThis as any).__mockWorkspaceFolders = [
    {
      uri: vscode.Uri.file(tempWorkspaceRoot),
      name: 'test-workspace',
      index: 0
    }
  ];

  // Create globalState storage for mock context
  const globalStateData = new Map<string, any>();
  const workspaceStateData = new Map<string, any>();

  // Create mock VS Code ExtensionContext
  const mockContext: vscode.ExtensionContext = {
    globalState: {
      get: <T>(key: string, defaultValue?: T): T | undefined => {
        return globalStateData.has(key) ? globalStateData.get(key) : defaultValue;
      },
      update: (key: string, value: any): Promise<void> => Promise.resolve().then(() => {
        globalStateData.set(key, value);
      }),
      keys: () => Array.from(globalStateData.keys()),
      setKeysForSync: () => {}
    },
    workspaceState: {
      get: <T>(key: string, defaultValue?: T): T | undefined => {
        return workspaceStateData.has(key) ? workspaceStateData.get(key) : defaultValue;
      },
      update: (key: string, value: any): Promise<void> => Promise.resolve().then(() => {
        workspaceStateData.set(key, value);
      }),
      keys: () => Array.from(workspaceStateData.keys()),
      setKeysForSync: () => {}
    } as any,
    subscriptions: [],
    extensionPath: tempExtensionPath,
    extensionUri: vscode.Uri.file(tempExtensionPath),
    environmentVariableCollection: {} as any,
    extensionMode: 3, // ExtensionMode.Test
    storageUri: vscode.Uri.file(tempStoragePath),
    globalStorageUri: vscode.Uri.file(tempGlobalStoragePath),
    logUri: vscode.Uri.file(path.join(tempStoragePath, 'logs')),
    secrets: {
      get: () => undefined,
      store: async () => {},
      delete: async () => {},
      onDidChange: { dispose: () => {} } as any
    } as any,
    languageModelAccessInformation: {} as any,
    asAbsolutePath: (relativePath: string) => path.join(tempExtensionPath, relativePath),
    storagePath: tempStoragePath,
    globalStoragePath: tempGlobalStoragePath,
    logPath: path.join(tempStoragePath, 'logs'),
    extension: {} as any
  };

  // Initialize storage and create directories
  const storage = new RegistryStorage(mockContext);
  await storage.initialize();

  // Get RegistryManager instance with this context
  // Note: RegistryManager is a singleton, so we need to reset it for each test
  const registryManager = RegistryManager.getInstance(mockContext);

  // Inject the storage instance to ensure it uses our temp directory
  (registryManager as any).storage = storage;

  // Clear the adapters cache to ensure fresh adapters for each test
  // This is important because adapters cache authentication tokens
  (registryManager as any).adapters.clear();

  // Clear the sources cache
  (registryManager as any).sourcesCache = [];

  // Re-initialize the installer with the new context
  // eslint-disable-next-line @typescript-eslint/naming-convention -- matches module export name
  const BundleInstaller = require('../../src/services/bundle-installer').BundleInstaller;
  (registryManager as any).installer = new BundleInstaller(mockContext);

  // Create cleanup function
  const cleanup = (): Promise<void> => {
    try {
      if (fs.existsSync(tempStoragePath)) {
        fs.rmSync(tempStoragePath, { recursive: true, force: true });
      }
    } catch {
      // best-effort cleanup
    }

    return Promise.resolve();
  };

  (globalThis as any).__mockWorkspaceFolders = [
    {
      uri: vscode.Uri.file(tempWorkspaceRoot),
      name: 'test-workspace',
      index: 0
    }
  ];

  return {
    tempStoragePath,
    mockContext,
    registryManager,
    storage,
    cleanup
  };
}

/**
 * Generate a unique test ID for bundle/source naming
 * Helps prevent test pollution when tests run in parallel
 * @param prefix - Optional prefix for the ID
 * @returns Unique string ID
 */
export function generateTestId(prefix = 'test'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Wait for a condition to be true with timeout
 * Useful for async operations in E2E tests
 * @param condition - Function that returns true when condition is met
 * @param timeoutMs - Maximum time to wait in milliseconds
 * @param intervalMs - Polling interval in milliseconds
 * @returns Promise that resolves when condition is true or rejects on timeout
 */
export async function waitForCondition(
    condition: () => boolean | Promise<boolean>,
    timeoutMs = 5000,
    intervalMs = 100
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Condition not met within ${timeoutMs}ms timeout`);
}

/**
 * Bundle setup result from setupSourceAndGetBundle helper
 */
export interface BundleSetupResult {
  /** The source ID used for this setup */
  sourceId: string;
  /** The bundle found in the source */
  bundle: any;
}

/**
 * Options for setting up a source and bundle
 */
export interface BundleSetupOptions {
  /** Test ID prefix for unique naming */
  testId: string;
  /** Suffix to append to testId for unique source naming */
  testIdSuffix: string;
  /** Content identifier for the bundle */
  content: string;
  /** Workspace root path */
  workspaceRoot: string;
  /** E2E test context */
  testContext: E2ETestContext;
  /** Sinon sandbox for stubbing */
  sandbox: any;
  /** Function to create mock source */
  createMockSource: (id: string) => any;
  /** Function to setup release mocks */
  setupReleaseMocks: (releases: { tag: string; version: string; content: string }[]) => void;
  /** Expected bundle ID to find */
  expectedBundleId: string;
}

/**
 * Helper to set up a source and get a bundle for testing.
 * Extracts common setup pattern used across multiple E2E tests.
 *
 * This is a generic version that can be used by any E2E test file.
 * For simpler usage within a single test file, consider creating a
 * local wrapper function that captures the test-specific dependencies.
 * @param options - Setup options including test context and mock functions
 * @returns Object containing sourceId and the found bundle
 * @throws {Error} if bundle is not found
 * @example
 * // In your test file, create a local wrapper:
 * async function setupSourceAndGetBundle(suffix: string, content: string) {
 *     return setupSourceAndGetBundleGeneric({
 *         testId,
 *         testIdSuffix: suffix,
 *         content,
 *         workspaceRoot,
 *         testContext,
 *         sandbox,
 *         createMockSource,
 *         setupReleaseMocks,
 *         expectedBundleId: BUNDLE_ID
 *     });
 * }
 */
export async function setupSourceAndGetBundleGeneric(
    options: BundleSetupOptions
): Promise<BundleSetupResult> {
  const {
    testId,
    testIdSuffix,
    content,
    workspaceRoot,
    testContext,
    sandbox,
    createMockSource,
    setupReleaseMocks,
    expectedBundleId
  } = options;

  const sourceId = `${testId}-${testIdSuffix}`;
  const source = createMockSource(sourceId);
  setupReleaseMocks([{ tag: 'v1.0.0', version: '1.0.0', content }]);

  sandbox.stub(vscode.workspace, 'workspaceFolders').value([
    { uri: vscode.Uri.file(workspaceRoot), name: 'test-workspace', index: 0 }
  ]);

  await testContext.registryManager.addSource(source);
  await testContext.registryManager.syncSource(sourceId);

  const rawBundles = await testContext.storage.getCachedSourceBundles(sourceId);
  const bundle = rawBundles.find((b: any) => b.id === expectedBundleId);

  if (!bundle) {
    throw new Error(`Should find bundle ${expectedBundleId}, found: ${rawBundles.map((b: any) => b.id).join(', ')}`);
  }

  return { sourceId, bundle };
}
