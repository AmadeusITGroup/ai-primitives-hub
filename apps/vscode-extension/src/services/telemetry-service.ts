import * as vscode from 'vscode';
import {
  InstalledBundle,
  Profile,
  RegistrySource,
  SourceSyncedEvent,
} from '../types/registry';
import {
  TelemetryDocument,
  TelemetryTransport,
} from '../types/telemetry';
import {
  RegistryManager,
} from './registry-manager';

/**
 * Telemetry service that tracks bundle lifecycle events using VS Code's
 * built-in TelemetryLogger infrastructure.
 *
 * Uses `vscode.env.createTelemetryLogger` with a Logger-backed sender,
 * so VS Code automatically respects the user's telemetry preferences
 * (`telemetry.telemetryLevel`):
 *  - `all`   → usage + error events are sent
 *  - `error` → only error events are sent
 *  - `crash` / `off` → nothing is sent
 *
 * Optionally forwards events to one or more {@link TelemetryTransport}
 * instances (e.g. Elastic Search, console).
 */
export class TelemetryService {
  private static instance: TelemetryService;

  private readonly transports: TelemetryTransport[] = [];
  private readonly telemetryLogger: vscode.TelemetryLogger;
  private disposables: vscode.Disposable[] = [];

  private constructor() {
    const sender: vscode.TelemetrySender = {
      sendEventData: (eventName: string, data?: Record<string, any>) => {
        this.send({ timestamp: new Date().toISOString(), eventName, data });
      },
      sendErrorData: (error: Error, data?: Record<string, any>) => {
        this.send({
          timestamp: new Date().toISOString(),
          error: { message: error.message, stack: error.stack },
          data
        });
      }
    };

    this.telemetryLogger = vscode.env.createTelemetryLogger(sender);
    this.telemetryLogger.logUsage('telemetryService.started');
    this.disposables.push(this.telemetryLogger);
  }

  /**
   * Forward a telemetry document to all attached transports.
   * @param doc - the telemetry document to send
   */
  private send(doc: TelemetryDocument): void {
    this.transports.forEach((transport) => transport.send(doc));
  }

  private trackBundleEvent(eventName: string, bundle: InstalledBundle): void {
    this.telemetryLogger.logUsage(eventName, {
      bundleId: bundle.bundleId,
      version: bundle.version,
      scope: bundle.scope,
      sourceType: bundle.sourceType ?? 'unknown'
    });
  }

  private trackProfileEvent(eventName: string, profile: Profile): void {
    this.telemetryLogger.logUsage(eventName, {
      profileId: profile.id,
      name: profile.name
    });
  }

  private trackSourceEvent(eventName: string, source: RegistrySource): void {
    this.telemetryLogger.logUsage(eventName, {
      sourceId: source.id,
      type: source.type
    });
  }

  private trackSourceSyncedEvent(eventName: string, event: SourceSyncedEvent): void {
    this.telemetryLogger.logUsage(eventName, {
      sourceId: event.sourceId,
      bundleCount: event.bundleCount
    });
  }

  public static getInstance(): TelemetryService {
    if (!TelemetryService.instance) {
      TelemetryService.instance = new TelemetryService();
    }
    return TelemetryService.instance;
  }

  /**
   * Reset the singleton instance (for testing only).
   */
  public static resetInstance(): void {
    if (TelemetryService.instance) {
      TelemetryService.instance.dispose();
    }
    TelemetryService.instance = undefined!;
  }

  /**
   * Add a transport for forwarding telemetry events to an external backend.
   * Multiple transports can be attached; each receives every event.
   * @param transports - the transports to add
   */
  public addTransport(...transports: TelemetryTransport[]): void {
    this.transports.push(...transports);
  }

  /**
   * Subscribe to RegistryManager bundle lifecycle events.
   * Subscriptions are owned by this service and cleaned up on dispose().
   * @param registryManager - the registry manager to subscribe to
   */
  public subscribeToRegistryEvents(registryManager: RegistryManager): void {
    this.disposables.push(
      // Bundle events
      registryManager.onBundleInstalled((bundle) => this.trackBundleEvent('bundle.installed', bundle)),
      registryManager.onBundleUninstalled((bundleId) => this.telemetryLogger.logUsage('bundle.uninstalled', { bundleId })),
      registryManager.onBundleUpdated((bundle) => this.trackBundleEvent('bundle.updated', bundle)),
      registryManager.onBundlesInstalled((bundles) => this.telemetryLogger.logUsage('bundles.installed', { count: bundles.length, bundleIds: bundles.map((b) => b.bundleId) })),
      registryManager.onBundlesUninstalled((bundleIds) => this.telemetryLogger.logUsage('bundles.uninstalled', { count: bundleIds.length, bundleIds })),
      // Profile events
      registryManager.onProfileActivated((profile) => this.trackProfileEvent('profile.activated', profile)),
      registryManager.onProfileDeactivated((profileId) => this.telemetryLogger.logUsage('profile.deactivated', { profileId })),
      registryManager.onProfileCreated((profile) => this.trackProfileEvent('profile.created', profile)),
      registryManager.onProfileUpdated((profile) => this.trackProfileEvent('profile.updated', profile)),
      registryManager.onProfileDeleted((profileId) => this.telemetryLogger.logUsage('profile.deleted', { profileId })),
      // Source events
      registryManager.onSourceAdded((source) => this.trackSourceEvent('source.added', source)),
      registryManager.onSourceRemoved((sourceId) => this.telemetryLogger.logUsage('source.removed', { sourceId })),
      registryManager.onSourceUpdated((sourceId) => this.telemetryLogger.logUsage('source.updated', { sourceId })),
      registryManager.onSourceSynced((event) => this.trackSourceSyncedEvent('source.synced', event)),
      // Preference events
      registryManager.onAutoUpdatePreferenceChanged((event) => this.telemetryLogger.logUsage('autoUpdate.preferenceChanged', { bundleId: event.bundleId, enabled: event.enabled })),
      registryManager.onRepositoryBundlesChanged(() => this.telemetryLogger.logUsage('repository.bundlesChanged'))
    );
  }

  /**
   * Dispose the telemetry logger and all event subscriptions.
   */
  public dispose(): void {
    this.telemetryLogger.logUsage('telemetryService.stopped');
    this.transports.forEach((t) => t.dispose());
    this.transports.length = 0;
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}
