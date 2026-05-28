import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  TelemetryService,
} from '../../src/services/telemetry-service';
import {
  AutoUpdatePreferenceChangedEvent,
  InstalledBundle,
  Profile,
  RegistrySource,
  SourceSyncedEvent,
} from '../../src/types/registry';
import {
  Logger,
} from '../../src/utils/logger';
import {
  createMockInstalledBundle,
} from '../helpers/bundle-test-helpers';

/**
 * Extract the event name and data from a telemetry log message.
 * The sender formats as: `[Telemetry] ${eventName} ${JSON.stringify(data)}`
 * @param call
 */
function parseTelemetryLog(call: sinon.SinonSpyCall): { eventName: string; data: Record<string, any> } {
  const message: string = call.args[0];
  const match = message.match(/^\[Telemetry\] (\S+)\s*(.*)?$/);
  assert.ok(match, `Expected telemetry log format, got: ${message}`);
  const eventName = match[1];
  const rawData = match[2]?.trim();
  const data = rawData && rawData !== 'undefined' ? JSON.parse(rawData) : {};
  return { eventName, data };
}

/**
 * Create a mock RegistryManager with EventEmitters for all events.
 * Returns both the mock object and all emitters for firing events in tests.
 */
function createMockRegistryManager() {
  const emitters = {
    bundleInstalled: new vscode.EventEmitter<InstalledBundle>(),
    bundleUninstalled: new vscode.EventEmitter<string>(),
    bundleUpdated: new vscode.EventEmitter<InstalledBundle>(),
    bundlesInstalled: new vscode.EventEmitter<InstalledBundle[]>(),
    bundlesUninstalled: new vscode.EventEmitter<string[]>(),
    profileActivated: new vscode.EventEmitter<Profile>(),
    profileDeactivated: new vscode.EventEmitter<string>(),
    profileCreated: new vscode.EventEmitter<Profile>(),
    profileUpdated: new vscode.EventEmitter<Profile>(),
    profileDeleted: new vscode.EventEmitter<string>(),
    sourceAdded: new vscode.EventEmitter<RegistrySource>(),
    sourceRemoved: new vscode.EventEmitter<string>(),
    sourceUpdated: new vscode.EventEmitter<string>(),
    sourceSynced: new vscode.EventEmitter<SourceSyncedEvent>(),
    autoUpdatePreferenceChanged: new vscode.EventEmitter<AutoUpdatePreferenceChangedEvent>(),
    repositoryBundlesChanged: new vscode.EventEmitter<void>()
  };

  const mockRegistryManager = {
    onBundleInstalled: emitters.bundleInstalled.event,
    onBundleUninstalled: emitters.bundleUninstalled.event,
    onBundleUpdated: emitters.bundleUpdated.event,
    onBundlesInstalled: emitters.bundlesInstalled.event,
    onBundlesUninstalled: emitters.bundlesUninstalled.event,
    onProfileActivated: emitters.profileActivated.event,
    onProfileDeactivated: emitters.profileDeactivated.event,
    onProfileCreated: emitters.profileCreated.event,
    onProfileUpdated: emitters.profileUpdated.event,
    onProfileDeleted: emitters.profileDeleted.event,
    onSourceAdded: emitters.sourceAdded.event,
    onSourceRemoved: emitters.sourceRemoved.event,
    onSourceUpdated: emitters.sourceUpdated.event,
    onSourceSynced: emitters.sourceSynced.event,
    onAutoUpdatePreferenceChanged: emitters.autoUpdatePreferenceChanged.event,
    onRepositoryBundlesChanged: emitters.repositoryBundlesChanged.event
  };

  return { mockRegistryManager, emitters };
}

function disposeEmitters(emitters: ReturnType<typeof createMockRegistryManager>['emitters']): void {
  Object.values(emitters).forEach((e) => e.dispose());
}

function createMockProfile(overrides?: Partial<Profile>): Profile {
  return {
    id: 'profile-1',
    name: 'Test Profile',
    description: 'A test profile',
    icon: 'icon',
    bundles: [],
    active: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides
  };
}

function createMockSource(overrides?: Partial<RegistrySource>): RegistrySource {
  return {
    id: 'source-1',
    name: 'Test Source',
    type: 'github',
    url: 'https://github.com/test/repo',
    enabled: true,
    priority: 0,
    ...overrides
  };
}

