/**
 * Elastic Search telemetry transport — connection lifecycle (per hub),
 * event queuing during startup, batched bulk indexing every 10s, and
 * monthly index rotation. Ported from the extension's
 * `src/services/elastic-search-transport.ts`, minus its hub-event
 * subscription wiring (`subscribeToHubEvents`) — that half stays
 * extension-side deliberately, per the same "VS Code-event-driven glue
 * with a single consumer, no CLI need yet" precedent as
 * `HubSyncScheduler` (migration plan §9, `HubManager` Stage 5),
 * confirmed with the user rather than assumed.
 *
 * Authentication is handled by the es-telemetry-proxy — this client
 * sends unauthenticated requests to the proxy URL.
 *
 * The ES client, CA-certificate reader, and log sink are all
 * constructor-injected (none of them are read from globals internally)
 * so this class stays testable without mocking `@elastic/elasticsearch`
 * or `node:tls` directly — same dependency-injection idiom as this
 * package's other host-capability-dependent adapters (e.g.
 * `CompositeTokenProvider`, `NodeFileSystem`).
 * @module telemetry/elastic-search-transport
 */
import * as tls from 'node:tls';
import type {
  ElasticSearchConfig,
  TelemetryDocument,
  TelemetryTransport,
} from '@ai-primitives-hub/core';
import {
  Client,
  ClientOptions,
} from '@elastic/elasticsearch';

/** Maximum queued documents before oldest entries are dropped. */
const MAX_QUEUE_SIZE = 500;

/** Interval in milliseconds between batched flushes. */
const FLUSH_INTERVAL_MS = 10_000;

export type ElasticSearchTransportLogLevel = 'debug' | 'info' | 'warn' | 'error';

interface ActiveClient {
  client: Client;
  indexPrefix: string;
  hubId: string;
}

export interface ElasticSearchTransportOptions {
  /** Sink for diagnostic messages, however the host chooses to surface them (defaults to a no-op). */
  onLog?: (level: ElasticSearchTransportLogLevel, message: string) => void;
  /** Builds the underlying ES client. Overridable for tests; defaults to `new Client(options)`. */
  createClient?: (options: ClientOptions) => Client;
  /**
   * Reads CA certificates from a trust store, or `undefined` when the
   * host runtime has no such capability (e.g. `node:tls.getCACertificates`
   * on Node < 22.15) — see this module's exported `nodeCACertificateReader()`
   * for the real one. Left `undefined` here disables CA-merging entirely.
   */
  getCACertificates?: (store: 'system' | 'default') => string[];
}

/**
 * Detects whether this Node runtime can read CA certificates from the
 * OS trust store, returning a bound reader if so. Corporate
 * TLS-inspection proxies (e.g. Netskope) re-sign connections with a CA
 * that lives in the OS trust store, which Node ignores in favour of its
 * own bundled Mozilla roots unless this is merged in explicitly.
 * @returns A `(store) => string[]` reader, or `undefined` on runtimes without `tls.getCACertificates` (Node < 22.15).
 */
export function nodeCACertificateReader(): ((store: 'system' | 'default') => string[]) | undefined {
  return typeof tls.getCACertificates === 'function' ? tls.getCACertificates : undefined;
}

export class ElasticSearchTransport implements TelemetryTransport {
  private activeClient: ActiveClient | undefined;
  private readonly pendingDocuments: TelemetryDocument[] = [];
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private warnedNoSystemCaApi = false;
  private readonly onLog: (level: ElasticSearchTransportLogLevel, message: string) => void;
  private readonly createClient: (options: ClientOptions) => Client;
  private readonly getCACertificates: ((store: 'system' | 'default') => string[]) | undefined;

  constructor(options: ElasticSearchTransportOptions = {}) {
    this.onLog = options.onLog ?? ((): void => { /* no-op */ });
    this.createClient = options.createClient ?? ((clientOptions): Client => new Client(clientOptions));
    this.getCACertificates = options.getCACertificates;
  }

  private closeActiveClient(): void {
    if (this.activeClient) {
      void this.activeClient.client.close().catch(() => { /* best-effort */ });
      this.activeClient = undefined;
    }
  }

