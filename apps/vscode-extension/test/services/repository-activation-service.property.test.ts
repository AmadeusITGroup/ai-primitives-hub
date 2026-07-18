/**
 * RepositoryActivationService Property-Based Tests
 *
 * Property 11: Repository Activation Prompt Behavior
 * For any workspace opened with a valid lockfile (not previously declined),
 * a notification SHALL be displayed offering to enable repository bundles.
 *
 * Validates: Requirements 13.1-13.7
 */

import * as assert from 'node:assert';
import * as fc from 'fast-check';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  HubManager,
} from '../../src/services/hub-manager';
import {
  LockfileManager,
} from '../../src/services/lockfile-manager';
import {
  RepositoryActivationService,
} from '../../src/services/repository-activation-service';
import {
  SetupStateManager,
} from '../../src/services/setup-state-manager';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';
import {
  Lockfile,
} from '../../src/types/lockfile';
import {
  LOCKFILE_DEFAULTS,
  LockfileGenerators,
} from '../helpers/lockfile-test-helpers';
import {
  PropertyTestConfig,
} from '../helpers/property-test-helpers';

const TEST_WORKSPACE_ROOT = '/test/workspace';

/**
 * Feature: repository-level-installation, Property 11: Repository Activation Prompt Behavior
 *
 * For any workspace opened with a valid lockfile (not previously declined),
 * a notification SHALL be displayed offering to enable repository bundles.
 */
