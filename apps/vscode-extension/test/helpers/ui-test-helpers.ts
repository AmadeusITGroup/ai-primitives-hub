/**
 * Shared test helpers for UI component tests
 *
 * This module provides utilities for creating consistent mocks for
 * RegistryManager and HubManager event emitters used by UI components.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as sinon from 'sinon';
import {
  HubManager,
} from '../../src/services/hub-manager';
import {
  RegistryManager,
} from '../../src/services/registry-manager';

/**
 * All event emitter names that RegistryManager exposes.
 * Keep this list in sync with RegistryManager.ts
 */
const REGISTRY_MANAGER_EVENTS = [
  'onBundleInstalled',
  'onBundleUninstalled',
  'onBundleUpdated',
  'onBundlesInstalled',
  'onBundlesUninstalled',
  'onProfileActivated',
  'onProfileDeactivated',
  'onProfileCreated',
  'onProfileUpdated',
  'onProfileDeleted',
  'onSourceAdded',
  'onSourceRemoved',
  'onSourceUpdated',
  'onSourceSynced',
  'onAutoUpdatePreferenceChanged',
  'onRepositoryBundlesChanged'
] as const;

/**
 * All event emitter names that HubManager exposes.
 * Keep this list in sync with HubManager.ts
 */
const HUB_MANAGER_EVENTS = [
  'onHubImported',
  'onHubDeleted',
  'onHubSynced',
  'onFavoritesChanged'
] as const;

/**
 * Creates a disposable stub that can be used for event emitter mocks
 * @param sandbox
 */
function createDisposableStub(sandbox: sinon.SinonSandbox): sinon.SinonStub {
  return sandbox.stub().returns({ dispose: () => {} });
}

/**
 * Sets up all required event emitter mocks on a RegistryManager stub.
 *
 * This ensures that RegistryTreeProvider and other UI components can
 * subscribe to events without throwing errors.
 * @param registryManagerStub - The sinon stub instance of RegistryManager
 * @param sandbox - The sinon sandbox to use for creating stubs
 * @example
 * ```typescript
 * const sandbox = sinon.createSandbox();
 * const registryManagerStub = sandbox.createStubInstance(RegistryManager);
 * setupRegistryManagerEventMocks(registryManagerStub, sandbox);
 * ```
 */
export function setupRegistryManagerEventMocks(
    registryManagerStub: sinon.SinonStubbedInstance<RegistryManager>,
    sandbox: sinon.SinonSandbox
): void {
  for (const eventName of REGISTRY_MANAGER_EVENTS) {
    (registryManagerStub as any)[eventName] = createDisposableStub(sandbox);
  }
}

/**
 * Sets up all required event emitter mocks on a HubManager stub.
 * @param hubManagerStub - The sinon stub instance of HubManager
 * @param sandbox - The sinon sandbox to use for creating stubs
 * @example
 * ```typescript
 * const sandbox = sinon.createSandbox();
 * const hubManagerStub = sandbox.createStubInstance(HubManager);
 * setupHubManagerEventMocks(hubManagerStub, sandbox);
 * ```
 */
export function setupHubManagerEventMocks(
    hubManagerStub: sinon.SinonStubbedInstance<HubManager>,
    sandbox: sinon.SinonSandbox
): void {
  for (const eventName of HUB_MANAGER_EVENTS) {
    (hubManagerStub as any)[eventName] = createDisposableStub(sandbox);
  }
}

/**
 * Sets up the autoUpdateService mock on a RegistryManager stub.
 * @param registryManagerStub - The sinon stub instance of RegistryManager
 * @param sandbox - The sinon sandbox to use for creating stubs
 */
export function setupAutoUpdateServiceMock(
    registryManagerStub: sinon.SinonStubbedInstance<RegistryManager>,
    sandbox: sinon.SinonSandbox
): void {
  Object.defineProperty(registryManagerStub, 'autoUpdateService', {
    get: () => ({
      getAllAutoUpdatePreferences: sandbox.stub().resolves({})
    }),
    configurable: true
  });
}

/**
 * Complete setup for RegistryTreeProvider tests.
 * Sets up all event mocks and autoUpdateService.
 * @param registryManagerStub - The sinon stub instance of RegistryManager
 * @param hubManagerStub - The sinon stub instance of HubManager
 * @param sandbox - The sinon sandbox to use for creating stubs
 * @example
 * ```typescript
 * setup(() => {
 *     sandbox = sinon.createSandbox();
 *     registryManagerStub = sandbox.createStubInstance(RegistryManager);
 *     hubManagerStub = sandbox.createStubInstance(HubManager);
 *     setupTreeProviderMocks(registryManagerStub, hubManagerStub, sandbox);
 *     provider = new RegistryTreeProvider(registryManagerStub as any, hubManagerStub as any);
 * });
 * ```
 */