  private stopFlushTimer(): void {
    if (this.flushTimer !== undefined) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  private startFlushTimer(): void {
    this.stopFlushTimer();
    this.flushTimer = setInterval(() => {
      this.flushPending();
    }, FLUSH_INTERVAL_MS);
  }

  private flushPending(): void {
    if (!this.activeClient || this.pendingDocuments.length === 0) {
      return;
    }
    const docs = this.pendingDocuments.splice(0);
    this.onLog('info', `Flushing ${docs.length} event(s) to hub "${this.activeClient.hubId}"`);
    this.indexDocuments(this.activeClient, docs);
  }

  /**
   * Compute the current monthly index name from the stored prefix.
   * @param prefix - the index name prefix
   */
  private static currentIndexName(prefix: string): string {
    const monthSuffix = new Date().toISOString().slice(0, 7);
    return `${prefix}-${monthSuffix}`;
  }

  private indexDocuments(target: ActiveClient, docs: TelemetryDocument[]): void {
    const { client, indexPrefix, hubId } = target;
    const indexName = ElasticSearchTransport.currentIndexName(indexPrefix);
    client.helpers.bulk({
      index: indexName,
      datasource: docs,
      onDocument: () => ({ index: {} })
    }).catch((err: unknown) => {
      this.onLog('error', `Failed to index ${docs.length} event(s) to hub "${hubId}": ${err}`);
    });
  }

  /**
   * Build the CA trust bundle the ES client should use, merging the OS
   * store ('system') with Node's defaults ('default', which also
   * includes `NODE_EXTRA_CA_CERTS`).
   * @returns `undefined` (leaving Node's default trust untouched) when no CA reader was injected or the system store yields nothing.
   */
  private resolveCACertificates(): string[] | undefined {
    if (!this.getCACertificates) {
      if (!this.warnedNoSystemCaApi) {
        this.warnedNoSystemCaApi = true;
        this.onLog('warn', 'No CA certificate reader available on this host; system-CA trust disabled');
      }
      return undefined;
    }

    const readStore = (store: 'system' | 'default'): string[] => {
      try {
        return this.getCACertificates!(store);
      } catch {
        return [];
      }
    };

    const system = readStore('system');
    if (system.length === 0) {
      return undefined;
    }

    return Array.from(new Set([...system, ...readStore('default')]));
  }

  /**
   * Buffer a document for the next batched flush (every 10s).
   * If no client is active, documents are queued until one registers.
   * @param doc - the telemetry document to send
   */
  public send(doc: TelemetryDocument): void {
    this.onLog('info', `Buffering event: ${doc.eventName ?? 'error'}`);
    if (this.pendingDocuments.length >= MAX_QUEUE_SIZE) {
      this.pendingDocuments.shift();
    }
    this.pendingDocuments.push(doc);
  }

  /**
   * Connect to a hub's Elastic Search proxy.
   * Closes any previously active client, flushes queued events, and starts
   * the periodic flush timer.
   * @param hubId - the hub identifier
   * @param config - Elastic Search connection configuration (proxy URL)
   */
  public async registerHub(hubId: string, config: ElasticSearchConfig): Promise<void> {
    try {
      this.onLog('info', `Registering ES client for hub "${hubId}" at ${config.node}`);
      this.closeActiveClient();
      this.stopFlushTimer();

      const ca = this.resolveCACertificates();
      const clientOptions: ClientOptions = { node: config.node };
      if (ca) {
        clientOptions.tls = { ca };
        this.onLog('info', `Loaded ${ca.length} CA certificate(s) from the system + default trust stores`);
      } else {
        this.onLog('info', 'Using Node default CA trust (no system-store certificates merged)');
      }
      const client = this.createClient(clientOptions);

      const indexPrefix = config.indexPrefix ?? 'ai-primitives-hub-telemetry';
      const indexName = ElasticSearchTransport.currentIndexName(indexPrefix);

      try {
        await client.indices.create({ index: indexName });
      } catch (err: unknown) {
        if (!isIndexAlreadyExistsError(err)) {
          throw err;
        }
      }

      this.activeClient = { client, indexPrefix, hubId };
      this.onLog('info', `Registered ES client for hub "${hubId}" at ${config.node} (index "${indexName}")`);

      this.flushPending();
      this.startFlushTimer();
    } catch (error) {
      this.onLog('error', `Failed to register ES client for hub "${hubId}": ${error}`);
    }
  }

  /**
   * Disconnect the Elastic Search client if it belongs to the given hub.
   * @param hubId - the hub identifier to unregister
   */
  public unregisterHub(hubId: string): void {
    if (this.activeClient?.hubId === hubId) {
      this.closeActiveClient();
      this.stopFlushTimer();
      this.pendingDocuments.length = 0;
      this.onLog('info', `Unregistered ES client for hub "${hubId}"`);
    }
  }

  public dispose(): void {
    this.stopFlushTimer();
    this.pendingDocuments.length = 0;
    this.closeActiveClient();
  }
}

function isIndexAlreadyExistsError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const e = err as { meta?: { body?: { error?: { type?: string } } } };
  return e.meta?.body?.error?.type === 'resource_already_exists_exception';
}