suite('RepositoryActivationService - Property Tests', () => {
  let sandbox: sinon.SinonSandbox;
  let showInformationMessageStub: sinon.SinonStub;
  let mockLockfileManager: sinon.SinonStubbedInstance<LockfileManager>;
  let mockHubManager: sinon.SinonStubbedInstance<HubManager>;
  let mockStorage: sinon.SinonStubbedInstance<RegistryStorage>;
  let mockContextGetStub: sinon.SinonStub;

  setup(() => {
    sandbox = sinon.createSandbox();
    showInformationMessageStub = sandbox.stub(vscode.window, 'showInformationMessage');
    mockLockfileManager = sandbox.createStubInstance(LockfileManager);
    mockHubManager = sandbox.createStubInstance(HubManager);
    mockStorage = sandbox.createStubInstance(RegistryStorage);
    mockContextGetStub = sandbox.stub();
    RepositoryActivationService.resetInstance();
  });

  teardown(() => {
    sandbox.restore();
    RepositoryActivationService.resetInstance();
  });

  /** Resets all stubs for this suite: lockfile, hub, storage, and context stubs */
  const resetStubs = (): void => {
    showInformationMessageStub.reset();
    mockLockfileManager.read.reset();
    mockLockfileManager.getLockfilePath.reset();
    mockHubManager.listHubs.reset();
    mockStorage.getSources.reset();
    mockStorage.getContext.reset();
    mockStorage.getInstalledBundles.reset();
    mockContextGetStub.reset();
  };

  const configureMockContext = (declinedRepos: string[] = []): void => {
    mockContextGetStub.returns(declinedRepos);
    mockStorage.getContext.returns({
      globalState: { get: mockContextGetStub }
    } as any);
  };

  test('Property 11: Repository Activation - lockfile presence triggers source detection (no activation prompt per Requirement 1.6)', () => {
    return fc.assert(
      fc.asyncProperty(
        LockfileGenerators.lockfile({ minBundles: 1, maxBundles: 10 }),
        async (lockfile) => {
          resetStubs();
          showInformationMessageStub.resolves('Not now');
          RepositoryActivationService.resetInstance();

          mockLockfileManager.read.resolves(lockfile);
          mockLockfileManager.getLockfilePath.returns('/repo/prompt-registry.lock.json');
          configureMockContext();

          const sourceIds = Object.keys(lockfile.sources || {});
          const configuredSources = sourceIds.map((id) => ({
            id,
            type: lockfile.sources[id].type,
            url: lockfile.sources[id].url,
            name: `Source ${id}`,
            enabled: true,
            priority: 0
          }));
          mockStorage.getSources.resolves(configuredSources as any);
          mockHubManager.listHubs.resolves([]);

          const service = new RepositoryActivationService(
            mockLockfileManager,
            mockHubManager,
            mockStorage,
            TEST_WORKSPACE_ROOT
          );

          await service.checkAndPromptActivation();

          assert.ok(mockLockfileManager.read.calledOnce,
            'Should read lockfile for source detection');
        }
      ),
      { numRuns: PropertyTestConfig.RUNS.THOROUGH }
    );
  });

  test('Property 11: Repository Activation - declined repositories never trigger detection', () => {
    return fc.assert(
      fc.asyncProperty(
        LockfileGenerators.lockfile({ minBundles: 1, maxBundles: 10 }),
        fc.string({ minLength: 5, maxLength: 50 }).map((s) => `/repo/${s.replace(/[^a-zA-Z0-9-]/g, 'a')}`),
        async (lockfile, repositoryPath) => {
          resetStubs();
          RepositoryActivationService.resetInstance();

          mockLockfileManager.read.resolves(lockfile);
          mockLockfileManager.getLockfilePath.returns(`${repositoryPath}/prompt-registry.lock.json`);
          configureMockContext([repositoryPath]);

          const service = new RepositoryActivationService(
            mockLockfileManager,
            mockHubManager,
            mockStorage,
            repositoryPath
          );

          await service.checkAndPromptActivation();

          assert.ok(!showInformationMessageStub.called,
            'Should never prompt for previously declined repositories');
        }
      ),
      { numRuns: PropertyTestConfig.RUNS.THOROUGH }
    );
  });

  test('Property 11: Repository Activation - checks for missing sources when lockfile exists', () => {
    return fc.assert(
      fc.asyncProperty(
        LockfileGenerators.lockfile({ minBundles: 1, maxBundles: 20 }),
        async (lockfile) => {
          resetStubs();
          showInformationMessageStub.resolves('Not now');
          RepositoryActivationService.resetInstance();

          mockLockfileManager.read.resolves(lockfile);
          mockLockfileManager.getLockfilePath.returns('/repo/prompt-registry.lock.json');
          configureMockContext();
          mockStorage.getSources.resolves([]);
          mockHubManager.listHubs.resolves([]);

          const service = new RepositoryActivationService(
            mockLockfileManager,
            mockHubManager,
            mockStorage,
            TEST_WORKSPACE_ROOT
          );

          await service.checkAndPromptActivation();

          assert.ok(mockLockfileManager.read.calledOnce,
            'Should read lockfile to check for missing sources');
        }
      ),
      { numRuns: PropertyTestConfig.RUNS.THOROUGH }
    );
  });

  test('Property 11: Repository Activation - no activation prompt shown (Requirement 1.6)', () => {
    return fc.assert(
      fc.asyncProperty(
        LockfileGenerators.lockfile({ minBundles: 1, maxBundles: 5 }),
        async (lockfile) => {
          resetStubs();
          showInformationMessageStub.resolves('Not now');
          RepositoryActivationService.resetInstance();

          mockLockfileManager.read.resolves(lockfile);
          mockLockfileManager.getLockfilePath.returns('/repo/prompt-registry.lock.json');
          configureMockContext();

          const sourceIds = Object.keys(lockfile.sources || {});
          const configuredSources = sourceIds.map((id) => ({
            id,
            type: lockfile.sources[id].type,
            url: lockfile.sources[id].url,
            name: `Source ${id}`,
            enabled: true,
            priority: 0
          }));
          mockStorage.getSources.resolves(configuredSources as any);
          mockHubManager.listHubs.resolves([]);

          const service = new RepositoryActivationService(
            mockLockfileManager,
            mockHubManager,
            mockStorage,
            TEST_WORKSPACE_ROOT
          );

          await service.checkAndPromptActivation();

          if (showInformationMessageStub.called) {
            const message = showInformationMessageStub.firstCall.args[0] as string;
            assert.ok(!message.toLowerCase().includes('enable'),
              'Should not show activation prompt - files already in repository');
          }
        }
      ),
      { numRuns: PropertyTestConfig.RUNS.THOROUGH }
    );
  });

  test('Property 11: Repository Activation - does not call enableRepositoryBundles automatically', () => {
    return fc.assert(
      fc.asyncProperty(
        LockfileGenerators.lockfile({ minBundles: 1, maxBundles: 5 }),
        async (lockfile) => {
          resetStubs();
          showInformationMessageStub.resolves('Not now');
          RepositoryActivationService.resetInstance();

          mockLockfileManager.read.resolves(lockfile);
          mockLockfileManager.getLockfilePath.returns('/repo/prompt-registry.lock.json');
          configureMockContext();

          const sourceIds = Object.keys(lockfile.sources || {});
          const configuredSources = sourceIds.map((id) => ({
            id,
            type: lockfile.sources[id].type,
            url: lockfile.sources[id].url,
            name: `Source ${id}`,
            enabled: true,
            priority: 0
          }));
          mockStorage.getSources.resolves(configuredSources as any);
          mockHubManager.listHubs.resolves([]);
          mockStorage.getInstalledBundles.resolves([]);

          const service = new RepositoryActivationService(
            mockLockfileManager,
            mockHubManager,
            mockStorage,
            TEST_WORKSPACE_ROOT
          );

          await service.checkAndPromptActivation();

          assert.ok(!mockStorage.getInstalledBundles.called,
            'Should not call getInstalledBundles - files already in repository');
        }
      ),
      { numRuns: PropertyTestConfig.RUNS.THOROUGH }
    );
  });

  test('Property 11: Repository Activation Prompt Behavior - no lockfile means no prompt', () => {
    return fc.assert(
      fc.asyncProperty(
        fc.constant(null),
        async (lockfile) => {
          resetStubs();
          RepositoryActivationService.resetInstance();

          mockLockfileManager.read.resolves(lockfile);

          const service = new RepositoryActivationService(
            mockLockfileManager,
            mockHubManager,
            mockStorage,
            TEST_WORKSPACE_ROOT
          );

          await service.checkAndPromptActivation();

          assert.ok(!showInformationMessageStub.called,
            'Should never prompt when no lockfile exists');
        }
      ),
      { numRuns: PropertyTestConfig.RUNS.THOROUGH }
    );
  });

  test('Property 11: Repository Activation - declined repositories skip source detection', () => {
    return fc.assert(
      fc.asyncProperty(
        LockfileGenerators.lockfile({ minBundles: 1, maxBundles: 5 }),
        fc.string({ minLength: 5, maxLength: 50 }).map((s) => `/repo/${s.replace(/[^a-zA-Z0-9-]/g, 'a')}`),
        async (lockfile, repositoryPath) => {
          resetStubs();
          RepositoryActivationService.resetInstance();

          mockLockfileManager.read.resolves(lockfile);
          mockLockfileManager.getLockfilePath.returns(`${repositoryPath}/prompt-registry.lock.json`);

          mockContextGetStub.callsFake((key: string, defaultValue: any) => {
            if (key === 'repositoryActivation.declined') {
              return [repositoryPath];
            }
            return defaultValue;
          });
          mockStorage.getContext.returns({
            globalState: {
              get: mockContextGetStub,
              update: sandbox.stub()
            }
          } as any);
          mockStorage.getSources.resolves([]);
          mockHubManager.listHubs.resolves([]);

          const service = new RepositoryActivationService(
            mockLockfileManager,
            mockHubManager,
            mockStorage,
            repositoryPath
          );

          await service.checkAndPromptActivation();

          assert.ok(!showInformationMessageStub.called,
            'Should not show any prompt for declined repositories');
        }
      ),
      { numRuns: PropertyTestConfig.RUNS.THOROUGH }
    );
  });
});

