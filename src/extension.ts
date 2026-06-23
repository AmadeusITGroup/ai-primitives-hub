import * as vscode from 'vscode';
import {
  AddResourceCommand,
} from './commands/add-resource-command';
import {
  BundleCommands,
} from './commands/bundle-commands';
import {
  BundleScopeCommands,
} from './commands/bundle-scope-commands';
import {
  CreateCollectionCommand,
} from './commands/create-collection-command';
import {
  GitHubAuthCommand,
} from './commands/github-auth-command';
import {
  HubCommands,
} from './commands/hub-commands';
import {
  HubIntegrationCommands,
} from './commands/hub-integration-commands';
import {
  HubProfileCommands,
} from './commands/hub-profile-commands';
import {
  ProfileCommands,
} from './commands/profile-commands';
import {
  ScaffoldCommand,
} from './commands/scaffold-command';
import {
  SettingsCommands,
} from './commands/settings-commands';
import {
  SourceCommands,
} from './commands/source-commands';
import {
  ValidateApmCommand,
} from './commands/validate-apm-command';
import {
  ValidateCollectionsCommand,
} from './commands/validate-collections-command';
import {
  getEnabledDefaultHubs,
} from './config/default-hubs';
import {
  CopilotIntegration,
} from './integrations/copilot-integration';
import {
  runSourceIdNormalizationMigration,
} from './migrations/source-id-normalization-migration';
import {
  BundleUpdateNotifications,
} from './notifications/bundle-update-notifications';
import {
  ExtensionNotifications,
} from './notifications/extension-notifications';
import {
  ApmRuntimeManager,
} from './services/apm-runtime-manager';
import {
  AutoUpdateService,
} from './services/auto-update-service';
import {
  ElasticSearchTransport,
} from './services/elastic-search-transport';
import {
  HubManager,
} from './services/hub-manager';
import {
  HubSyncScheduler,
} from './services/hub-sync-scheduler';
import {
  LockfileManager,
} from './services/lockfile-manager';
import {
  MigrationRegistry,
} from './services/migration-registry';
import {
  NotificationManager,
} from './services/notification-manager';
import {
  OutputChannelTransport,
} from './services/output-channel-transport';
import {
  RegistryManager,
} from './services/registry-manager';
import {
  RepositoryActivationService,
} from './services/repository-activation-service';
import {
  SchemaValidator,
} from './services/schema-validator';
import {
  ScopeConflictResolver,
} from './services/scope-conflict-resolver';
import {
  SetupState,
  SetupStateManager,
} from './services/setup-state-manager';
import {
  TelemetryService,
} from './services/telemetry-service';
import {
  UpdateChecker,
} from './services/update-checker';
import {
  UpdateScheduler,
} from './services/update-scheduler';
import {
  HubStorage,
} from './storage/hub-storage';
import {
  MarketplaceViewProvider,
} from './ui/marketplace-view-provider';
import {
  RegistryTreeProvider,
} from './ui/registry-tree-provider';
import {
  StatusBar,
} from './ui/status-bar';
import {
  getValidNotificationPreference,
  getValidUpdateCheckFrequency,
} from './utils/config-type-guards';
import {
  promptGitHubAccountSelection,
} from './utils/github-account-prompt';
import {
  Logger,
} from './utils/logger';
import {
  McpConfigLocator,
} from './utils/mcp-config-locator';

// Module-level variable to store the extension instance for deactivation
let extensionInstance: PromptRegistryExtension | undefined;

/**
 * Main extension class that handles activation, deactivation, and command registration
 */
export class PromptRegistryExtension {
  private readonly logger: Logger;
  private readonly statusBar: StatusBar;
  private readonly notifications: ExtensionNotifications;
  private readonly registryManager: RegistryManager;
  private treeProvider: RegistryTreeProvider | undefined;
  private marketplaceProvider: MarketplaceViewProvider | undefined;
  private profileCommands: ProfileCommands | undefined;
  private sourceCommands: SourceCommands | undefined;
  private bundleCommands: BundleCommands | undefined;
  private bundleScopeCommands: BundleScopeCommands | undefined;
  private settingsCommands: SettingsCommands | undefined;
  private hubCommands: HubCommands | undefined;
  private hubIntegrationCommands: HubIntegrationCommands | undefined;
  private hubProfileCommands: HubProfileCommands | undefined;
  private hubManager: HubManager | undefined;
  private setupStateManager: SetupStateManager | undefined;
  private validateCollectionsCommand: ValidateCollectionsCommand | undefined;
  private validateApmCommand: ValidateApmCommand | undefined;
  private createCollectionCommand: CreateCollectionCommand | undefined;
  private copilotIntegration: CopilotIntegration | undefined;

  // Hub sync scheduler
  private hubSyncScheduler: HubSyncScheduler | undefined;

  // Update notification services
  private updateScheduler: UpdateScheduler | undefined;
  private updateChecker: UpdateChecker | undefined;
  private notificationManager: NotificationManager | undefined;
  private autoUpdateService: AutoUpdateService | undefined;

  // Telemetry
  private telemetryService: TelemetryService | undefined;

  // Repository-level installation services
  private lockfileManager: LockfileManager | undefined;
  private repositoryActivationService: RepositoryActivationService | undefined;

