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
  TelemetryDocument,
  TelemetryTransport,
} from '../../src/types/telemetry';
import {
  Logger,
} from '../../src/utils/logger';
import {
  createMockInstalledBundle,
} from '../helpers/bundle-test-helpers';

class MockTransport implements TelemetryTransport {
  public readonly documents: TelemetryDocument[] = [];
  public send(doc: TelemetryDocument): void {
    this.documents.push(doc);
  }

  public dispose(): void {
    this.documents.length = 0;
  }

  public last(): TelemetryDocument {
    assert.ok(this.documents.length > 0, 'Expected at least one telemetry document');
    return this.documents.at(-1)!;
  }
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
  let mockTransport: MockTransport;

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

    mockTransport = new MockTransport();
    service.addTransport(mockTransport);
  });

  teardown(() => {
    service.dispose();
    TelemetryService.resetInstance();
    sandbox.restore();
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

        const doc = mockTransport.last();
        assert.strictEqual(doc.eventName, 'bundle.installed');
        assert.strictEqual(doc.data?.bundleId, 'my-bundle');
        assert.strictEqual(doc.data?.version, '1.0.0');
        assert.strictEqual(doc.data?.scope, 'user');
        assert.strictEqual(doc.data?.sourceType, 'github');
      });

      test('should default sourceType to unknown when not provided', () => {
        const bundle = createMockInstalledBundle('my-bundle', '1.0.0');
        emitters.bundleInstalled.fire(bundle);

        const doc = mockTransport.last();
        assert.strictEqual(doc.data?.sourceType, 'unknown');
      });

      test('should track bundle.uninstalled with bundleId', () => {
        emitters.bundleUninstalled.fire('my-bundle');

        const doc = mockTransport.last();
        assert.strictEqual(doc.eventName, 'bundle.uninstalled');
        assert.strictEqual(doc.data?.bundleId, 'my-bundle');
      });

      test('should track bundle.updated with bundle details', () => {
        const bundle = createMockInstalledBundle('my-bundle', '2.0.0', {
          scope: 'workspace',
          sourceType: 'local'
        });
        emitters.bundleUpdated.fire(bundle);

        const doc = mockTransport.last();
        assert.strictEqual(doc.eventName, 'bundle.updated');
        assert.strictEqual(doc.data?.bundleId, 'my-bundle');
        assert.strictEqual(doc.data?.version, '2.0.0');
        assert.strictEqual(doc.data?.scope, 'workspace');
        assert.strictEqual(doc.data?.sourceType, 'local');
      });

      test('should track bundles.installed with count and bundleIds', () => {
        const bundles = [
          createMockInstalledBundle('bundle-a', '1.0.0'),
          createMockInstalledBundle('bundle-b', '2.0.0')
        ];
        emitters.bundlesInstalled.fire(bundles);

        const doc = mockTransport.last();
        assert.strictEqual(doc.eventName, 'bundles.installed');
        assert.strictEqual(doc.data?.count, 2);
        assert.deepStrictEqual(doc.data?.bundleIds, ['bundle-a', 'bundle-b']);
      });

      test('should track bundles.uninstalled with count and bundleIds', () => {
        emitters.bundlesUninstalled.fire(['bundle-a', 'bundle-b']);

        const doc = mockTransport.last();
        assert.strictEqual(doc.eventName, 'bundles.uninstalled');
        assert.strictEqual(doc.data?.count, 2);
        assert.deepStrictEqual(doc.data?.bundleIds, ['bundle-a', 'bundle-b']);
      });
    });

    suite('profile events', () => {
      test('should track profile.activated with profile details', () => {
        emitters.profileActivated.fire(createMockProfile({ id: 'p1', name: 'Dev Profile' }));

        const doc = mockTransport.last();
        assert.strictEqual(doc.eventName, 'profile.activated');
        assert.strictEqual(doc.data?.profileId, 'p1');
        assert.strictEqual(doc.data?.name, 'Dev Profile');
      });

      test('should track profile.deactivated with profileId', () => {
        emitters.profileDeactivated.fire('p1');

        const doc = mockTransport.last();
        assert.strictEqual(doc.eventName, 'profile.deactivated');
        assert.strictEqual(doc.data?.profileId, 'p1');
      });

      test('should track profile.created with profile details', () => {
        emitters.profileCreated.fire(createMockProfile({ id: 'p2', name: 'New Profile' }));

        const doc = mockTransport.last();
        assert.strictEqual(doc.eventName, 'profile.created');
        assert.strictEqual(doc.data?.profileId, 'p2');
        assert.strictEqual(doc.data?.name, 'New Profile');
      });

      test('should track profile.updated with profile details', () => {
        emitters.profileUpdated.fire(createMockProfile({ id: 'p1', name: 'Renamed' }));

        const doc = mockTransport.last();
        assert.strictEqual(doc.eventName, 'profile.updated');
        assert.strictEqual(doc.data?.profileId, 'p1');
        assert.strictEqual(doc.data?.name, 'Renamed');
      });

      test('should track profile.deleted with profileId', () => {
        emitters.profileDeleted.fire('p1');

        const doc = mockTransport.last();
        assert.strictEqual(doc.eventName, 'profile.deleted');
        assert.strictEqual(doc.data?.profileId, 'p1');
      });
    });

    suite('source events', () => {
      test('should track source.added with source details', () => {
        emitters.sourceAdded.fire(createMockSource({ id: 's1', type: 'github' }));

        const doc = mockTransport.last();
        assert.strictEqual(doc.eventName, 'source.added');
        assert.strictEqual(doc.data?.sourceId, 's1');
        assert.strictEqual(doc.data?.type, 'github');
      });

      test('should track source.removed with sourceId', () => {
        emitters.sourceRemoved.fire('s1');

        const doc = mockTransport.last();
        assert.strictEqual(doc.eventName, 'source.removed');
        assert.strictEqual(doc.data?.sourceId, 's1');
      });

      test('should track source.updated with sourceId', () => {
        emitters.sourceUpdated.fire('s1');

        const doc = mockTransport.last();
        assert.strictEqual(doc.eventName, 'source.updated');
        assert.strictEqual(doc.data?.sourceId, 's1');
      });

      test('should track source.synced with sourceId and bundleCount', () => {
        emitters.sourceSynced.fire({ sourceId: 's1', bundleCount: 5 });

        const doc = mockTransport.last();
        assert.strictEqual(doc.eventName, 'source.synced');
        assert.strictEqual(doc.data?.sourceId, 's1');
        assert.strictEqual(doc.data?.bundleCount, 5);
      });
    });

    suite('preference events', () => {
      test('should track autoUpdate.preferenceChanged with bundleId and enabled', () => {
        emitters.autoUpdatePreferenceChanged.fire({ bundleId: 'my-bundle', enabled: true });

        const doc = mockTransport.last();
        assert.strictEqual(doc.eventName, 'autoUpdate.preferenceChanged');
        assert.strictEqual(doc.data?.bundleId, 'my-bundle');
        assert.strictEqual(doc.data?.enabled, true);
      });

      test('should track repository.bundlesChanged', () => {
        emitters.repositoryBundlesChanged.fire();

        const doc = mockTransport.last();
        assert.strictEqual(doc.eventName, 'repository.bundlesChanged');
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

    test('should NOT send usage events when level is "off" (usage and errors disabled)', () => {
      TelemetryService.resetInstance();

      (vscode.env as any).createTelemetryLogger = (sender: any, options: any) => {
        const logger = origCreate(sender, options);
        logger.isUsageEnabled = false;
        return logger;
      };

      service = TelemetryService.getInstance();
      const transport = new MockTransport();
      service.addTransport(transport);
      mockTransport = transport;

      const mock = createMockRegistryManager();
      service.subscribeToRegistryEvents(mock.mockRegistryManager as any);

      mock.emitters.bundleInstalled.fire(createMockInstalledBundle('my-bundle', '1.0.0'));

      assert.ok(!transport.documents.some((d) => d.eventName === 'bundle.installed'));

      disposeEmitters(mock.emitters);
    });

    test('should NOT send usage events when level is "error" (only errors enabled)', () => {
      TelemetryService.resetInstance();

      (vscode.env as any).createTelemetryLogger = (sender: any, options: any) => {
        const logger = origCreate(sender, options);
        logger.isUsageEnabled = false;
        return logger;
      };

      service = TelemetryService.getInstance();
      const transport = new MockTransport();
      service.addTransport(transport);
      mockTransport = transport;

      const mock = createMockRegistryManager();
      service.subscribeToRegistryEvents(mock.mockRegistryManager as any);

      mock.emitters.bundleInstalled.fire(createMockInstalledBundle('my-bundle', '1.0.0'));
      mock.emitters.profileActivated.fire(createMockProfile());
      mock.emitters.sourceAdded.fire(createMockSource());

      assert.ok(!transport.documents.some((d) => d.eventName === 'bundle.installed'));
      assert.ok(!transport.documents.some((d) => d.eventName === 'profile.activated'));
      assert.ok(!transport.documents.some((d) => d.eventName === 'source.added'));

      disposeEmitters(mock.emitters);
    });

    test('should send usage events when level is "all"', () => {
      const mock = createMockRegistryManager();
      service.subscribeToRegistryEvents(mock.mockRegistryManager as any);

      mock.emitters.bundleInstalled.fire(createMockInstalledBundle('my-bundle', '1.0.0'));

      const doc = mockTransport.last();
      assert.strictEqual(doc.eventName, 'bundle.installed');

      disposeEmitters(mock.emitters);
    });
  });

  suite('dispose()', () => {
    test('should clean up event subscriptions', () => {
      const { mockRegistryManager, emitters } = createMockRegistryManager();

      service.subscribeToRegistryEvents(mockRegistryManager as any);
      service.dispose();

      const transport = new MockTransport();
      service.addTransport(transport);

      emitters.bundleInstalled.fire(createMockInstalledBundle('test-bundle', '1.0.0'));
      emitters.profileActivated.fire(createMockProfile());
      emitters.sourceAdded.fire(createMockSource());
      emitters.repositoryBundlesChanged.fire();

      assert.strictEqual(transport.documents.length, 0);

      disposeEmitters(emitters);
    });
  });
});