/**
 * Feature: repository-level-installation, Property 14: Missing Source/Hub Detection
 *
 * For any workspace opened with a lockfile containing unconfigured sources/hubs,
 * the extension SHALL detect and offer to add them.
 */
suite('RepositoryActivationService - Property Tests (Missing Sources/Hubs)', () => {
  let sandbox: sinon.SinonSandbox;
  let showInformationMessageStub: sinon.SinonStub;
  let mockLockfileManager: sinon.SinonStubbedInstance<LockfileManager>;
  let mockHubManager: sinon.SinonStubbedInstance<HubManager>;
  let mockStorage: sinon.SinonStubbedInstance<RegistryStorage>;

  setup(() => {
    sandbox = sinon.createSandbox();
    showInformationMessageStub = sandbox.stub(vscode.window, 'showInformationMessage');
    mockLockfileManager = sandbox.createStubInstance(LockfileManager);
    mockHubManager = sandbox.createStubInstance(HubManager);
    mockStorage = sandbox.createStubInstance(RegistryStorage);
    RepositoryActivationService.resetInstance();
  });

  teardown(() => {
    sandbox.restore();
    RepositoryActivationService.resetInstance();
  });

  /** Resets stubs for this suite: sources and hubs only (no lockfile/context stubs needed) */
  const resetStubs = (): void => {
    showInformationMessageStub.reset();
    mockStorage.getSources.reset();
    mockHubManager.listHubs.reset();
  };

  test('Property 14: Missing Source/Hub Detection - detects all missing sources', () => {
    return fc.assert(
      fc.asyncProperty(
        LockfileGenerators.lockfile({ minBundles: 1, maxBundles: 5 }),
        async (lockfile) => {
          resetStubs();
          RepositoryActivationService.resetInstance();

          mockStorage.getSources.resolves([]);
          mockHubManager.listHubs.resolves([]);

          const service = new RepositoryActivationService(
            mockLockfileManager,
            mockHubManager,
            mockStorage,
            TEST_WORKSPACE_ROOT
          );

          const result = await service.checkAndOfferMissingSources(lockfile);

          const lockfileSourceIds = Object.keys(lockfile.sources);
          assert.strictEqual(result.missingSources.length, lockfileSourceIds.length,
            'Should detect all missing sources');

          for (const sourceId of lockfileSourceIds) {
            assert.ok(result.missingSources.includes(sourceId),
              `Should detect missing source: ${sourceId}`);
          }
        }
      ),
      { numRuns: PropertyTestConfig.RUNS.THOROUGH }
    );
  });

  test('Property 14: Missing Source/Hub Detection - detects all missing hubs', () => {
    return fc.assert(
      fc.asyncProperty(
        LockfileGenerators.lockfile({ minBundles: 1, maxBundles: 5, includeHubs: true }),
        async (lockfile) => {
          resetStubs();
          RepositoryActivationService.resetInstance();

          mockStorage.getSources.resolves([]);
          mockHubManager.listHubs.resolves([]);

          const service = new RepositoryActivationService(
            mockLockfileManager,
            mockHubManager,
            mockStorage,
            TEST_WORKSPACE_ROOT
          );

          const result = await service.checkAndOfferMissingSources(lockfile);

          if (lockfile.hubs) {
            const lockfileHubIds = Object.keys(lockfile.hubs);
            assert.strictEqual(result.missingHubs.length, lockfileHubIds.length,
              'Should detect all missing hubs');

            for (const hubId of lockfileHubIds) {
              assert.ok(result.missingHubs.includes(hubId),
                `Should detect missing hub: ${hubId}`);
            }
          }
        }
      ),
      { numRuns: PropertyTestConfig.RUNS.THOROUGH }
    );
  });

  test('Property 14: Missing Source/Hub Detection - does not report configured sources', () => {
    return fc.assert(
      fc.asyncProperty(
        LockfileGenerators.consistentLockfile({ minBundles: 1, maxBundles: 5 }),
        async (lockfile) => {
          resetStubs();
          RepositoryActivationService.resetInstance();

          const configuredSources = Object.entries(lockfile.sources).map(([id, source]) => ({
            id,
            type: source.type,
            url: source.url,
            enabled: true
          }));
          mockStorage.getSources.resolves(configuredSources as any);
          mockHubManager.listHubs.resolves([]);

          const service = new RepositoryActivationService(
            mockLockfileManager,
            mockHubManager,
            mockStorage,
            TEST_WORKSPACE_ROOT
          );

          const result = await service.checkAndOfferMissingSources(lockfile);

          assert.strictEqual(result.missingSources.length, 0,
            'Should not report configured sources as missing');
        }
      ),
      { numRuns: PropertyTestConfig.RUNS.THOROUGH }
    );
  });

  test('Property 14: Missing Source/Hub Detection - does not report configured hubs', () => {
    return fc.assert(
      fc.asyncProperty(
        LockfileGenerators.lockfile({ minBundles: 1, maxBundles: 5, includeHubs: true }),
        async (lockfile) => {
          resetStubs();
          RepositoryActivationService.resetInstance();

          mockStorage.getSources.resolves([]);

          if (lockfile.hubs) {
            const configuredHubs = Object.keys(lockfile.hubs).map((id) => ({
              id,
              name: lockfile.hubs![id].name,
              description: '',
              reference: { type: 'url' as const, location: lockfile.hubs![id].url }
            }));
            mockHubManager.listHubs.resolves(configuredHubs);
          } else {
            mockHubManager.listHubs.resolves([]);
          }

          const service = new RepositoryActivationService(
            mockLockfileManager,
            mockHubManager,
            mockStorage,
            TEST_WORKSPACE_ROOT
          );

          const result = await service.checkAndOfferMissingSources(lockfile);

          assert.strictEqual(result.missingHubs.length, 0,
            'Should not report configured hubs as missing');
        }
      ),
      { numRuns: PropertyTestConfig.RUNS.THOROUGH }
    );
  });

  test('Property 14: Missing Source/Hub Detection - offers to add when sources missing', () => {
    return fc.assert(
      fc.asyncProperty(
        LockfileGenerators.lockfile({ minBundles: 1, maxBundles: 5 }),
        fc.constantFrom('Add Sources', 'Not now', undefined),
        async (lockfile, userChoice) => {
          resetStubs();
          showInformationMessageStub.resolves(userChoice);
          RepositoryActivationService.resetInstance();

          mockStorage.getSources.resolves([]);
          mockHubManager.listHubs.resolves([]);

          const service = new RepositoryActivationService(
            mockLockfileManager,
            mockHubManager,
            mockStorage,
            TEST_WORKSPACE_ROOT
          );

          const result = await service.checkAndOfferMissingSources(lockfile);

          if (result.missingSources.length > 0) {
            assert.ok(showInformationMessageStub.called,
              'Should show prompt when sources are missing');
            assert.ok(result.offeredToAdd,
              'Should indicate that offer was made');
          }
        }
      ),
      { numRuns: PropertyTestConfig.RUNS.THOROUGH }
    );
  });

  test('Property 14: Missing Source/Hub Detection - partial configuration detected correctly', () => {
    return fc.assert(
      fc.asyncProperty(
        LockfileGenerators.lockfile({ minBundles: 2, maxBundles: 5 }),
        async (lockfile) => {
          resetStubs();
          RepositoryActivationService.resetInstance();

          const sourceIds = Object.keys(lockfile.sources);
          if (sourceIds.length > 1) {
            const firstSourceId = sourceIds[0];
            const firstSource = lockfile.sources[firstSourceId];
            mockStorage.getSources.resolves([{
              id: firstSourceId,
              type: firstSource.type,
              url: firstSource.url,
              enabled: true
            } as any]);
          } else {
            mockStorage.getSources.resolves([]);
          }

          mockHubManager.listHubs.resolves([]);

          const service = new RepositoryActivationService(
            mockLockfileManager,
            mockHubManager,
            mockStorage,
            TEST_WORKSPACE_ROOT
          );

          const result = await service.checkAndOfferMissingSources(lockfile);

          const totalSources = Object.keys(lockfile.sources).length;
          const configuredCount = sourceIds.length > 1 ? 1 : 0;
          const expectedMissing = totalSources - configuredCount;

          assert.strictEqual(result.missingSources.length, expectedMissing,
            `Should detect ${expectedMissing} missing sources (${totalSources} total - ${configuredCount} configured)`);
        }
      ),
      { numRuns: PropertyTestConfig.RUNS.THOROUGH }
    );
  });

  test('Property 14: Missing Source/Hub Detection - empty lockfile returns empty results', () => {
    return fc.assert(
      fc.asyncProperty(
        fc.constant(null),
        async () => {
          resetStubs();
          RepositoryActivationService.resetInstance();

          const lockfile: Lockfile = {
            $schema: LOCKFILE_DEFAULTS.SCHEMA_URL,
            version: '1.0.0',
            generatedAt: new Date().toISOString(),
            generatedBy: LOCKFILE_DEFAULTS.GENERATED_BY,
            bundles: {},
            sources: {}
          };

          mockStorage.getSources.resolves([]);
          mockHubManager.listHubs.resolves([]);

          const service = new RepositoryActivationService(
            mockLockfileManager,
            mockHubManager,
            mockStorage,
            TEST_WORKSPACE_ROOT
          );

          const result = await service.checkAndOfferMissingSources(lockfile);

          assert.strictEqual(result.missingSources.length, 0,
            'Empty lockfile should have no missing sources');
          assert.strictEqual(result.missingHubs.length, 0,
            'Empty lockfile should have no missing hubs');
          assert.ok(!result.offeredToAdd,
            'Should not offer to add when nothing is missing');
        }
      ),
      { numRuns: PropertyTestConfig.RUNS.THOROUGH }
    );
  });

  test('Property 14: Missing Source/Hub Detection - detection is deterministic', () => {
    return fc.assert(
      fc.asyncProperty(
        LockfileGenerators.lockfile({ minBundles: 1, maxBundles: 5 }),
        async (lockfile) => {
          resetStubs();
          RepositoryActivationService.resetInstance();

          mockStorage.getSources.resolves([]);
          mockHubManager.listHubs.resolves([]);

          const service = new RepositoryActivationService(
            mockLockfileManager,
            mockHubManager,
            mockStorage,
            TEST_WORKSPACE_ROOT
          );

          const result1 = await service.checkAndOfferMissingSources(lockfile);
          const result2 = await service.checkAndOfferMissingSources(lockfile);

          assert.deepStrictEqual(result1.missingSources.toSorted(), result2.missingSources.toSorted(),
            'Missing sources detection should be deterministic');
          assert.deepStrictEqual(result1.missingHubs.toSorted(), result2.missingHubs.toSorted(),
            'Missing hubs detection should be deterministic');
        }
      ),
      { numRuns: PropertyTestConfig.RUNS.THOROUGH }
    );
  });
});