  private disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.logger = Logger.getInstance();
    this.statusBar = StatusBar.getInstance();
    this.notifications = ExtensionNotifications.getInstance();
    this.registryManager = RegistryManager.getInstance(context);
  }

  /**
   * Activate the extension
   */
  /**
   * Extract bundleId from various argument types (string, TreeItem, InstalledBundle)
   * @param arg
   */
  private extractBundleId(arg?: any): string | undefined {
    if (typeof arg === 'string') {
      return arg;
    } else if (arg?.data?.bundleId) {
      // TreeView RegistryTreeItem with InstalledBundle data
      return arg.data.bundleId;
    } else if (arg?.bundleId) {
      // Direct InstalledBundle or Bundle object
      return arg.bundleId;
    }
    return undefined;
  }

  /**
   * Initialize telemetry service and subscribe to events.
   */
  private initializeTelemetry(): void {
    try {
      this.telemetryService = TelemetryService.getInstance();
      this.telemetryService.subscribeToRegistryEvents(this.registryManager);
      this.telemetryService.addTransport(new OutputChannelTransport());

      if (this.hubManager) {
        const esTransport = new ElasticSearchTransport();
        esTransport.subscribeToHubEvents(this.hubManager);
        this.telemetryService.addTransport(esTransport);
      }
    } catch (error) {
      this.logger.warn('Failed to initialize telemetry service (non-fatal)', error);
    }
  }

  /**
   * Run data migrations (idempotent).
   * Migrations use MigrationRegistry (globalState) to track completion.
   */
  private async runMigrations(): Promise<void> {
    try {
      const migrationRegistry = MigrationRegistry.getInstance(this.context);
      const registryStorage = this.registryManager.getStorage();
      await runSourceIdNormalizationMigration(registryStorage, migrationRegistry);
    } catch (error) {
      this.logger.warn('Migration failed (non-fatal)', error);
      // Don't fail activation if migrations fail
    }
  }

  /**
   * Register all extension commands
   */
  private registerCommands(): void {
    // Initialize Command Handlers
    this.profileCommands = new ProfileCommands(this.registryManager);
    this.sourceCommands = new SourceCommands(this.registryManager);
    this.settingsCommands = new SettingsCommands(this.registryManager);
    this.bundleCommands = new BundleCommands(this.registryManager);

    // Initialize hub infrastructure
    const hubStoragePath = this.context.globalStorageUri.fsPath;
    const hubStorage = new HubStorage(hubStoragePath);
    const hubValidator = new SchemaValidator(this.context.extensionPath);
    // Pass BundleInstaller from RegistryManager to enable bundle installation during profile activation
    const bundleInstaller = this.registryManager.getBundleInstaller();
    this.hubManager = new HubManager(hubStorage, hubValidator, this.context.extensionPath, bundleInstaller, this.registryManager);

    // Connect HubManager to RegistryManager for profile integration
    this.registryManager.setHubManager(this.hubManager);

    // Initialize SetupStateManager for first-run configuration
    this.setupStateManager = SetupStateManager.getInstance(this.context, this.hubManager);

    this.hubCommands = new HubCommands(this.hubManager, this.registryManager, this.context);
    this.hubIntegrationCommands = new HubIntegrationCommands(this.hubManager, this.context);
    this.hubProfileCommands = new HubProfileCommands(this.context);

    // Wire event-driven source sync after every hub sync (activation, manual, periodic).
    // This replaces the ad-hoc syncAllSources call that was previously in syncActiveHub().
    this.hubManager.onHubSynced(async (hubId) => {
      this.logger.info(`Hub synced (${hubId}), syncing all sources...`);
      try {
        await this.sourceCommands!.syncAllSources({ silent: true });
        vscode.commands.executeCommand('promptRegistry.refresh');
      } catch (error) {
        this.logger.warn('Source sync after hub sync failed', error);
      }
    });

    // Initialize periodic hub sync scheduler (24h interval)
    this.hubSyncScheduler = new HubSyncScheduler(this.context, this.hubManager);
    this.hubSyncScheduler.initialize(); // Synchronous — only starts timers

    // Note: scaffoldCommand is registered inline in command handler
    const addResourceCommand = new AddResourceCommand(this.context.extensionPath);
    const githubAuthCommand = new GitHubAuthCommand(this.registryManager);
    this.validateCollectionsCommand = new ValidateCollectionsCommand(this.context);
    this.validateApmCommand = new ValidateApmCommand(this.context);
    this.createCollectionCommand = new CreateCollectionCommand();

    // Register command handlers
    const commands = [
      // Profile Management Commands
      vscode.commands.registerCommand('promptRegistry.createProfile', () => this.profileCommands!.createProfile()),
      vscode.commands.registerCommand('promptRegistry.editProfile', (profileId?) => this.profileCommands!.editProfile(profileId)),
      vscode.commands.registerCommand('promptRegistry.activateProfile', (profileId?) => this.profileCommands!.activateProfile(profileId)),
      vscode.commands.registerCommand('promptRegistry.deactivateProfile', (profileId?) => this.profileCommands!.deactivateProfile(profileId)),
      vscode.commands.registerCommand('promptRegistry.deleteProfile', (profileId?) => this.profileCommands!.deleteProfile(profileId)),
      vscode.commands.registerCommand('promptRegistry.exportProfile', (profileId?) => this.profileCommands!.exportProfile(profileId)),
      vscode.commands.registerCommand('promptRegistry.importProfile', () => this.profileCommands!.importProfile()),
      vscode.commands.registerCommand('promptRegistry.listProfiles', () => this.profileCommands!.listProfiles()),

      // Settings Management Commands
      vscode.commands.registerCommand('promptRegistry.exportSettings', () => this.settingsCommands!.exportSettings()),
      vscode.commands.registerCommand('promptRegistry.importSettings', () => this.settingsCommands!.importSettings()),

      // Source Management Commands
      vscode.commands.registerCommand('promptRegistry.addSource', () => this.sourceCommands!.addSource()),
      vscode.commands.registerCommand('promptRegistry.editSource', (sourceId?) => this.sourceCommands!.editSource(sourceId)),
      vscode.commands.registerCommand('promptRegistry.removeSource', (sourceId?) => this.sourceCommands!.removeSource(sourceId)),
      vscode.commands.registerCommand('promptRegistry.syncSource', (sourceId?) => this.sourceCommands!.syncSource(sourceId)),
      vscode.commands.registerCommand('promptRegistry.syncAllSources', () => this.sourceCommands!.syncAllSources()),
      vscode.commands.registerCommand('promptRegistry.toggleSource', (sourceId?) => this.sourceCommands!.toggleSource(sourceId)),
      vscode.commands.registerCommand('promptRegistry.listSources', () => this.sourceCommands!.listSources()),

      // Bundle Management Commands
      vscode.commands.registerCommand('promptRegistry.searchBundles', () => this.bundleCommands!.searchAndInstall()),
      vscode.commands.registerCommand('promptRegistry.installBundle', (bundleId?) => this.bundleCommands!.installBundle(bundleId)),
      vscode.commands.registerCommand('promptRegistry.uninstallBundle', (arg?) => this.bundleCommands!.uninstallBundle(this.extractBundleId(arg))),
      vscode.commands.registerCommand('promptRegistry.updateBundle', (arg?) => this.bundleCommands!.updateBundle(this.extractBundleId(arg))),
      vscode.commands.registerCommand('promptRegistry.checkBundleUpdates', (arg?) => {
        const bundleId = this.extractBundleId(arg);
        if (bundleId) {
          // Check single bundle update - show dialog instead of directly updating
          void this.bundleCommands!.checkSingleBundleUpdate(bundleId);
        } else {
          // Check all bundles
          void this.bundleCommands!.checkAllUpdates();
        }
      }),
      vscode.commands.registerCommand('promptRegistry.manualCheckForUpdates', async () => {
        await this.handleManualUpdateCheck();
      }),
      vscode.commands.registerCommand('promptRegistry.updateAllBundles', () => this.bundleCommands!.updateAllBundles()),
      vscode.commands.registerCommand('promptRegistry.enableAutoUpdate', (arg?) => this.bundleCommands!.enableAutoUpdate(this.extractBundleId(arg))),
      vscode.commands.registerCommand('promptRegistry.disableAutoUpdate', (arg?) => this.bundleCommands!.disableAutoUpdate(this.extractBundleId(arg))),
      vscode.commands.registerCommand('promptRegistry.viewBundle', async (arg?) => {
        const bundleId = this.extractBundleId(arg);

        // Open in webview details panel (same as marketplace), or fallback to QuickPick view
        await (bundleId && this.marketplaceProvider
          ? this.marketplaceProvider.openBundleDetails(bundleId)
          : this.bundleCommands!.viewBundle(bundleId));
      }),
      vscode.commands.registerCommand('promptRegistry.browseByCategory', () => this.bundleCommands!.browseByCategory()),
      vscode.commands.registerCommand('promptRegistry.showPopular', () => this.bundleCommands!.showPopular()),
      vscode.commands.registerCommand('promptRegistry.listInstalled', () => this.bundleCommands!.listInstalled()),

      // Bundle Scope Management Commands
      vscode.commands.registerCommand('promptRegistry.moveToRepositoryCommit', (arg?) => {
        const bundleId = this.extractBundleId(arg);
        if (bundleId && this.bundleScopeCommands) {
          void this.bundleScopeCommands.moveToRepository(bundleId, 'commit');
        }
      }),
      vscode.commands.registerCommand('promptRegistry.moveToRepositoryLocalOnly', (arg?) => {
        const bundleId = this.extractBundleId(arg);
        if (bundleId && this.bundleScopeCommands) {
          void this.bundleScopeCommands.moveToRepository(bundleId, 'local-only');
        }
      }),
      vscode.commands.registerCommand('promptRegistry.moveToUser', (arg?) => {
        const bundleId = this.extractBundleId(arg);
        if (bundleId && this.bundleScopeCommands) {
          void this.bundleScopeCommands.moveToUser(bundleId);
        }
      }),
      vscode.commands.registerCommand('promptRegistry.switchToLocalOnly', (arg?) => {
        const bundleId = this.extractBundleId(arg);
        if (bundleId && this.bundleScopeCommands) {
          void this.bundleScopeCommands.switchCommitMode(bundleId, 'local-only');
        }
      }),
      vscode.commands.registerCommand('promptRegistry.switchToCommit', (arg?) => {
        const bundleId = this.extractBundleId(arg);
        if (bundleId && this.bundleScopeCommands) {
          void this.bundleScopeCommands.switchCommitMode(bundleId, 'commit');
        }
      }),

      // Cleanup Commands
      vscode.commands.registerCommand('promptRegistry.cleanupStaleLockfileEntries', () => this.bundleCommands!.cleanupStaleLockfileEntries()),

      // Scaffold Command - Create project structure
      vscode.commands.registerCommand('promptRegistry.scaffoldProject', () => ScaffoldCommand.runWithUI()),

      // Add Resource Command - Add individual resources
      vscode.commands.registerCommand('promptRegistry.addResource', async () => {
        await addResourceCommand.execute();
      }),

      // Collection Management Commands
      vscode.commands.registerCommand('promptRegistry.validateCollections', async (options?) => {
        await this.validateCollectionsCommand!.execute(options);
      }),

      vscode.commands.registerCommand('promptRegistry.listCollections', async () => {
        await this.validateCollectionsCommand!.execute({ listOnly: true });
      }),

      vscode.commands.registerCommand('promptRegistry.validateApm', async () => {
        await this.validateApmCommand!.execute();
      }),

      vscode.commands.registerCommand('promptRegistry.createCollection', async () => {
        await this.createCollectionCommand!.execute();
      }),

      // Command Menu - Show all commands
      vscode.commands.registerCommand('promptRegistry.showCommandMenu', async () => {
        await this.showCommandMenu();
      }),

      // Settings Command
      vscode.commands.registerCommand('promptRegistry.openSettings', () => {
        vscode.commands.executeCommand('workbench.action.openSettings', 'promptregistry');
      }),

      // Reset First Run Command
      vscode.commands.registerCommand('promptRegistry.resetFirstRun', async () => {
        if (!this.setupStateManager) {
          this.logger.warn('SetupStateManager not initialized');
          vscode.window.showErrorMessage('Cannot reset first run state: extension not fully initialized');
          return;
        }
        await this.setupStateManager.reset();
        // Clear active hub to ensure hub selector is shown
        await this.hubManager?.setActiveHub(null);
        // Remove any ghost hubs left by failed imports (also removes hub-linked sources)
        await this.hubManager?.deleteAllHubs();
        // Remove any remaining sources not linked to a hub (standalone sources)
        if (this.registryManager) {
          const remainingSources = await this.registryManager.listSources();
          const results = await Promise.allSettled(
            remainingSources.map((s) => this.registryManager.removeSource(s.id))
          );
          const failures = results.filter((r) => r.status === 'rejected');
          if (failures.length > 0) {
            this.logger.warn(`Failed to remove ${failures.length} standalone source(s) during reset`);
          }
        }
        this.logger.info('First run state reset via SetupStateManager');
        if (this.registryManager) {
          const leftover = await this.registryManager.listSources();
          if (leftover.length > 0) {
            vscode.window.showWarningMessage(`First run state reset, but ${leftover.length} source(s) could not be removed. Reload the window to retry.`);
            return;
          }
        }
        vscode.window.showInformationMessage('First run state has been reset. Reload the window to trigger first-run initialization.');
      }),

      // Initialize Hub Command (internal, used by marketplace setup button)
      vscode.commands.registerCommand('promptRegistry.initializeHub', async (options?: { resetAuth?: boolean }) => {
        if (options?.resetAuth && this.hubManager) {
          this.hubManager.clearAuthCache();
        }
        await this.initializeHub();
        // Mark setup complete when hub is initialized via this command (e.g. marketplace button)
        if (this.setupStateManager) {
          await this.setupStateManager.markComplete();
        }
      }),

      vscode.commands.registerCommand('promptregistry.forceGitHubAuth', () => githubAuthCommand.execute())
    ];

    // Add to disposables
    this.disposables.push(...commands);

    // Add to context subscriptions
    this.context.subscriptions.push(...commands);

    this.logger.debug('Commands registered successfully');
  }

  /**
   * Register TreeView for Registry Explorer
   */
  private async registerTreeView(): Promise<void> {
    this.logger.info('Registering Registry Explorer TreeView...');

    // Create tree provider
    this.treeProvider = new RegistryTreeProvider(this.registryManager, this.hubManager!);

    // Initialize favorites view context (starts in 'all' mode)
    vscode.commands.executeCommand('setContext', 'promptRegistry.favoritesViewActive', false);

    // Register tree view
    const treeView = vscode.window.createTreeView('promptRegistryExplorer', {
      treeDataProvider: this.treeProvider,
      showCollapseAll: true
    });

    this.disposables.push(treeView);

    // Register tree view commands
    const treeCommands = [
      vscode.commands.registerCommand('promptRegistry.refresh', () => {
        this.treeProvider?.refresh();
      }),
      vscode.commands.registerCommand('promptRegistry.toggleProfileView', () => {
        this.treeProvider?.toggleViewMode();
      }),
      vscode.commands.registerCommand('promptRegistry.showFavoritesView', () => {
        this.treeProvider?.toggleViewMode();
      }),
      vscode.commands.registerCommand('promptRegistry.hideFavoritesView', () => {
        this.treeProvider?.toggleViewMode();
      })
    ];

    this.disposables.push(...treeCommands);
    this.context.subscriptions.push(...treeCommands);

    this.logger.info('Registry Explorer TreeView registered successfully');
  }

  /**
   * Register Marketplace View for browsing and installing bundles
   */
  private async registerMarketplaceView(): Promise<void> {
    this.logger.info('Registering Marketplace View...');

    // Create marketplace provider
    this.marketplaceProvider = new MarketplaceViewProvider(this.context, this.registryManager, this.setupStateManager!);

    // Register webview view
    const marketplaceView = vscode.window.registerWebviewViewProvider(
      MarketplaceViewProvider.viewType,
      this.marketplaceProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
    );

    this.disposables.push(marketplaceView);
    this.context.subscriptions.push(marketplaceView);

    this.logger.info('Marketplace View registered successfully');
  }

  /**
   * Initialize Copilot Integration
   */
  private async initializeCopilot(): Promise<void> {
    try {
      this.logger.info('Initializing Copilot integration...');

      this.copilotIntegration = new CopilotIntegration(this.context);
      await this.copilotIntegration.activate();

      this.logger.info('Copilot integration initialized successfully');
    } catch (error) {
      this.logger.warn('Failed to initialize Copilot integration', error);
      // Don't fail extension activation if Copilot integration fails
      // It's an optional feature that requires GitHub Copilot
    }
  }

  /**
   * Initialize update notification system
   * Sets up UpdateScheduler, UpdateChecker, NotificationManager, and AutoUpdateService
   * Uses dependency injection to avoid circular dependencies
   */
  private async initializeUpdateSystem(): Promise<void> {
    try {
      this.logger.info('Initializing update notification system...');

      // Get RegistryStorage instance
      const registryStorage = this.registryManager.getStorage();

      // Initialize NotificationManager (singleton)
      this.notificationManager = NotificationManager.getInstance();

      // Initialize UpdateChecker (no circular dependency)
      this.updateChecker = new UpdateChecker(
        this.registryManager,
        registryStorage,
        this.context.globalState
      );

      // Initialize AutoUpdateService with dependency injection
      // Pass RegistryManager methods as functions to avoid circular reference
      const bundleNotifications = new BundleUpdateNotifications(
        async (bundleId: string) => {
          return await this.registryManager.getBundleName(bundleId);
        }
      );

      // Create update service factory to inject dependencies
      this.autoUpdateService = new AutoUpdateService(
        // Bundle operations
        {
          updateBundle: (bundleId: string, version?: string) => this.registryManager.updateBundle(bundleId, version),
          listInstalledBundles: () => this.registryManager.listInstalledBundles(),
          getBundleDetails: (bundleId: string) => this.registryManager.getBundleDetails(bundleId)
        },
        // Source operations
        {
          listSources: () => this.registryManager.listSources(),
          syncSource: (sourceId: string) => this.registryManager.syncSource(sourceId)
        },
        bundleNotifications,
        registryStorage
      );

      // Set AutoUpdateService in RegistryManager for command access
      this.registryManager.setAutoUpdateService(this.autoUpdateService);

      // Initialize UpdateScheduler with AutoUpdateService
      this.updateScheduler = new UpdateScheduler(
        this.context,
        this.updateChecker,
        async (bundleId: string) => {
          return await this.registryManager.getBundleName(bundleId);
        },
        this.autoUpdateService
      );

      // Wire up update detection to tree provider
      if (this.treeProvider) {
        this.updateScheduler.onUpdatesDetected((updates) => {
          this.treeProvider?.onUpdatesDetected(updates);
        });
      }

      // Initialize scheduler (triggers startup check)
      await this.updateScheduler.initialize();

      // Register configuration change listeners
      this.registerUpdateConfigurationListeners();

      this.logger.info('Update notification system initialized successfully');
    } catch (error) {
      this.logger.warn('Failed to initialize update notification system', error);
      // Don't fail extension activation if update system fails
    }
  }

  /**
   * Register configuration change listeners for update system
   * Applies configuration changes immediately without requiring restart
   */
  private registerUpdateConfigurationListeners(): void {
    // Listen for update check configuration changes
    const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('promptregistry.updateCheck')) {
        this.handleUpdateConfigurationChange();
      }
    });

    this.disposables.push(configListener);
    this.context.subscriptions.push(configListener);
  }

  /**
   * Handle update configuration changes
   * Applies new settings immediately to UpdateScheduler
   */
  private handleUpdateConfigurationChange(): void {
    if (!this.updateScheduler) {
      return;
    }

    const config = vscode.workspace.getConfiguration('promptregistry.updateCheck');
    const enabled = config.get<boolean>('enabled', true);
    const rawFrequency = config.get<string>('frequency', 'daily');

    // Validate and sanitize configuration values
    const frequency = getValidUpdateCheckFrequency(rawFrequency, 'daily');

    // Log warning if invalid value was provided
    if (rawFrequency !== frequency) {
      this.logger.warn(
        `Invalid update check frequency "${rawFrequency}" in configuration. Using default "${frequency}".`
      );
    }

    this.logger.info(`Update configuration changed: enabled=${enabled}, frequency=${frequency}`);

    // Apply changes immediately
    this.updateScheduler.updateEnabled(enabled);
    this.updateScheduler.updateSchedule(frequency);
  }

  /**
   * Handle manual update check command
   * Bypasses cache and displays results immediately
   */
  private async handleManualUpdateCheck(): Promise<void> {
    if (!this.updateScheduler || !this.updateChecker || !this.notificationManager) {
      this.logger.warn('Update system not initialized');
      await vscode.window.showWarningMessage('Update system is not initialized yet. Please try again in a moment.');
      return;
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Checking for bundle updates...',
          cancellable: false
        },
        async () => {
          // Trigger manual check (bypasses cache)
          await this.updateScheduler!.checkNow();

          // Get the results
          const updates = await this.updateChecker!.getCachedResults();

          if (!updates || updates.length === 0) {
            await vscode.window.showInformationMessage('All bundles are up to date!');
            return;
          }

          // Show notification with results
          const config = vscode.workspace.getConfiguration('promptregistry.updateCheck');
          const rawNotificationPreference = config.get<string>('notificationPreference', 'all');

          // Validate and sanitize notification preference
          const notificationPreference = getValidNotificationPreference(rawNotificationPreference, 'all');

          // Log warning if invalid value was provided
          if (rawNotificationPreference !== notificationPreference) {
            this.logger.warn(
              `Invalid notification preference "${rawNotificationPreference}" in configuration. Using default "${notificationPreference}".`
            );
          }

          // Use BundleUpdateNotifications for bundle update notifications
          const bundleNotifications = new BundleUpdateNotifications(
            async (bundleId: string) => {
              return await this.registryManager.getBundleName(bundleId);
            }
          );
          await bundleNotifications.showUpdateNotification({
            updates,
            notificationPreference
          });
        }
      );
    } catch (error) {
      this.logger.error('Manual update check failed', error as Error);
      await vscode.window.showErrorMessage(
        `Failed to check for updates: ${(error as Error).message}`,
        'Show Logs'
      ).then((action) => {
        if (action === 'Show Logs') {
          this.logger.show();
        }
      });
    }
  }

  /**
   * Subscribe to lockfile changes for a workspace and refresh UI when lockfile is modified externally.
   * This ensures the UI stays in sync when the lockfile is created, modified, or deleted outside the extension.
   * @param lockfileManager - The LockfileManager instance for the workspace
   * @returns Disposable subscription that should be added to disposables
   */
  private subscribeLockfileChanges(lockfileManager: LockfileManager): vscode.Disposable {
    return lockfileManager.onLockfileUpdated(() => {
      this.logger.debug('Lockfile changed externally, refreshing repository bundles');
      this.registryManager.handleWorkspaceFoldersChanged();
    });
  }

  /**
   * Initialize repository-level installation services
   * Sets up LockfileManager and RepositoryActivationService per workspace folder
   */
  private async initializeRepositoryServices(): Promise<void> {
    try {
      this.logger.info('Initializing repository-level installation services...');

      // Check if workspace is open
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        this.logger.debug('No workspace open, skipping repository services initialization');
        return;
      }

      // Get repository path from first workspace folder
      const repositoryPath = workspaceFolders[0].uri.fsPath;

      // Initialize LockfileManager for this workspace
      this.lockfileManager = LockfileManager.getInstance(repositoryPath);

      // Subscribe to lockfile changes to refresh UI when lockfile is modified externally
      this.disposables.push(this.subscribeLockfileChanges(this.lockfileManager));

      // Initialize RepositoryActivationService for this workspace
      const registryStorage = this.registryManager.getStorage();
      this.repositoryActivationService = RepositoryActivationService.getInstance(
        repositoryPath,
        this.lockfileManager,
        this.hubManager,
        registryStorage,
        this.registryManager, // Pass RegistryManager for missing bundle installation
        this.setupStateManager // Pass SetupStateManager for timing check
      );

      // Check for lockfile and prompt activation
      await this.repositoryActivationService.checkAndPromptActivation();

      // Register BundleScopeCommands (requires scope services from RegistryManager)
      const bundleInstaller = this.registryManager.getBundleInstaller();
      const repositoryScopeService = bundleInstaller.createRepositoryScopeService();

      if (repositoryScopeService) {
        // Create ScopeConflictResolver with storage
        const scopeConflictResolver = new ScopeConflictResolver(registryStorage);

        this.bundleScopeCommands = new BundleScopeCommands(
          this.registryManager,
          scopeConflictResolver,
          repositoryScopeService
        );
        this.logger.debug('BundleScopeCommands registered successfully');
      } else {
        this.logger.debug('BundleScopeCommands not registered: no workspace open');
      }

      this.logger.info('Repository-level installation services initialized successfully');
    } catch (error) {
      this.logger.warn('Failed to initialize repository-level installation services', error);
      // Don't fail extension activation if repository services fail
    }
  }

  /**
   * Initialize repository services for a specific workspace folder
   * Used when workspace folders are added dynamically
   * @param workspaceFolder - The workspace folder to initialize services for
   */
  private async initializeRepositoryServicesForWorkspace(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
    try {
      const repositoryPath = workspaceFolder.uri.fsPath;
      this.logger.info(`Initializing repository services for workspace: ${repositoryPath}`);

      // Initialize LockfileManager for this workspace
      const lockfileManager = LockfileManager.getInstance(repositoryPath);

      // Subscribe to lockfile changes to refresh UI when lockfile is modified externally
      this.disposables.push(this.subscribeLockfileChanges(lockfileManager));

      // Initialize RepositoryActivationService for this workspace
      const registryStorage = this.registryManager.getStorage();
      const activationService = RepositoryActivationService.getInstance(
        repositoryPath,
        lockfileManager,
        this.hubManager,
        registryStorage,
        this.registryManager, // Pass RegistryManager for missing bundle installation
        this.setupStateManager // Pass SetupStateManager for timing check
      );

      // Check for lockfile and prompt activation
      await activationService.checkAndPromptActivation();

      this.logger.info(`Repository services initialized for workspace: ${repositoryPath}`);
    } catch (error) {
      this.logger.warn(`Failed to initialize repository services for workspace: ${workspaceFolder.uri.fsPath}`, error);
    }
  }

  /**
   * Register workspace folder change listener
   * Re-initializes repository services when workspace folders change
   */
  private registerWorkspaceFolderListener(): void {
    const workspaceListener = vscode.workspace.onDidChangeWorkspaceFolders(async (event) => {
      // Initialize services for newly added folders
      for (const folder of event.added) {
        this.logger.info(`Workspace folder added: ${folder.uri.fsPath}`);
        await this.initializeRepositoryServicesForWorkspace(folder);
      }

      // Clean up services for removed folders
      for (const folder of event.removed) {
        this.logger.info(`Workspace folder removed: ${folder.uri.fsPath}`);
        const repositoryPath = folder.uri.fsPath;

        // Reset instances for the removed workspace
        LockfileManager.resetInstance(repositoryPath);
        RepositoryActivationService.resetInstance(repositoryPath);
      }

      // Notify RegistryManager to refresh repository bundles
      // This triggers UI refresh for the new workspace configuration
      this.registryManager.handleWorkspaceFoldersChanged();
    });

    this.disposables.push(workspaceListener);
    this.context.subscriptions.push(workspaceListener);
  }

  /**
   * Initialize UI components
   */
  private async initializeUI(): Promise<void> {
    try {
      // Initialize status bar
      await this.statusBar.initialize();

      // Add status bar to disposables
      this.disposables.push(this.statusBar);

      this.logger.debug('UI components initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize UI components', error as Error);
    }
  }

  /**
   * Check if current workspace is an awesome-copilot repository
   */
  private async isAwesomeCopilotRepository(): Promise<boolean> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return false;
    }

    const workspaceRoot = workspaceFolders[0].uri;

    // Check for key directories that indicate an awesome-copilot structure
    const requiredDirs = ['collections', 'prompts', 'instructions', 'agents'];
    const existingDirs = [];

    for (const dir of requiredDirs) {
      const dirUri = vscode.Uri.joinPath(workspaceRoot, dir);
      try {
        const stat = await vscode.workspace.fs.stat(dirUri);
        if (stat.type === vscode.FileType.Directory) {
          existingDirs.push(dir);
        }
      } catch {
        // Directory doesn't exist
      }
    }

    // Consider it an awesome-copilot repo if at least collections and one other directory exists
    return existingDirs.includes('collections') && existingDirs.length >= 2;
  }

  /**
   * Check if current workspace is an APM repository
   */
  private async isApmRepository(): Promise<boolean> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return false;
    }

    const workspaceRoot = workspaceFolders[0].uri;
    const apmYmlUri = vscode.Uri.joinPath(workspaceRoot, 'apm.yml');

    try {
      await vscode.workspace.fs.stat(apmYmlUri);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Show command menu with all available extension commands
   */
  private async showCommandMenu(): Promise<void> {
    interface CommandItem extends vscode.QuickPickItem {
      command?: string;
    }

    const isAwesomeCopilotRepo = await this.isAwesomeCopilotRepository();
    const isApmRepo = await this.isApmRepository();

    const commands: CommandItem[] = [
      // Profile Management
      {
        label: '$(person) Profile Management',
        kind: vscode.QuickPickItemKind.Separator
      },
      {
        label: '$(add) Create Profile',
        description: 'Create a new prompt profile',
        command: 'promptRegistry.createProfile'
      },
      {
        label: '$(edit) Edit Profile',
        description: 'Edit an existing profile',
        command: 'promptRegistry.editProfile'
      },
      {
        label: '$(check) Activate Profile',
        description: 'Switch to a different profile',
        command: 'promptRegistry.activateProfile'
      },
      {
        label: '$(list-flat) List Profiles',
        description: 'View all available profiles',
        command: 'promptRegistry.listProfiles'
      },

      // Source Management
      {
        label: '$(source-control) Source Management',
        kind: vscode.QuickPickItemKind.Separator
      },
      {
        label: '$(add) Add Source',
        description: 'Add a new prompt source',
        command: 'promptRegistry.addSource'
      },
      {
        label: '$(sync) Sync All Sources',
        description: 'Synchronize all prompt sources',
        command: 'promptRegistry.syncAllSources'
      },
      {
        label: '$(list-flat) List Sources',
        description: 'View all configured sources',
        command: 'promptRegistry.listSources'
      },

      // Bundle Management
      {
        label: '$(package) Bundle Management',
        kind: vscode.QuickPickItemKind.Separator
      },
      {
        label: '$(search) Search Bundles',
        description: 'Search and install prompt bundles',
        command: 'promptRegistry.searchBundles'
      },
      {
        label: '$(star) Show Popular Bundles',
        description: 'Browse popular prompt bundles',
        command: 'promptRegistry.showPopular'
      },
      {
        label: '$(list-selection) List Installed Bundles',
        description: 'View all installed bundles',
        command: 'promptRegistry.listInstalled'
      },
      {
        label: '$(refresh) Check for Updates',
        description: 'Check for bundle updates',
        command: 'promptRegistry.checkBundleUpdates'
      }
    ];

    // Add Collection Management section only for awesome-copilot repositories
    if (isAwesomeCopilotRepo) {
      commands.push(
        {
          label: '$(folder) Collection Management',
          kind: vscode.QuickPickItemKind.Separator
        },
        {
          label: '$(new-file) Create New Collection',
          description: 'Interactive collection creator',
          command: 'promptRegistry.createCollection'
        },
        {
          label: '$(check-all) Validate Collections',
          description: 'Validate collection YAML files',
          command: 'promptRegistry.validateCollections'
        },
        {
          label: '$(list-flat) List All Collections',
          description: 'Show collection metadata',
          command: 'promptRegistry.listCollections'
        }
      );
    }

    // Add APM Package Management section only for APM repositories
    if (isApmRepo) {
      commands.push(
        {
          label: '$(package) Package Management',
          kind: vscode.QuickPickItemKind.Separator
        },
        {
          label: '$(check-all) Validate APM Package',
          description: 'Validate APM manifest and prompt files',
          command: 'promptRegistry.validateApm'
        }
      );
    }

    // Project Scaffolding
    commands.push(
      {
        label: '$(file-directory) Project Scaffolding',
        kind: vscode.QuickPickItemKind.Separator
      },
      {
        label: '$(folder-library) Scaffold Project',
        description: 'Create new prompt project (GitHub or APM)',
        command: 'promptRegistry.scaffoldProject'
      },
      {
        label: '$(settings-gear) Settings & Information',
        kind: vscode.QuickPickItemKind.Separator
      },
      {
        label: '$(gear) Open Settings',
        description: 'Configure AI Primitives Hub',
        command: 'promptRegistry.openSettings'
      }
    );

    const selected = await vscode.window.showQuickPick(commands, {
      placeHolder: 'Select an AI Primitives Hub command',
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true
    });

    if (selected && selected.command) {
      await vscode.commands.executeCommand(selected.command);
    }
  }

  /**
   * Ensure only one profile is active during startup
   * Fixes cases where multiple profiles may be marked as active from previous sessions
   */
  private async ensureSingleActiveProfile(): Promise<void> {
    try {
      const allProfiles = await this.registryManager.listProfiles();
      const activeProfiles = allProfiles.filter((p) => p.active);

      if (activeProfiles.length <= 1) {
        // Already have 0 or 1 active profile - good state
        return;
      }

      this.logger.info(`Found ${activeProfiles.length} active profiles, ensuring only one is active`);

      // Deactivate all but the first active profile
      for (let i = 1; i < activeProfiles.length; i++) {
        const profile = activeProfiles[i];
        this.logger.info(`Deactivating extra active profile: ${profile.name}`);
        try {
          await this.registryManager.deactivateProfile(profile.id);
        } catch (error) {
          this.logger.error(`Failed to deactivate profile ${profile.id}`, error as Error);
        }
      }

      this.logger.info(`Profile cleanup complete, only ${activeProfiles[0].name} remains active`);
    } catch (error) {
      this.logger.error('Failed to ensure single active profile', error as Error);
    }
  }

  /**
   * Check for automatic updates on extension activation
   */
  private async checkForAutomaticUpdates(): Promise<void> {
    try {
      const config = vscode.workspace.getConfiguration('promptregistry');
      const autoCheckUpdates = config.get<boolean>('autoCheckUpdates', true);

      if (!autoCheckUpdates) {
        this.logger.debug('Automatic update checking is disabled');
        return;
      }

      this.logger.debug('Checking for automatic updates...');

      // Automatic update checking removed - users can access all commands via status bar menu
      this.logger.debug('Automatic update checking disabled - use command menu instead');
    } catch (error) {
      this.logger.warn('Failed to perform automatic update check', error);
    }
  }

  /**
   * Check if first-run dialogs should be skipped
   * Detects test/CI environments via VSCODE_TEST env var or extensionMode
   * @returns true if running in test environment, false otherwise
   */
  private shouldSkipFirstRun(): boolean {
    return process.env.VSCODE_TEST === '1'
      || this.context.extensionMode === vscode.ExtensionMode.Test;
  }

  /**
   * Handle incomplete setup from previous session.
   * Shows the resume notification non-blockingly so the marketplace UI
   * can render the "Setup Not Complete" empty state while the user decides.
   * @returns true if setup is incomplete (caller should skip fresh-install flow), false otherwise
   */
  private async handleIncompleteSetup(): Promise<boolean> {
    // Check for incomplete setup from previous session
    const isIncomplete = await this.setupStateManager!.detectIncompleteSetup();

    if (isIncomplete && await this.setupStateManager!.shouldShowResumePrompt()) {
      // Fire the resume prompt without awaiting — let activation finish
      // so the marketplace webview can render and show the "Complete Setup" button.
      this.showResumeSetupPrompt();
      return true;
    }

    // Prompt was already shown or setup is not incomplete - don't block fresh install
    return false;
  }

  /**
   * Handle fresh install flow
   * Initializes default sources, hub, and shows welcome notification
   */
  private async handleFreshInstall(): Promise<void> {
    // Check if this is first run
    const state = await this.setupStateManager!.getState();

    if (state === SetupState.NOT_STARTED) {
      await this.setupStateManager!.markStarted();

      // Initialize hub (first-run hub selector or migration)
      await this.initializeHub();

      // If we get here, setup completed successfully
      await this.setupStateManager!.markComplete();

      // Trigger source/hub detection now that setup is complete
      if (this.repositoryActivationService) {
        await this.repositoryActivationService.checkAndPromptActivation();
      }

      this.logger.info('First run completed successfully');
    }
  }

  /**
   * Check if this is the first run and show welcome message
   */
  private async checkFirstRun(): Promise<void> {
    if (!this.setupStateManager) {
      this.logger.warn('SetupStateManager not initialized, skipping first-run check');
      return;
    }

    try {
      // Skip first-run dialogs in test/CI environments
      if (this.shouldSkipFirstRun()) {
        this.logger.info('Test environment detected, skipping first-run dialogs');
        // Mark setup as complete to prevent future dialogs
        await this.setupStateManager.markComplete();
        return;
      }

      // Check for incomplete setup from previous session
      if (await this.handleIncompleteSetup()) {
        return;
      }

      // Handle fresh install
      await this.handleFreshInstall();
    } catch (error) {
      this.logger.error('Failed during first run', error as Error);
      await this.setupStateManager.markIncomplete();
    }
  }

  /**
   * Show resume setup notification to the user.
   *
   * Fires non-blockingly so the marketplace UI can render the "Setup Not
   * Complete" empty state while the notification is visible.  The handler
   * guards against double-execution: if setup was already completed via the
   * marketplace button, clicking "Complete Setup" on the notification is a
   * safe no-op.
   */
  private showResumeSetupPrompt(): void {
    if (!this.setupStateManager) {
      this.logger.warn('SetupStateManager not initialized, skipping resume prompt');
      return;
    }

    // Mark prompt as shown to prevent showing it multiple times in the same session
    void this.setupStateManager.markResumePromptShown();

    // Fire-and-forget: the .then() handler runs when the user clicks a button
    vscode.window.showInformationMessage(
      'Setup was not completed. Would you like to resume?',
      'Complete Setup',
      'Skip for Now'
    ).then(async (action) => {
      if (action === 'Complete Setup') {
        // Guard: setup may have been completed via the marketplace button
        const currentState = await this.setupStateManager!.getState();
        if (currentState === SetupState.COMPLETE) {
          this.logger.info('Setup already completed via another path, ignoring notification click');
          return;
        }

        this.logger.info('User chose to resume setup via notification');
        await this.setupStateManager!.markStarted();

        try {
          if (this.hubManager) {
            this.hubManager.clearAuthCache();
          }
          await this.initializeHub();
          await this.setupStateManager!.markComplete();

          if (this.repositoryActivationService) {
            await this.repositoryActivationService.checkAndPromptActivation();
          }

          this.logger.info('Setup resumed and completed successfully via notification');
        } catch (error) {
          this.logger.error('Failed to complete setup during resume', error as Error);
          await this.setupStateManager!.markIncomplete();
        }
      } else {
        this.logger.info('User skipped setup resumption');
      }
    });
  }

  /**
   * Sync active hub configuration on every activation.
   * Source sync and UI refresh are handled by the onHubSynced event listener.
   */
  private async syncActiveHub(): Promise<void> {
    try {
      if (!this.hubManager) {
        this.logger.warn('HubManager not initialized, skipping hub sync');
        return;
      }
      await this.hubManager.syncActiveHub();
    } catch (error) {
      this.logger.warn('Failed to auto-sync active hub on activation', error);
      // Don't fail extension activation if sync fails
    }
  }

  /**
   * Initialize hub configuration on first run or migrate existing installations.
   *
   * State Management: On error or cancellation, this method calls markIncomplete()
   * and re-throws. The caller is responsible for calling markComplete() on success.
   */
  private async initializeHub(): Promise<void> {
    if (!this.hubManager) {
      throw new Error('HubManager not initialized');
    }

    try {
      const hubManager = this.hubManager;

      // Check existing hubs
      const hubs = await hubManager.listHubs();
      const activeHubResult = await hubManager.getActiveHub();

      if (hubs.length === 0 && !activeHubResult) {
        // Scenario 1: First-time installation, no hubs
        this.logger.info('First-time hub setup: prompting for GitHub account');
        await promptGitHubAccountSelection();
        this.logger.info('First-time hub setup: showing hub selector');
        await this.showFirstRunHubSelector();

        // Verify hub was actually configured
        const hubsAfter = await hubManager.listHubs();
        const activeHubAfter = await hubManager.getActiveHub();

        if (hubsAfter.length === 0 && !activeHubAfter) {
          // User cancelled - throw to prevent markComplete()
          // The catch block below will call markIncomplete()
          this.logger.info('Hub selection cancelled');
          throw new Error('Hub selection cancelled by user');
        } else {
          // Show welcome notification with marketplace button
          setTimeout(async () => {
            await this.notifications.showWelcomeNotification();
          }, 2000);
        }
      } else if (hubs.length > 0 && !activeHubResult) {
        // Scenario 2: Migration - hubs exist but no active hub set
        this.logger.info(`Migration detected: ${hubs.length} hubs found, migrating to active hub model`);
        await this.migrateToActiveHub(hubs);
      } else {
        // Scenario 3: Already initialized (active hub exists)
        this.logger.info('Hub already configured with active hub');
      }

      // Mark as initialized (for backward compatibility)
      await this.context.globalState.update('promptregistry.hubInitialized', true);
      this.logger.info('Hub initialization complete');
    } catch (error) {
      this.logger.error('Failed to initialize hub', error as Error);
      if (this.setupStateManager) {
        await this.setupStateManager.markIncomplete();
      }
      throw error;
    }
  }

  /**
   * Show first-run hub selector with preset options
   */
  private async showFirstRunHubSelector(): Promise<void> {
    const hubManager = this.hubManager!;

    // Get enabled default hubs and verify their availability
    const defaultHubs = getEnabledDefaultHubs();
    // Verify each hub in parallel but preserve order
    this.logger.info('Verifying default hubs...');
    const verificationResults = await Promise.all(defaultHubs.map(async (hub) => {
      const isAvailable = await hubManager.verifyHubAvailability(hub.reference);
      this.logger.debug(`Hub verification result for ${hub.name}: ${isAvailable ? 'available' : 'unavailable'}`);
      if (isAvailable) {
        this.logger.info(`✓ Hub verified: ${hub.name} (${hub.reference.type}:${hub.reference.location})`);
      } else {
        this.logger.warn(`✗ Hub unavailable: ${hub.name} (${hub.reference.type}:${hub.reference.location})`);
      }
      return { ...hub, verified: isAvailable };
    }));

    // verificationResults maintains the same order as defaultHubs
    const verifiedHubs = verificationResults;

    // Build quick-pick items from verified hubs
    const items = verifiedHubs
      .filter((hub) => hub.verified) // Only show verified hubs
      .map((hub) => ({
        label: `$(${hub.icon}) ${hub.name}${hub.recommended ? ' ⭐' : ''}`,
        description: hub.recommended ? hub.description + ' (recommended)' : hub.description,
        detail: `${hub.reference.type}/${hub.reference.location}`,
        hubConfig: hub
      }));

    // Add custom URL and skip options
    items.push(
      {
        label: '$(link-external) Custom Hub URL',
        description: 'Import from custom URL',
        detail: 'Enter a custom hub URL',
        hubConfig: null as any
      },
      {
        label: '$(x) Skip for now',
        description: 'Configure hub later',
        detail: 'You can configure a hub anytime from the toolbar',
        hubConfig: null as any
      }
    );

    // Show warning if no verified hubs
    if (verifiedHubs.filter((h) => h.verified).length === 0) {
      this.logger.warn('No default hubs are currently accessible');
      vscode.window.showWarningMessage(
        'Default hubs are currently unavailable. You can import a custom hub or skip for now.',
        'Continue'
      );
    }

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a hub to get started',
      title: 'Welcome to AI Primitives Hub - Choose Your Hub',
      ignoreFocusOut: true
    });

    if (!selected) {
      this.logger.info('User cancelled first-run hub selector');
      return;
    }

    if (selected.hubConfig && selected.hubConfig.reference) {
      // Import and activate the selected hub
      this.logger.info(`Importing first-run hub: ${selected.hubConfig.name}`);
      try {
        const hubId = await hubManager.importHub(selected.hubConfig.reference);
        await hubManager.setActiveHub(hubId);
        this.logger.info(`First-run hub ${hubId} imported and activated, syncing sources...`);

        // Sync all sources from the newly imported hub in the background (non-blocking)
        // This allows the UI to be responsive while sync happens progressively
        this.sourceCommands!.syncAllSources({ silent: true }).then(() => {
          this.logger.info('Sources synchronized successfully');
          vscode.commands.executeCommand('promptRegistry.refresh');
        }).catch((syncError) => {
          this.logger.warn('Failed to sync sources after hub import', syncError as Error);
        });

        // Note: We intentionally do NOT auto-activate any profile here.
        // Users should explicitly choose which profile to activate.
        this.logger.info('Hub imported successfully. User can manually activate a profile if desired.');

        vscode.window.showInformationMessage(`Successfully activated ${selected.hubConfig.name}`);
      } catch (error) {
        this.logger.error(`Failed to import hub: ${selected.hubConfig.name}`, error as Error);
        vscode.window.showErrorMessage(
          `Failed to import ${selected.hubConfig.name}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    } else if (selected.label.includes('Custom Hub URL')) {
      // Redirect to import hub command
      this.logger.info('User chose custom hub URL, redirecting to import command');
      await vscode.commands.executeCommand('promptregistry.importHub');
    } else {
      // Skip for now
      this.logger.info('User chose to skip hub configuration');
    }
  }

  /**
   * Migrate existing multi-hub installation to active hub model
   * @param hubs
   */
  private async migrateToActiveHub(hubs: any[]): Promise<void> {
    const hubManager = this.hubManager!;

    if (hubs.length === 1) {
      // Auto-activate the only hub
      const id = hubs[0].id;
      this.logger.info(`Auto-activating single hub: ${id}`);
      await hubManager.setActiveHub(id);
      await vscode.commands.executeCommand('promptRegistry.refresh');
      return;
    }

    // Multiple hubs - show selection dialog
    const items = hubs.map((hub) => ({
      label: hub.metadata?.name || hub.id,
      description: hub.metadata?.description || '',
      detail: `${hub.metadata?.url || 'Unknown URL'} (${hub.metadata?.ref || 'Unknown ref'})`,
      hubId: hub.id
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Multiple hubs found. Select which hub to activate:',
      title: 'Hub Migration - Select Active Hub',
      ignoreFocusOut: true
    });

    const hubId = selected ? selected.hubId : hubs[0].id;
    this.logger.info(`Migrating to active hub: ${hubId}`);
    await hubManager.setActiveHub(hubId);
    await vscode.commands.executeCommand('promptRegistry.refresh');
  }

  public async activate(): Promise<void> {
    try {
      this.logger.info('Activating AI Primitives Hub extension...');

      // Initialize McpConfigLocator for profile support
      McpConfigLocator.initialize(this.context);

      // Initialize Runtime Managers with context
      ApmRuntimeManager.getInstance().initialize(this.context);

      // Initialize Registry Manager
      await this.registryManager.initialize();

      // Run data migrations (idempotent, skips if already completed)
      await this.runMigrations();

      // Register commands
      this.registerCommands();

      // Initialize UI components
      await this.initializeUI();

      // Register TreeView
      await this.registerTreeView();

      // Register Marketplace View
      await this.registerMarketplaceView();

      // Initialize Copilot Integration
      await this.initializeCopilot();

      // Initialize update notification system
      await this.initializeUpdateSystem();

      // Initialize telemetry service
      this.initializeTelemetry();

      // Initialize repository-level installation services
      await this.initializeRepositoryServices();

      // Register workspace folder change listener
      this.registerWorkspaceFolderListener();

      // Check for automatic updates if enabled
      await this.checkForAutomaticUpdates();

      // Check if this is first run and show welcome message
      await this.checkFirstRun();

      // Always sync active hub on activation to keep it up-to-date
      await this.syncActiveHub();

      // Ensure only one profile is active (cleanup any multi-active state)
      await this.ensureSingleActiveProfile();

      this.logger.info('AI Primitives Hub extension activated successfully');
    } catch (error) {
      this.logger.error('Failed to activate AI Primitives Hub extension', error as Error);
      await this.notifications.showError(
        `Failed to activate AI Primitives Hub extension: ${(error as Error).message}`,
        'Show Logs'
      ).then((action) => {
        if (action === 'Show Logs') {
          this.logger.show();
        }
      });
    }
  }

  /**
   * Deactivate the extension
   */
  public deactivate(): void {
    try {
      this.logger.info('Deactivating AI Primitives Hub extension...');

      // Dispose of all resources
      this.disposables.forEach((disposable) => disposable.dispose());
      this.disposables = [];

      // Dispose telemetry event subscriptions
      this.telemetryService?.dispose();

      // Dispose hub sync scheduler
      this.hubSyncScheduler?.dispose();

      // Dispose update scheduler
      this.updateScheduler?.dispose();

      // Dispose Copilot integration
      this.copilotIntegration?.dispose();

      // Dispose collection commands
      this.validateCollectionsCommand?.dispose();
      this.validateApmCommand?.dispose();
      this.createCollectionCommand?.dispose();

      // Dispose UI components
      this.statusBar.dispose();
      this.logger.dispose();

      this.logger.info('AI Primitives Hub extension deactivated successfully');
    } catch (error) {
      console.error('Error during AI Primitives Hub extension deactivation:', error);
    }
  }
}

// Extension activation function called by VS Code
/**
 * Activate the AI Primitives Hub extension.
 * @param context
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionInstance = new PromptRegistryExtension(context);
  await extensionInstance.activate();
}

// Extension deactivation function called by VS Code
/**
 * Deactivate the AI Primitives Hub extension.
 */
export function deactivate(): void {
  if (extensionInstance) {
    extensionInstance.deactivate();
    extensionInstance = undefined;
  }
}
