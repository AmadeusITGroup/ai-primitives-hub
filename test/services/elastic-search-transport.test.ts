import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  ElasticSearchTransport,
} from '../../src/services/elastic-search-transport';
import {
  ElasticSearchConfig,
  HubConfig,
} from '../../src/types/hub';
import {
  TelemetryDocument,
} from '../../src/types/telemetry';

suite('ElasticSearchTransport', () => {
  let sandbox: sinon.SinonSandbox;
  let transport: ElasticSearchTransport;
  let clock: sinon.SinonFakeTimers;

  let indicesCreateStub: sinon.SinonStub;
  let bulkStub: sinon.SinonStub;
  let closeStub: sinon.SinonStub;
  let lastClientOptions: any;

  const esModule = require('@elastic/elasticsearch');
  const originalClient = esModule.Client;

  // Production code does `import * as tls from 'node:tls'`, which TypeScript
  // compiles to an __importStar copy whose properties are live getters onto the
  // real module. Stubbing the real module is therefore visible to production
  // code; stubbing a local `import * as tls` copy is not (and its descriptors
  // are non-configurable). So we stub the real module directly.
  const tlsModule = require('node:tls');
  const originalGetCACertificates = tlsModule.getCACertificates;

  const createMockEsClient = () => ({
    indices: { create: indicesCreateStub },
    helpers: { bulk: bulkStub },
    close: closeStub
  }) as any;

  const baseConfig: ElasticSearchConfig = {
    node: 'https://es-proxy.example.com:8080'
  };

  setup(() => {
    sandbox = sinon.createSandbox();
    clock = sinon.useFakeTimers();

    indicesCreateStub = sandbox.stub().resolves({});
    bulkStub = sandbox.stub().resolves({});
    closeStub = sandbox.stub().resolves();
    lastClientOptions = undefined;

    Object.defineProperty(esModule, 'Client', { value: originalClient, writable: true, configurable: true });
    // eslint-disable-next-line prefer-arrow/prefer-arrow-functions -- must be a constructor for `new`
    esModule.Client = function stubClient(options: any) {
      lastClientOptions = options;
      return createMockEsClient();
    };

    transport = new ElasticSearchTransport();
  });

  teardown(() => {
    transport.dispose();
    clock.restore();
    esModule.Client = originalClient;
    tlsModule.getCACertificates = originalGetCACertificates;
    sandbox.restore();
  });

  suite('registerHub()', () => {
    test('should create ES client with no auth', async () => {
      await transport.registerHub('hub-1', baseConfig);

      assert.strictEqual(lastClientOptions.node, 'https://es-proxy.example.com:8080');
      assert.strictEqual(lastClientOptions.auth, undefined);
    });

    test('should pass system + default CA certificates to the ES client when available', async () => {
      // Netskope (and other corporate TLS-inspection) CAs live in the OS trust
      // store, which Node ignores by default. The transport must merge them in
      // so the proxy's re-signed certificate validates.
      const getCaStub = sandbox.stub(tlsModule, 'getCACertificates');
      getCaStub.withArgs('system').returns(['-----SYSTEM CA-----']);
      getCaStub.withArgs('default').returns(['-----DEFAULT CA-----']);

      await transport.registerHub('hub-1', baseConfig);

      assert.ok(Array.isArray(lastClientOptions.tls?.ca), 'expected tls.ca to be an array');
      assert.ok(lastClientOptions.tls.ca.includes('-----SYSTEM CA-----'), 'expected system CA');
      assert.ok(lastClientOptions.tls.ca.includes('-----DEFAULT CA-----'), 'expected default CA bundle');
    });

    test('should not set tls.ca when the system trust store is empty', async () => {
      const getCaStub = sandbox.stub(tlsModule, 'getCACertificates');
      getCaStub.withArgs('system').returns([]);
      getCaStub.withArgs('default').returns(['-----DEFAULT CA-----']);

      await transport.registerHub('hub-1', baseConfig);

      assert.strictEqual(lastClientOptions.tls?.ca, undefined);
    });

    test('should register successfully when tls.getCACertificates is unavailable', async () => {
      // Older Node runtimes (VS Code < ~1.103) lack tls.getCACertificates.
      tlsModule.getCACertificates = undefined;

      await transport.registerHub('hub-1', baseConfig);

      assert.strictEqual(indicesCreateStub.callCount, 1);
      assert.strictEqual(lastClientOptions.tls?.ca, undefined);
    });

    test('should create index on registration', async () => {
      await transport.registerHub('hub-1', baseConfig);

      assert.strictEqual(indicesCreateStub.callCount, 1);
      const indexArg = indicesCreateStub.firstCall.args[0];
      assert.ok(indexArg.index.startsWith('prompt-registry-telemetry-'));
    });

    test('should use custom indexPrefix when provided', async () => {
      await transport.registerHub('hub-1', { ...baseConfig, indexPrefix: 'custom-prefix' });

      const indexArg = indicesCreateStub.firstCall.args[0];
      assert.ok(indexArg.index.startsWith('custom-prefix-'));
    });

    test('should handle resource_already_exists_exception gracefully', async () => {
      indicesCreateStub.rejects({
        meta: { body: { error: { type: 'resource_already_exists_exception' } } }
      });

      await transport.registerHub('hub-1', baseConfig);
    });

    test('should not register client on other index creation failures', async () => {
      indicesCreateStub.rejects(new Error('connection refused'));

      await transport.registerHub('hub-1', baseConfig);

      bulkStub.resetHistory();
      transport.send({ timestamp: new Date().toISOString(), eventName: 'test' });
      clock.tick(10_000);
      assert.strictEqual(bulkStub.callCount, 0);
    });

    test('should close previous client before registering new one', async () => {
      await transport.registerHub('hub-1', baseConfig);
      closeStub.resetHistory();

      await transport.registerHub('hub-2', baseConfig);

      assert.strictEqual(closeStub.callCount, 1);
    });

    test('should flush queued events after registration on next tick', async () => {
      transport.send({ timestamp: new Date().toISOString(), eventName: 'test.event' });

      await transport.registerHub('hub-1', baseConfig);

      // Queued events are flushed immediately on registration (not waiting for timer)
      assert.ok(bulkStub.callCount >= 1);
    });
  });

  suite('unregisterHub()', () => {
    test('should close connection when hubId matches', async () => {
      await transport.registerHub('hub-1', baseConfig);
      closeStub.resetHistory();

      transport.unregisterHub('hub-1');

      assert.strictEqual(closeStub.callCount, 1);
    });

    test('should not close connection if hubId does not match', async () => {
      await transport.registerHub('hub-1', baseConfig);
      closeStub.resetHistory();

      transport.unregisterHub('hub-other');

      assert.strictEqual(closeStub.callCount, 0);
    });

    test('should stop the flush timer on unregister', async () => {
      await transport.registerHub('hub-1', baseConfig);
      bulkStub.resetHistory();

      transport.unregisterHub('hub-1');

      transport.send({ timestamp: new Date().toISOString(), eventName: 'test.event' });
      clock.tick(10_000);

      // No active client, so bulk should not be called even after timer fires
      assert.strictEqual(bulkStub.callCount, 0);
    });
  });

  suite('send() — batched', () => {
    test('should not send immediately when client is active', async () => {
      await transport.registerHub('hub-1', baseConfig);
      bulkStub.resetHistory();

      transport.send({ timestamp: new Date().toISOString(), eventName: 'test.event' });

      // Not sent immediately
      assert.strictEqual(bulkStub.callCount, 0);
    });

    test('should flush buffered events after 10 seconds', async () => {
      await transport.registerHub('hub-1', baseConfig);
      bulkStub.resetHistory();

      transport.send({ timestamp: new Date().toISOString(), eventName: 'e1' });
      transport.send({ timestamp: new Date().toISOString(), eventName: 'e2' });

      clock.tick(10_000);

      assert.strictEqual(bulkStub.callCount, 1);
      assert.strictEqual(bulkStub.firstCall.args[0].datasource.length, 2);
    });

    test('should not call bulk when buffer is empty at flush time', async () => {
      await transport.registerHub('hub-1', baseConfig);
      bulkStub.resetHistory();

      clock.tick(10_000);

      assert.strictEqual(bulkStub.callCount, 0);
    });

    test('should flush repeatedly every 10 seconds', async () => {
      await transport.registerHub('hub-1', baseConfig);
      bulkStub.resetHistory();

      transport.send({ timestamp: new Date().toISOString(), eventName: 'e1' });
      clock.tick(10_000);
      assert.strictEqual(bulkStub.callCount, 1);

      transport.send({ timestamp: new Date().toISOString(), eventName: 'e2' });
      clock.tick(10_000);
      assert.strictEqual(bulkStub.callCount, 2);
    });

    test('should queue events before registration and flush on register', async () => {
      const doc1: TelemetryDocument = { timestamp: new Date().toISOString(), eventName: 'e1' };
      const doc2: TelemetryDocument = { timestamp: new Date().toISOString(), eventName: 'e2' };

      transport.send(doc1);
      transport.send(doc2);

      assert.strictEqual(bulkStub.callCount, 0);

      await transport.registerHub('hub-1', baseConfig);

      assert.strictEqual(bulkStub.callCount, 1);
      assert.strictEqual(bulkStub.firstCall.args[0].datasource.length, 2);
    });
  });

  suite('queue overflow', () => {
    test('should drop oldest events when queue exceeds MAX_QUEUE_SIZE', async () => {
      for (let i = 0; i < 501; i++) {
        transport.send({ timestamp: new Date().toISOString(), eventName: `e${i}` });
      }

      await transport.registerHub('hub-1', baseConfig);

      const bulkArgs = bulkStub.firstCall.args[0];
      assert.ok(bulkArgs.datasource.length <= 500);
    });
  });

  suite('subscribeToHubEvents()', () => {
    const createMockHubManager = () => {
      const emitters = {
        hubImported: new vscode.EventEmitter<string>(),
        hubSynced: new vscode.EventEmitter<string>(),
        hubDeleted: new vscode.EventEmitter<string>(),
        activeHubChanged: new vscode.EventEmitter<{ oldHubId: string | null; newHubId: string | null }>()
      };

      let activeHubId: string | null = null;
      const hubConfigs: Map<string, { config: Partial<HubConfig> }> = new Map();

      const mockHubManager = {
        onHubImported: emitters.hubImported.event,
        onHubSynced: emitters.hubSynced.event,
        onHubDeleted: emitters.hubDeleted.event,
        onActiveHubChanged: emitters.activeHubChanged.event,
        getActiveHubId: sandbox.stub().callsFake(() => Promise.resolve(activeHubId)),
        loadHub: sandbox.stub().callsFake((hubId: string) => {
          const hub = hubConfigs.get(hubId);
          if (!hub) {
            return Promise.reject(new Error(`Hub "${hubId}" not found`));
          }
          return Promise.resolve(hub);
        }),
        setActiveHubId: (id: string | null) => {
          activeHubId = id;
        },
        addHub: (hubId: string, esConfig?: ElasticSearchConfig) => {
          hubConfigs.set(hubId, {
            config: {
              telemetry: esConfig ? { elasticSearch: esConfig } : undefined
            }
          });
        }
      };

      return { mockHubManager, emitters };
    };

    const disposeEmitters = (emitters: ReturnType<typeof createMockHubManager>['emitters']): void => {
      Object.values(emitters).forEach((e) => e.dispose());
    };

    const flushAsync = async (): Promise<void> => {
      await clock.tickAsync(0);
      await clock.tickAsync(0);
    };

    test('should register ES client for active hub at startup', async () => {
      const { mockHubManager, emitters } = createMockHubManager();
      mockHubManager.addHub('hub-1', baseConfig);
      mockHubManager.setActiveHubId('hub-1');

      transport.subscribeToHubEvents(mockHubManager as any);
      await flushAsync();

      assert.strictEqual(indicesCreateStub.callCount, 1);

      disposeEmitters(emitters);
    });

    test('should not register when no active hub at startup', async () => {
      const { mockHubManager, emitters } = createMockHubManager();
      mockHubManager.setActiveHubId(null);

      transport.subscribeToHubEvents(mockHubManager as any);
      await flushAsync();

      assert.strictEqual(indicesCreateStub.callCount, 0);

      disposeEmitters(emitters);
    });

    test('should register ES client when active hub changes', async () => {
      const { mockHubManager, emitters } = createMockHubManager();
      mockHubManager.addHub('hub-2', { node: 'https://es2.example.com' });
      mockHubManager.setActiveHubId(null);

      transport.subscribeToHubEvents(mockHubManager as any);
      await flushAsync();

      emitters.activeHubChanged.fire({ oldHubId: null, newHubId: 'hub-2' });
      await flushAsync();

      assert.strictEqual(indicesCreateStub.callCount, 1);
      assert.strictEqual(lastClientOptions.node, 'https://es2.example.com');

      disposeEmitters(emitters);
    });

    test('should unregister old hub when active hub changes', async () => {
      const { mockHubManager, emitters } = createMockHubManager();
      mockHubManager.addHub('hub-1', baseConfig);
      mockHubManager.setActiveHubId('hub-1');

      transport.subscribeToHubEvents(mockHubManager as any);
      await flushAsync();

      closeStub.resetHistory();

      emitters.activeHubChanged.fire({ oldHubId: 'hub-1', newHubId: null });

      assert.strictEqual(closeStub.callCount, 1);

      disposeEmitters(emitters);
    });

    test('should register on hub imported if hub is active', async () => {
      const { mockHubManager, emitters } = createMockHubManager();
      mockHubManager.addHub('hub-1', baseConfig);
      mockHubManager.setActiveHubId('hub-1');

      transport.subscribeToHubEvents(mockHubManager as any);
      await flushAsync();

      indicesCreateStub.resetHistory();

      emitters.hubImported.fire('hub-1');
      await flushAsync();

      assert.strictEqual(indicesCreateStub.callCount, 1);

      disposeEmitters(emitters);
    });

    test('should not register on hub imported if hub is not active', async () => {
      const { mockHubManager, emitters } = createMockHubManager();
      mockHubManager.addHub('hub-1', baseConfig);
      mockHubManager.addHub('hub-2', baseConfig);
      mockHubManager.setActiveHubId('hub-1');

      transport.subscribeToHubEvents(mockHubManager as any);
      await flushAsync();

      indicesCreateStub.resetHistory();

      emitters.hubImported.fire('hub-2');
      await flushAsync();

      assert.strictEqual(indicesCreateStub.callCount, 0);

      disposeEmitters(emitters);
    });

    test('should unregister on hub deleted', async () => {
      const { mockHubManager, emitters } = createMockHubManager();
      mockHubManager.addHub('hub-1', baseConfig);
      mockHubManager.setActiveHubId('hub-1');

      transport.subscribeToHubEvents(mockHubManager as any);
      await flushAsync();

      closeStub.resetHistory();

      emitters.hubDeleted.fire('hub-1');

      assert.strictEqual(closeStub.callCount, 1);

      disposeEmitters(emitters);
    });

    test('should not register hub without ES config', async () => {
      const { mockHubManager, emitters } = createMockHubManager();
      mockHubManager.addHub('hub-no-es');
      mockHubManager.setActiveHubId('hub-no-es');

      transport.subscribeToHubEvents(mockHubManager as any);
      await flushAsync();

      assert.strictEqual(indicesCreateStub.callCount, 0);

      disposeEmitters(emitters);
    });

    test('should use ES_LOCAL_URL dev override when set', async () => {
      const originalEnv = process.env.ES_LOCAL_URL;
      process.env.ES_LOCAL_URL = 'http://localhost:9200';

      try {
        const { mockHubManager, emitters } = createMockHubManager();

        transport.subscribeToHubEvents(mockHubManager as any);
        await flushAsync();

        assert.strictEqual(lastClientOptions.node, 'http://localhost:9200');

        disposeEmitters(emitters);
      } finally {
        if (originalEnv === undefined) {
          delete process.env.ES_LOCAL_URL;
        } else {
          process.env.ES_LOCAL_URL = originalEnv;
        }
      }
    });

    test('should register on hub synced if hub is active', async () => {
      const { mockHubManager, emitters } = createMockHubManager();
      mockHubManager.addHub('hub-1', baseConfig);
      mockHubManager.setActiveHubId('hub-1');

      transport.subscribeToHubEvents(mockHubManager as any);
      await flushAsync();

      indicesCreateStub.resetHistory();

      emitters.hubSynced.fire('hub-1');
      await flushAsync();

      assert.strictEqual(indicesCreateStub.callCount, 1);

      disposeEmitters(emitters);
    });
  });
});