export function setupTreeProviderMocks(
    registryManagerStub: sinon.SinonStubbedInstance<RegistryManager>,
    hubManagerStub: sinon.SinonStubbedInstance<HubManager>,
    sandbox: sinon.SinonSandbox
): void {
  setupRegistryManagerEventMocks(registryManagerStub, sandbox);
  setupHubManagerEventMocks(hubManagerStub, sandbox);
  setupAutoUpdateServiceMock(registryManagerStub, sandbox);
}

/**
 * Regex patterns that match valid context values for installed bundle menu items.
 * These patterns correspond to the 'when' clauses in package.json.
 *
 * The package.json uses regex patterns like `/^installed_bundle_auto_disabled/`
 * (without $ anchor) to match context values with any scope suffix.
 *
 * Keep this in sync with package.json contributes.menus.view/item/context
 */
export const VALID_CONTEXT_PATTERNS_FOR_MENUS = [
  // Base context value patterns (match any scope suffix)
  // These match the package.json patterns: viewItem =~ /^installed_bundle_auto_disabled/
  /^installed_bundle_auto_disabled/,
  /^installed_bundle_auto_enabled/,
  /^installed_bundle_updatable_auto_disabled/,
  /^installed_bundle_updatable_auto_enabled/,
  // Scope-specific patterns for scope-related menu options
  // User scope: "Move to Repository (Commit)", "Move to Repository (Local Only)"
  /^installed_bundle.*_user$/,
  // Repository scope patterns
  /^installed_bundle.*_repository_commit$/, // "Switch to Local Only"
  /^installed_bundle.*_repository_local_only$/, // "Switch to Commit"
  /^installed_bundle.*_repository_(commit|local_only)$/ // "Move to User" (matches both)
] as const;

/**
 * Checks if a context value matches any valid pattern for menu items.
 * @param contextValue - The context value to check
 * @returns true if the context value matches a valid pattern
 */
export function isValidContextValue(contextValue: string): boolean {
  return VALID_CONTEXT_PATTERNS_FOR_MENUS.some((pattern) => pattern.test(contextValue));
}

// ============================================================================
// Package.json Pattern Validation
// ============================================================================

/**
 * Menu item definition from package.json
 */
interface PackageJsonMenuItem {
  command: string;
  when?: string;
  group?: string;
}

/**
 * Extracts viewItem regex patterns from package.json contributes.menus section.
 * Returns patterns that match installed bundle context values.
 * @returns Array of RegExp objects extracted from package.json when clauses
 */
export function extractPackageJsonContextPatterns(): RegExp[] {
  // Resolve package.json from the workspace root (handles both src and test-dist locations)
  const packageJsonPath = path.resolve(__dirname, '../../..', 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const menus: PackageJsonMenuItem[] = packageJson.contributes?.menus?.['view/item/context'] ?? [];

  const patternSet = new Set<string>();

  for (const menu of menus) {
    const when = menu.when ?? '';
    // Extract patterns like: viewItem =~ /^installed_bundle.../
    // Only extract patterns that start with installed_bundle (our focus)
    const matches = when.matchAll(/viewItem =~ \/(\^installed_bundle[^/]*)\//g);
    for (const match of matches) {
      patternSet.add(match[1]);
    }
  }

  return Array.from(patternSet).map((source) => new RegExp(source));
}

/**
 * Result of pattern validation between package.json and test helper
 */
export interface PatternValidationResult {
  /** Whether all patterns match */
  valid: boolean;
  /** Patterns in package.json but not in VALID_CONTEXT_PATTERNS_FOR_MENUS */
  missingInHelper: string[];
  /** Patterns in VALID_CONTEXT_PATTERNS_FOR_MENUS but not in package.json */
  extraInHelper: string[];
}

/**
 * Validates that VALID_CONTEXT_PATTERNS_FOR_MENUS matches package.json patterns.
 * Returns validation result with any mismatches.
 * @returns Validation result with missingInHelper and extraInHelper arrays
 */
export function validateContextPatterns(): PatternValidationResult {
  const packagePatterns = extractPackageJsonContextPatterns();
  const helperPatterns = VALID_CONTEXT_PATTERNS_FOR_MENUS;

  // Compare pattern sources (the regex string)
  const packageSources = new Set(packagePatterns.map((p) => p.source));
  const helperSources = new Set(helperPatterns.map((p) => p.source));

  const missingInHelper = [...packageSources].filter((s) => !helperSources.has(s));
  const extraInHelper = [...helperSources].filter((s) => !packageSources.has(s));

  return {
    valid: missingInHelper.length === 0 && extraInHelper.length === 0,
    missingInHelper,
    extraInHelper
  };
}