suite('TelemetryService', () => {
  let sandbox: sinon.SinonSandbox;
  let service: TelemetryService;
  let loggerStub: sinon.SinonStubbedInstance<Logger>;

  setup(() => {
    sandbox = sinon.createSandbox();

    // Stub logger
    const loggerInstance = Logger.getInstance();
    loggerStub = sandbox.stub(loggerInstance);
    loggerStub.debug.returns();
    loggerStub.info.returns();
    loggerStub.warn.returns();
    loggerStub.error.returns();

    // Reset singleton so each test gets a fresh instance
    TelemetryService.resetInstance();
    service = TelemetryService.getInstance();

    // Clear the telemetryService.started call from the constructor
    // so event subscription tests start with a clean call count
    loggerStub.info.resetHistory();
  });

  teardown(() => {
    service.dispose();
    TelemetryService.resetInstance();
    sandbox.restore();
  });

  suite('lifecycle events', () => {
    test('should log telemetryService.started on construction', () => {
      TelemetryService.resetInstance();
      loggerStub.info.resetHistory();

      service = TelemetryService.getInstance();

      assert.strictEqual(loggerStub.info.callCount, 1);
      const { eventName } = parseTelemetryLog(loggerStub.info.firstCall);
      assert.strictEqual(eventName, 'telemetryService.started');
    });

    test('should log telemetryService.stopped on dispose', () => {
      loggerStub.info.resetHistory();

      service.dispose();

      assert.strictEqual(loggerStub.info.callCount, 1);
      const { eventName } = parseTelemetryLog(loggerStub.info.firstCall);
      assert.strictEqual(eventName, 'telemetryService.stopped');
    });
  });

  suite('subscribeToRegistryEvents()', () => {
    let emitters: ReturnType<typeof createMockRegistryManager>['emitters'];

    setup(() => {
      const mock = createMockRegistryManager();
      emitters = mock.emitters;
      service.subscribeToRegistryEvents(mock.mockRegistryManager as any);
    });

    teardown(() => {
      disposeEmitters(emitters);
    });

    suite('bundle events', () => {
      test('should track bundle.installed with bundle details', () => {
        const bundle = createMockInstalledBundle('my-bundle', '1.0.0', {
          scope: 'user',
          sourceType: 'github'
        });
        emitters.bundleInstalled.fire(bundle);

        assert.strictEqual(loggerStub.info.callCount, 1);
        const { eventName, data } = parseTelemetryLog(loggerStub.info.firstCall);
        assert.strictEqual(eventName, 'bundle.installed');
        assert.strictEqual(data.bundleId, 'my-bundle');
        assert.strictEqual(data.version, '1.0.0');
        assert.strictEqual(data.scope, 'user');
        assert.strictEqual(data.sourceType, 'github');
      });

      test('should default sourceType to unknown when not provided', () => {
        const bundle = createMockInstalledBundle('my-bundle', '1.0.0');
        emitters.bundleInstalled.fire(bundle);

        const { data } = parseTelemetryLog(loggerStub.info.firstCall);
        assert.strictEqual(data.sourceType, 'unknown');
      });

      test('should track bundle.uninstalled with bundleId', () => {
        emitters.bundleUninstalled.fire('my-bundle');

        assert.strictEqual(loggerStub.info.callCount, 1);
        const { eventName, data } = parseTelemetryLog(loggerStub.info.firstCall);
        assert.strictEqual(eventName, 'bundle.uninstalled');
        assert.strictEqual(data.bundleId, 'my-bundle');
      });

      test('should track bundle.updated with bundle details', () => {
        const bundle = createMockInstalledBundle('my-bundle', '2.0.0', {
          scope: 'workspace',
          sourceType: 'local'
        });
        emitters.bundleUpdated.fire(bundle);

        assert.strictEqual(loggerStub.info.callCount, 1);
        const { eventName, data } = parseTelemetryLog(loggerStub.info.firstCall);
        assert.strictEqual(eventName, 'bundle.updated');
        assert.strictEqual(data.bundleId, 'my-bundle');
        assert.strictEqual(data.version, '2.0.0');
        assert.strictEqual(data.scope, 'workspace');
        assert.strictEqual(data.sourceType, 'local');
      });

      test('should track bundles.installed with count and bundleIds', () => {
        const bundles = [
          createMockInstalledBundle('bundle-a', '1.0.0'),
          createMockInstalledBundle('bundle-b', '2.0.0')
        ];
        emitters.bundlesInstalled.fire(bundles);

        assert.strictEqual(loggerStub.info.callCount, 1);
        const { eventName, data } = parseTelemetryLog(loggerStub.info.firstCall);
        assert.strictEqual(eventName, 'bundles.installed');
        assert.strictEqual(data.count, 2);
        assert.deepStrictEqual(data.bundleIds, ['bundle-a', 'bundle-b']);
      });

      test('should track bundles.uninstalled with count and bundleIds', () => {
        emitters.bundlesUninstalled.fire(['bundle-a', 'bundle-b']);

        assert.strictEqual(loggerStub.info.callCount, 1);
        const { eventName, data } = parseTelemetryLog(loggerStub.info.firstCall);
        assert.strictEqual(eventName, 'bundles.uninstalled');
        assert.strictEqual(data.count, 2);
        assert.deepStrictEqual(data.bundleIds, ['bundle-a', 'bundle-b']);
      });
    });

    suite('profile events', () => {
      test('should track profile.activated with profile details', () => {
        emitters.profileActivated.fire(createMockProfile({ id: 'p1', name: 'Dev Profile' }));

        assert.strictEqual(loggerStub.info.callCount, 1);
        const { eventName, data } = parseTelemetryLog(loggerStub.info.firstCall);
        assert.strictEqual(eventName, 'profile.activated');
        assert.strictEqual(data.profileId, 'p1');
        assert.strictEqual(data.name, 'Dev Profile');
      });

      test('should track profile.deactivated with profileId', () => {
        emitters.profileDeactivated.fire('p1');

        assert.strictEqual(loggerStub.info.callCount, 1);
        const { eventName, data } = parseTelemetryLog(loggerStub.info.firstCall);
        assert.strictEqual(eventName, 'profile.deactivated');
        assert.strictEqual(data.profileId, 'p1');
      });

      test('should track profile.created with profile details', () => {
        emitters.profileCreated.fire(createMockProfile({ id: 'p2', name: 'New Profile' }));

        assert.strictEqual(loggerStub.info.callCount, 1);
        const { eventName, data } = parseTelemetryLog(loggerStub.info.firstCall);
        assert.strictEqual(eventName, 'profile.created');
        assert.strictEqual(data.profileId, 'p2');
        assert.strictEqual(data.name, 'New Profile');
      });

      test('should track profile.updated with profile details', () => {
        emitters.profileUpdated.fire(createMockProfile({ id: 'p1', name: 'Renamed' }));

        assert.strictEqual(loggerStub.info.callCount, 1);
        const { eventName, data } = parseTelemetryLog(loggerStub.info.firstCall);
        assert.strictEqual(eventName, 'profile.updated');
        assert.strictEqual(data.profileId, 'p1');
        assert.strictEqual(data.name, 'Renamed');
      });

      test('should track profile.deleted with profileId', () => {
        emitters.profileDeleted.fire('p1');

        assert.strictEqual(loggerStub.info.callCount, 1);
        const { eventName, data } = parseTelemetryLog(loggerStub.info.firstCall);
        assert.strictEqual(eventName, 'profile.deleted');
        assert.strictEqual(data.profileId, 'p1');
      });
    });

    suite('source events', () => {
      test('should track source.added with source details', () => {
        emitters.sourceAdded.fire(createMockSource({ id: 's1', type: 'github' }));

        assert.strictEqual(loggerStub.info.callCount, 1);
        const { eventName, data } = parseTelemetryLog(loggerStub.info.firstCall);
        assert.strictEqual(eventName, 'source.added');
        assert.strictEqual(data.sourceId, 's1');
        assert.strictEqual(data.type, 'github');
      });

      test('should track source.removed with sourceId', () => {
        emitters.sourceRemoved.fire('s1');

        assert.strictEqual(loggerStub.info.callCount, 1);
        const { eventName, data } = parseTelemetryLog(loggerStub.info.firstCall);
        assert.strictEqual(eventName, 'source.removed');
        assert.strictEqual(data.sourceId, 's1');
      });

      test('should track source.updated with sourceId', () => {
        emitters.sourceUpdated.fire('s1');

        assert.strictEqual(loggerStub.info.callCount, 1);
        const { eventName, data } = parseTelemetryLog(loggerStub.info.firstCall);
        assert.strictEqual(eventName, 'source.updated');
        assert.strictEqual(data.sourceId, 's1');
      });

      test('should track source.synced with sourceId and bundleCount', () => {
        emitters.sourceSynced.fire({ sourceId: 's1', bundleCount: 5 });

        assert.strictEqual(loggerStub.info.callCount, 1);
        const { eventName, data } = parseTelemetryLog(loggerStub.info.firstCall);
        assert.strictEqual(eventName, 'source.synced');
        assert.strictEqual(data.sourceId, 's1');
        assert.strictEqual(data.bundleCount, 5);
      });
    });

    suite('preference events', () => {
      test('should track autoUpdate.preferenceChanged with bundleId and enabled', () => {
        emitters.autoUpdatePreferenceChanged.fire({ bundleId: 'my-bundle', enabled: true });

        assert.strictEqual(loggerStub.info.callCount, 1);
        const { eventName, data } = parseTelemetryLog(loggerStub.info.firstCall);
        assert.strictEqual(eventName, 'autoUpdate.preferenceChanged');
        assert.strictEqual(data.bundleId, 'my-bundle');
        assert.strictEqual(data.enabled, true);
      });

      test('should track repository.bundlesChanged', () => {
        emitters.repositoryBundlesChanged.fire();

        assert.strictEqual(loggerStub.info.callCount, 1);
        const { eventName } = parseTelemetryLog(loggerStub.info.firstCall);
        assert.strictEqual(eventName, 'repository.bundlesChanged');
      });
    });
  });

  suite('telemetry levels', () => {
    let origCreate: any;

    setup(() => {
      origCreate = (vscode.env as any).createTelemetryLogger;
    });

    teardown(() => {
      (vscode.env as any).createTelemetryLogger = origCreate;
    });

    test('should NOT log usage events when level is "off" (usage and errors disabled)', () => {
      TelemetryService.resetInstance();

      (vscode.env as any).createTelemetryLogger = (sender: any, options: any) => {
        const logger = origCreate(sender, options);
        logger.isUsageEnabled = false;
        return logger;
      };

      loggerStub.info.resetHistory();
      service = TelemetryService.getInstance();

      const mock = createMockRegistryManager();
      service.subscribeToRegistryEvents(mock.mockRegistryManager as any);

      mock.emitters.bundleInstalled.fire(createMockInstalledBundle('my-bundle', '1.0.0'));

      assert.strictEqual(loggerStub.info.callCount, 0);

      disposeEmitters(mock.emitters);
    });

    test('should NOT log usage events when level is "error" (only errors enabled)', () => {
      TelemetryService.resetInstance();

      (vscode.env as any).createTelemetryLogger = (sender: any, options: any) => {
        const logger = origCreate(sender, options);
        // "error" level: usage disabled, errors still enabled
        logger.isUsageEnabled = false;
        return logger;
      };

      loggerStub.info.resetHistory();
      service = TelemetryService.getInstance();

      const mock = createMockRegistryManager();
      service.subscribeToRegistryEvents(mock.mockRegistryManager as any);

      // Usage events should be suppressed
      mock.emitters.bundleInstalled.fire(createMockInstalledBundle('my-bundle', '1.0.0'));
      mock.emitters.profileActivated.fire(createMockProfile());
      mock.emitters.sourceAdded.fire(createMockSource());

      assert.strictEqual(loggerStub.info.callCount, 0);

      disposeEmitters(mock.emitters);
    });

    test('should log usage events when level is "all"', () => {
      // Default mock has isUsageEnabled = true (simulates "all" level)
      const mock = createMockRegistryManager();
      service.subscribeToRegistryEvents(mock.mockRegistryManager as any);

      mock.emitters.bundleInstalled.fire(createMockInstalledBundle('my-bundle', '1.0.0'));

      assert.strictEqual(loggerStub.info.callCount, 1);
      const { eventName } = parseTelemetryLog(loggerStub.info.firstCall);
      assert.strictEqual(eventName, 'bundle.installed');

      disposeEmitters(mock.emitters);
    });
  });

  suite('dispose()', () => {
    test('should clean up event subscriptions', () => {
      const { mockRegistryManager, emitters } = createMockRegistryManager();

      service.subscribeToRegistryEvents(mockRegistryManager as any);
      service.dispose();

      // Reset after dispose (which logs telemetryService.stopped)
      loggerStub.info.resetHistory();

      // Fire events after dispose — should not log anything
      emitters.bundleInstalled.fire(createMockInstalledBundle('test-bundle', '1.0.0'));
      emitters.profileActivated.fire(createMockProfile());
      emitters.sourceAdded.fire(createMockSource());
      emitters.repositoryBundlesChanged.fire();

      assert.strictEqual(loggerStub.info.callCount, 0);

      disposeEmitters(emitters);
    });
  });
});
