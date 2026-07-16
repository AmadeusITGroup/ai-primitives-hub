import type {
  ElasticSearchConfig,
} from '@ai-primitives-hub/core';
import {
  Client,
  ClientOptions,
} from '@elastic/elasticsearch';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  ElasticSearchTransport,
} from '../../src/telemetry/elastic-search-transport';

const baseConfig: ElasticSearchConfig = { node: 'https://es-proxy.example.com:8080' };

function createMockEsClient() {
  const indicesCreate = vi.fn((_params: { index: string }) => Promise.resolve({}));
  const bulk = vi.fn((_params: { index: string; datasource: unknown[]; onDocument: () => { index: object } }) => Promise.resolve({}));
  const close = vi.fn(() => Promise.resolve());
  return { indicesCreate, bulk, close };
}

type MockEsClient = ReturnType<typeof createMockEsClient>;

function toClient(mock: MockEsClient): Client {
  return {
    indices: { create: mock.indicesCreate },
    helpers: { bulk: mock.bulk },
    close: mock.close
  } as unknown as Client;
}

describe('ElasticSearchTransport', () => {
  let mockClient: MockEsClient;
  let lastClientOptions: ClientOptions | undefined;
  let transport: ElasticSearchTransport;

  const buildTransport = (getCACertificates?: (store: 'system' | 'default') => string[]): ElasticSearchTransport => new ElasticSearchTransport({
    createClient: (options) => {
      lastClientOptions = options;
      return toClient(mockClient);
    },
    getCACertificates
  });

  beforeEach(() => {
    vi.useFakeTimers();
    mockClient = createMockEsClient();
    lastClientOptions = undefined;
    transport = buildTransport();
  });

  afterEach(() => {
    transport.dispose();
    vi.useRealTimers();
  });

  describe('registerHub()', () => {
    it('creates the ES client with no auth', async () => {
      await transport.registerHub('hub-1', baseConfig);

      expect(lastClientOptions?.node).toBe('https://es-proxy.example.com:8080');
      expect(lastClientOptions?.auth).toBeUndefined();
    });

    it('passes system + default CA certificates to the ES client when available', async () => {
      // Netskope (and other corporate TLS-inspection) CAs live in the OS trust
      // store, which Node ignores by default. The transport must merge them in
      // so the proxy's re-signed certificate validates.
      const withCa = buildTransport((store) => (store === 'system' ? ['-----SYSTEM CA-----'] : ['-----DEFAULT CA-----']));

      await withCa.registerHub('hub-1', baseConfig);

      const ca = lastClientOptions?.tls?.ca as string[] | undefined;
      expect(Array.isArray(ca)).toBe(true);
      expect(ca).toContain('-----SYSTEM CA-----');
      expect(ca).toContain('-----DEFAULT CA-----');

      withCa.dispose();
    });

    it('does not set tls.ca when the system trust store is empty', async () => {
      const withCa = buildTransport((store) => (store === 'system' ? [] : ['-----DEFAULT CA-----']));

      await withCa.registerHub('hub-1', baseConfig);

      expect(lastClientOptions?.tls?.ca).toBeUndefined();

      withCa.dispose();
    });

    it('registers successfully when no CA certificate reader is injected', async () => {
      await transport.registerHub('hub-1', baseConfig);

      expect(mockClient.indicesCreate).toHaveBeenCalledTimes(1);
      expect(lastClientOptions?.tls?.ca).toBeUndefined();
    });

    it('creates index on registration', async () => {
      await transport.registerHub('hub-1', baseConfig);

      expect(mockClient.indicesCreate).toHaveBeenCalledTimes(1);
      const indexArg = mockClient.indicesCreate.mock.calls[0][0];
      expect(indexArg.index.startsWith('ai-primitives-hub-telemetry-')).toBe(true);
    });

    it('uses custom indexPrefix when provided', async () => {
      await transport.registerHub('hub-1', { ...baseConfig, indexPrefix: 'custom-prefix' });

      const indexArg = mockClient.indicesCreate.mock.calls[0][0];
      expect(indexArg.index.startsWith('custom-prefix-')).toBe(true);
    });

    it('handles resource_already_exists_exception gracefully', async () => {
      mockClient.indicesCreate.mockRejectedValueOnce({
        meta: { body: { error: { type: 'resource_already_exists_exception' } } }
      });

      await expect(transport.registerHub('hub-1', baseConfig)).resolves.toBeUndefined();
    });

    it('does not register the client on other index creation failures', async () => {
      mockClient.indicesCreate.mockRejectedValueOnce(new Error('connection refused'));

      await transport.registerHub('hub-1', baseConfig);

      mockClient.bulk.mockClear();
      transport.send({ timestamp: new Date().toISOString(), eventName: 'test' });
      await vi.advanceTimersByTimeAsync(10_000);

      expect(mockClient.bulk).not.toHaveBeenCalled();
    });

    it('closes the previous client before registering a new one', async () => {
      await transport.registerHub('hub-1', baseConfig);
      mockClient.close.mockClear();

      await transport.registerHub('hub-2', baseConfig);

      expect(mockClient.close).toHaveBeenCalledTimes(1);
    });

    it('flushes queued events after registration, on the next tick', async () => {
      transport.send({ timestamp: new Date().toISOString(), eventName: 'test.event' });

      await transport.registerHub('hub-1', baseConfig);

      // Queued events are flushed immediately on registration (not waiting for the timer)
      expect(mockClient.bulk.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('unregisterHub()', () => {
    it('closes the connection when hubId matches', async () => {
      await transport.registerHub('hub-1', baseConfig);
      mockClient.close.mockClear();

      transport.unregisterHub('hub-1');

      expect(mockClient.close).toHaveBeenCalledTimes(1);
    });

    it('does not close the connection if hubId does not match', async () => {
      await transport.registerHub('hub-1', baseConfig);
      mockClient.close.mockClear();

      transport.unregisterHub('hub-other');

      expect(mockClient.close).not.toHaveBeenCalled();
    });

    it('stops the flush timer on unregister', async () => {
      await transport.registerHub('hub-1', baseConfig);
      mockClient.bulk.mockClear();

      transport.unregisterHub('hub-1');

      transport.send({ timestamp: new Date().toISOString(), eventName: 'test.event' });
      await vi.advanceTimersByTimeAsync(10_000);

      // No active client, so bulk should not be called even after the timer fires
      expect(mockClient.bulk).not.toHaveBeenCalled();
    });
  });

  describe('send() — batched', () => {
    it('does not send immediately when a client is active', async () => {
      await transport.registerHub('hub-1', baseConfig);
      mockClient.bulk.mockClear();

      transport.send({ timestamp: new Date().toISOString(), eventName: 'test.event' });

      expect(mockClient.bulk).not.toHaveBeenCalled();
    });

    it('flushes buffered events after 10 seconds', async () => {
      await transport.registerHub('hub-1', baseConfig);
      mockClient.bulk.mockClear();

      transport.send({ timestamp: new Date().toISOString(), eventName: 'e1' });
      transport.send({ timestamp: new Date().toISOString(), eventName: 'e2' });

      await vi.advanceTimersByTimeAsync(10_000);

      expect(mockClient.bulk).toHaveBeenCalledTimes(1);
      expect(mockClient.bulk.mock.calls[0][0].datasource.length).toBe(2);
    });

    it('does not call bulk when the buffer is empty at flush time', async () => {
      await transport.registerHub('hub-1', baseConfig);
      mockClient.bulk.mockClear();

      await vi.advanceTimersByTimeAsync(10_000);

      expect(mockClient.bulk).not.toHaveBeenCalled();
    });

    it('flushes repeatedly every 10 seconds', async () => {
      await transport.registerHub('hub-1', baseConfig);
      mockClient.bulk.mockClear();

      transport.send({ timestamp: new Date().toISOString(), eventName: 'e1' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockClient.bulk).toHaveBeenCalledTimes(1);

      transport.send({ timestamp: new Date().toISOString(), eventName: 'e2' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockClient.bulk).toHaveBeenCalledTimes(2);
    });

    it('queues events before registration and flushes them on register', async () => {
      transport.send({ timestamp: new Date().toISOString(), eventName: 'e1' });
      transport.send({ timestamp: new Date().toISOString(), eventName: 'e2' });

      expect(mockClient.bulk).not.toHaveBeenCalled();

      await transport.registerHub('hub-1', baseConfig);

      expect(mockClient.bulk).toHaveBeenCalledTimes(1);
      expect(mockClient.bulk.mock.calls[0][0].datasource.length).toBe(2);
    });
  });

  describe('queue overflow', () => {
    it('drops the oldest events once the queue exceeds MAX_QUEUE_SIZE', async () => {
      for (let i = 0; i < 501; i++) {
        transport.send({ timestamp: new Date().toISOString(), eventName: `e${i}` });
      }

      await transport.registerHub('hub-1', baseConfig);

      const bulkArgs = mockClient.bulk.mock.calls[0][0];
      expect(bulkArgs.datasource.length).toBeLessThanOrEqual(500);
    });
  });
});
