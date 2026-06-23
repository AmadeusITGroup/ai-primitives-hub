import * as tls from 'node:tls';
import {
  Client,
  ClientOptions,
} from '@elastic/elasticsearch';
import * as vscode from 'vscode';
import {
  ElasticSearchConfig,
} from '../types/hub';
import {
  TelemetryDocument,
  TelemetryTransport,
} from '../types/telemetry';
import {
  Logger,
} from '../utils/logger';
import {
  HubManager,
} from './hub-manager';

interface ActiveClient {
  client: Client;
  indexPrefix: string;
  hubId: string;
}

/** Maximum queued documents before oldest entries are dropped. */
const MAX_QUEUE_SIZE = 500;

/** Interval in milliseconds between batched flushes. */
const FLUSH_INTERVAL_MS = 10_000;

/**
 * Manages the Elastic Search transport layer for telemetry.
 *
 * Handles ES client lifecycle (connect/disconnect per hub), event queuing
 * during startup, batched bulk indexing every 10s, and monthly index rotation.
 *
 * Authentication is handled by the es-telemetry-proxy — this client sends
 * unauthenticated requests to the proxy URL.
 */
export class ElasticSearchTransport implements TelemetryTransport {
  private activeClient: ActiveClient | undefined;
  private readonly pendingDocuments: TelemetryDocument[] = [];
  private readonly logger = Logger.getInstance();
  private debugChannel: vscode.OutputChannel | undefined;
  private disposables: vscode.Disposable[] = [];
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private warnedNoSystemCaApi = false;

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    // Route every level through the main logger (which gates by LOG_LEVEL) so the
    // connection lifecycle is observable in the "AI Primitives Hub" output channel,
    // not just on warn/error. The dedicated debug channel (only present with the
    // ES_LOCAL_URL dev override) mirrors everything when enabled.
    this.logger[level](`[ES Transport] ${message}`);
    if (this.debugChannel) {
      const timestamp = new Date().toISOString();
      this.debugChannel.appendLine(`[${timestamp}] ${level.toUpperCase()}: ${message}`);
    }
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
    this.log('info', `Flushing ${docs.length} event(s) to hub "${this.activeClient.hubId}"`);
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
      this.log('error', `Failed to index ${docs.length} event(s) to hub "${hubId}": ${err}`);
    });
  }

  /**
   * Build the CA trust bundle the ES client should use.
   *
   * Corporate TLS-inspection proxies (e.g. Netskope) re-sign connections with a
   * CA that lives in the OS trust store, which Node ignores in favour of its own
   * bundled Mozilla roots. We merge the OS store ('system') with Node's defaults
   * ('default', which also includes NODE_EXTRA_CA_CERTS) so the re-signed cert
   * validates without disabling verification.
   *
   * Returns `undefined` (leaving Node's default trust untouched) when the runtime
   * lacks `tls.getCACertificates` (Node < 22.15) or the system store yields nothing.
   */
  private resolveCACertificates(): string[] | undefined {
    if (typeof tls.getCACertificates !== 'function') {
      if (!this.warnedNoSystemCaApi) {
        this.warnedNoSystemCaApi = true;
        this.log('warn', 'tls.getCACertificates unavailable on this runtime (Node < 22.15); system-CA trust disabled');
      }
      return undefined;
    }

    const readStore = (store: 'system' | 'default'): string[] => {
      try {
        return tls.getCACertificates(store);
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
    this.log('info', `Buffering event: ${doc.eventName ?? 'error'}`);
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
      this.log('info', `Registering ES client for hub "${hubId}" at ${config.node}`);
      this.closeActiveClient();
      this.stopFlushTimer();

      const ca = this.resolveCACertificates();
      const clientOptions: ClientOptions = { node: config.node };
      if (ca) {
        clientOptions.tls = { ca };
        this.log('info', `Loaded ${ca.length} CA certificate(s) from the system + default trust stores`);
      } else {
        this.log('info', 'Using Node default CA trust (no system-store certificates merged)');
      }
      const client = new Client(clientOptions);

      const indexPrefix = config.indexPrefix ?? 'prompt-registry-telemetry';
      const indexName = ElasticSearchTransport.currentIndexName(indexPrefix);

      try {
        await client.indices.create({ index: indexName });
      } catch (err: unknown) {
        if (!isIndexAlreadyExistsError(err)) {
          throw err;
        }
      }

      this.activeClient = { client, indexPrefix, hubId };
      this.log('info', `Registered ES client for hub "${hubId}" at ${config.node} (index "${indexName}")`);

      this.flushPending();
      this.startFlushTimer();
    } catch (error) {
      this.log('error', `Failed to register ES client for hub "${hubId}": ${error}`);
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
      this.log('info', `Unregistered ES client for hub "${hubId}"`);
    }
  }

  /**
   * Subscribe to hub lifecycle events so the ES client is automatically
   * registered/unregistered as the active hub changes.
   * @param hubManager - the hub manager to subscribe to
   */
  public subscribeToHubEvents(hubManager: HubManager): void {
    const esLocalUrl = process.env.ES_LOCAL_URL;
    if (esLocalUrl) {
      this.debugChannel = vscode.window.createOutputChannel('AI Primitives Hub - Elastic Search');
      this.log('info', `Dev override: using ES_LOCAL_URL=${esLocalUrl}`);
      void this.registerHub('dev-local', { node: esLocalUrl });
      return;
    }

    const registerHubEs = async (hubId: string): Promise<void> => {
      try {
        const hubData = await hubManager.loadHub(hubId);
        const esConfig = hubData.config.telemetry?.elasticSearch;
        if (esConfig) {
          await this.registerHub(hubId, esConfig);
        }
      } catch (error) {
        this.log('warn', `Failed to register telemetry for hub "${hubId}" (non-fatal): ${error}`);
      }
    };

    const registerIfActive = async (hubId: string): Promise<void> => {
      const activeId = await hubManager.getActiveHubId();
      if (hubId === activeId) {
        void registerHubEs(hubId);
      }
    };

    this.disposables.push(
      hubManager.onHubImported((hubId) => {
        void registerIfActive(hubId);
      }),
      hubManager.onHubSynced((hubId) => {
        void registerIfActive(hubId);
      }),
      hubManager.onHubDeleted((hubId) => {
        this.unregisterHub(hubId);
      }),
      hubManager.onActiveHubChanged(({ oldHubId, newHubId }) => {
        if (oldHubId) {
          this.unregisterHub(oldHubId);
        }
        if (newHubId) {
          void registerHubEs(newHubId);
        }
      })
    );

    // Register the current active hub at startup
    void hubManager.getActiveHubId().then((activeHubId) => {
      if (activeHubId) {
        void registerHubEs(activeHubId);
      }
    });
  }

  public dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    this.stopFlushTimer();
    this.pendingDocuments.length = 0;
    this.closeActiveClient();
    this.debugChannel?.dispose();
  }
}

function isIndexAlreadyExistsError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const e = err as { meta?: { body?: { error?: { type?: string } } } };
  return e.meta?.body?.error?.type === 'resource_already_exists_exception';
}