/**
 * Feature: lockfile-timing-and-hub-decoupling, Setup Timing Properties
 *
 * Property 1: Setup Timing Invariant
 * Source/hub detection MUST NOT occur before setup is complete.
 *
 * Property 5: Fail-Open Behavior
 * If SetupStateManager is unavailable, detection MUST proceed.
 *
 * **Validates: Requirements 1.1, 1.2, 1.4, 6.4**
 */
suite('RepositoryActivationService - Setup Timing Properties', () => {
  let sandbox: sinon.SinonSandbox;
  let showInformationMessageStub: sinon.SinonStub;
  let mockLockfileManager: sinon.SinonStubbedInstance<LockfileManager>;
  let mockHubManager: sinon.SinonStubbedInstance<HubManager>;
  let mockStorage: sinon.SinonStubbedInstance<RegistryStorage>;
  let mockSetupStateManager: sinon.SinonStubbedInstance<SetupStateManager>;
  let mockContextGetStub: sinon.SinonStub;

  setup(() => {
    sandbox = sinon.createSandbox();
    showInformationMessageStub = sandbox.stub(vscode.window, 'showInformationMessage');
    mockLockfileManager = sandbox.createStubInstance(LockfileManager);
    mockHubManager = sandbox.createStubInstance(HubManager);
    mockStorage = sandbox.createStubInstance(RegistryStorage);
    mockSetupStateManager = sandbox.createStubInstance(SetupStateManager);
    mockContextGetStub = sandbox.stub();
    RepositoryActivationService.resetInstance();
  });

  teardown(() => {
    sandbox.restore();
    RepositoryActivationService.resetInstance();
  });

  /** Resets all stubs for this suite: includes SetupStateManager stubs */
  const resetStubs = (): void => {
    showInformationMessageStub.reset();
    mockLockfileManager.read.reset();
    mockLockfileManager.getLockfilePath.reset();
    mockHubManager.listHubs.reset();
    mockStorage.getSources.reset();
    mockStorage.getContext.reset();
    mockSetupStateManager.isComplete.reset();
    mockSetupStateManager.getState.reset();
    mockContextGetStub.reset();
  };

  const configureMockContext = (): void => {
    mockContextGetStub.returns([]);
    mockStorage.getContext.returns({
      globalState: { get: mockContextGetStub }
    } as any);
  };

  /**
   * Property 1: Setup Timing Invariant
   *
   * **Validates: Requirements 1.1, 1.4**
   */
  test('Property 1: Setup Timing Invariant - detection never occurs when setup incomplete', () => {
    return fc.assert(
      fc.asyncProperty(
        LockfileGenerators.lockfile({ minBundles: 1, maxBundles: 10 }),
        fc.constantFrom('not_started', 'in_progress', 'incomplete'),
        async (lockfile, setupState) => {
          resetStubs();
          RepositoryActivationService.resetInstance();

          mockSetupStateManager.isComplete.resolves(false);
          mockSetupStateManager.getState.resolves(setupState as any);

          mockLockfileManager.read.resolves(lockfile);
          mockLockfileManager.getLockfilePath.returns('/repo/prompt-registry.lock.json');

          mockStorage.getSources.resolves([]);
          mockHubManager.listHubs.resolves([]);
          configureMockContext();

          const service = new RepositoryActivationService(
            mockLockfileManager,
            mockHubManager,
            mockStorage,
            TEST_WORKSPACE_ROOT,
            undefined,
            mockSetupStateManager
          );

          await service.checkAndPromptActivation();

          assert.ok(!showInformationMessageStub.called,
            `Should NOT show any prompts when setup state is '${setupState}' (not complete)`);
          assert.ok(!mockStorage.getSources.called,
            'Should NOT check for missing sources when setup is incomplete');
        }
      ),
      { numRuns: PropertyTestConfig.RUNS.THOROUGH }
    );
  });

  /**
   * Property 1 (continued): Setup Timing Invariant - detection proceeds when setup IS complete
   *
   * **Validates: Requirements 1.2**
   */
  test('Property 1: Setup Timing Invariant - detection proceeds when setup is complete', () => {
    return fc.assert(
      fc.asyncProperty(
        LockfileGenerators.lockfile({ minBundles: 1, maxBundles: 10 }),
        async (lockfile) => {
          resetStubs();
          showInformationMessageStub.resolves('Not now');
          RepositoryActivationService.resetInstance();

          mockSetupStateManager.isComplete.resolves(true);

          mockLockfileManager.read.resolves(lockfile);
          mockLockfileManager.getLockfilePath.returns('/repo/prompt-registry.lock.json');

          mockStorage.getSources.resolves([]);
          mockHubManager.listHubs.resolves([]);
          configureMockContext();

          const service = new RepositoryActivationService(
            mockLockfileManager,
            mockHubManager,
            mockStorage,
            TEST_WORKSPACE_ROOT,
            undefined,
            mockSetupStateManager
          );

          await service.checkAndPromptActivation();

          assert.ok(mockStorage.getSources.called,
            'Should check for missing sources when setup is complete');
        }
      ),
      { numRuns: PropertyTestConfig.RUNS.THOROUGH }
    );
  });

  /**
   * Property 5: Fail-Open Behavior
   *
   * **Validates: Requirements 6.4**
   */
  test('Property 5: Fail-Open Behavior - detection proceeds when SetupStateManager undefined', () => {
    return fc.assert(
      fc.asyncProperty(
        LockfileGenerators.lockfile({ minBundles: 1, maxBundles: 10 }),
        async (lockfile) => {
          resetStubs();
          showInformationMessageStub.resolves('Not now');
          RepositoryActivationService.resetInstance();

          mockLockfileManager.read.resolves(lockfile);
          mockLockfileManager.getLockfilePath.returns('/repo/prompt-registry.lock.json');

          mockStorage.getSources.resolves([]);
          mockHubManager.listHubs.resolves([]);
          configureMockContext();

          const service = new RepositoryActivationService(
            mockLockfileManager,
            mockHubManager,
            mockStorage,
            TEST_WORKSPACE_ROOT,
            undefined,
            undefined
          );

          await service.checkAndPromptActivation();

          assert.ok(mockStorage.getSources.called,
            'Should proceed with source detection when SetupStateManager is undefined (fail-open)');
        }
      ),
      { numRuns: PropertyTestConfig.RUNS.THOROUGH }
    );
  });

  /**
   * Property 5 (continued): Fail-Open Behavior - contrast with defined SetupStateManager
   *
   * **Validates: Requirements 6.4**
   */
  test('Property 5: Fail-Open Behavior - contrast: defined SetupStateManager blocks when incomplete', () => {
    return fc.assert(
      fc.asyncProperty(
        LockfileGenerators.lockfile({ minBundles: 1, maxBundles: 10 }),
        async (lockfile) => {
          resetStubs();
          RepositoryActivationService.resetInstance();

          mockSetupStateManager.isComplete.resolves(false);

          mockLockfileManager.read.resolves(lockfile);
          mockLockfileManager.getLockfilePath.returns('/repo/prompt-registry.lock.json');

          mockStorage.getSources.resolves([]);
          mockHubManager.listHubs.resolves([]);
          configureMockContext();

          const service = new RepositoryActivationService(
            mockLockfileManager,
            mockHubManager,
            mockStorage,
            TEST_WORKSPACE_ROOT,
            undefined,
            mockSetupStateManager
          );

          await service.checkAndPromptActivation();

          assert.ok(!mockStorage.getSources.called,
            'Should NOT check for missing sources when SetupStateManager is defined and returns incomplete');
        }
      ),
      { numRuns: PropertyTestConfig.RUNS.THOROUGH }
    );
  });

  /**
   * Property 1 & 5 Combined: Deterministic behavior across setup states
   *
   * **Validates: Requirements 1.1, 1.2, 6.4**
   */
  test('Property 1 & 5: Deterministic behavior across setup states', () => {
    return fc.assert(
      fc.asyncProperty(
        LockfileGenerators.lockfile({ minBundles: 1, maxBundles: 5 }),
        fc.constantFrom('undefined', 'complete', 'incomplete'),
        async (lockfile, setupManagerState) => {
          resetStubs();
          showInformationMessageStub.resolves('Not now');
          RepositoryActivationService.resetInstance();

          mockLockfileManager.read.resolves(lockfile);
          mockLockfileManager.getLockfilePath.returns('/repo/prompt-registry.lock.json');

          mockStorage.getSources.resolves([]);
          mockHubManager.listHubs.resolves([]);
          configureMockContext();

          let setupMgr: sinon.SinonStubbedInstance<SetupStateManager> | undefined;
          if (setupManagerState !== 'undefined') {
            mockSetupStateManager.isComplete.resolves(setupManagerState === 'complete');
            setupMgr = mockSetupStateManager;
          }

          const service = new RepositoryActivationService(
            mockLockfileManager,
            mockHubManager,
            mockStorage,
            TEST_WORKSPACE_ROOT,
            undefined,
            setupMgr
          );

          await service.checkAndPromptActivation();

          const shouldProceed = setupManagerState === 'undefined' || setupManagerState === 'complete';

          if (shouldProceed) {
            assert.ok(mockStorage.getSources.called,
              `Should proceed with source detection when setupManagerState='${setupManagerState}'`);
          } else {
            assert.ok(!mockStorage.getSources.called,
              `Should block source detection when setupManagerState='${setupManagerState}'`);
          }
        }
      ),
      { numRuns: PropertyTestConfig.RUNS.THOROUGH }
    );
  });
});
