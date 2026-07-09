/**
 * Tests for MarketplaceViewProvider Empty State UI
 *
 * Tests the setup prompt and syncing message behavior based on setup state.
 * Requirements: 4.1, 4.2, 4.3, 4.5
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  RegistryManager,
} from '../../src/services/registry-manager';
import {
  SetupState,
  SetupStateManager,
} from '../../src/services/setup-state-manager';
import {
  MarketplaceViewProvider,
} from '../../src/ui/marketplace-view-provider';

// Project root for resolving webview assets in dist/
const PROJECT_ROOT = process.cwd();

suite('MarketplaceViewProvider - Empty State UI', () => {
  let sandbox: sinon.SinonSandbox;
  let mockContext: vscode.ExtensionContext;
  let mockRegistryManager: sinon.SinonStubbedInstance<RegistryManager>;
  let mockSetupStateManager: sinon.SinonStubbedInstance<SetupStateManager>;
  let marketplaceProvider: MarketplaceViewProvider;
  let mockWebview: any;
  let postedMessages: any[] = [];

  setup(() => {
    sandbox = sinon.createSandbox();
    postedMessages = [];

    // Create mock context
    mockContext = {
      subscriptions: [],
      extensionUri: vscode.Uri.file(PROJECT_ROOT),
      extensionPath: PROJECT_ROOT,
      storagePath: '/mock/storage',
      globalStoragePath: '/mock/global-storage',
      logPath: '/mock/logs',
      extensionMode: 2 // ExtensionMode.Test
    } as any;

    // Create mock webview that captures posted messages
    mockWebview = {
      postMessage: (message: any) => {
        postedMessages.push(message);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: sandbox.stub().returns({ dispose: () => {} }),
      asWebviewUri: (uri: vscode.Uri) => uri,
      cspSource: "'self'",
      options: {},
      html: ''
    };

    // Create mock RegistryManager with event emitters
    mockRegistryManager = {
      onBundleInstalled: sandbox.stub().returns({ dispose: () => {} }),
      onBundleUninstalled: sandbox.stub().returns({ dispose: () => {} }),
      onBundleUpdated: sandbox.stub().returns({ dispose: () => {} }),
      onBundlesInstalled: sandbox.stub().returns({ dispose: () => {} }),
      onBundlesUninstalled: sandbox.stub().returns({ dispose: () => {} }),
      onSourceSynced: sandbox.stub().returns({ dispose: () => {} }),
      onAutoUpdatePreferenceChanged: sandbox.stub().returns({ dispose: () => {} }),
      onRepositoryBundlesChanged: sandbox.stub().returns({ dispose: () => {} }),
      onReadmeDownloaded: sandbox.stub().returns({ dispose: () => {} }),
      onReadmeDownloadComplete: sandbox.stub().returns({ dispose: () => {} }),
      searchBundles: sandbox.stub().resolves([]),
      listInstalledBundles: sandbox.stub().resolves([]),
      listSources: sandbox.stub().resolves([]),
      autoUpdateService: null
    } as any;

    // Create mock SetupStateManager
    mockSetupStateManager = {
      getState: sandbox.stub(),
      isComplete: sandbox.stub(),
      isIncomplete: sandbox.stub(),
      markStarted: sandbox.stub().resolves(),
      markComplete: sandbox.stub().resolves(),
      markIncomplete: sandbox.stub().resolves()
    } as any;

    // Create MarketplaceViewProvider
    marketplaceProvider = new MarketplaceViewProvider(
      mockContext,
      mockRegistryManager,
      mockSetupStateManager
    );

    // Set up the view with mock webview
    (marketplaceProvider as any)._view = {
      webview: mockWebview
    };
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('Setup state in bundlesLoaded message', () => {
    test('should include setup state in bundlesLoaded message when setup is incomplete', async () => {
      // Requirement 4.1: WHEN the marketplace displays AND no bundles exist AND no hub is configured
      mockSetupStateManager.getState.resolves(SetupState.INCOMPLETE);
      mockRegistryManager.searchBundles.resolves([]);
      mockRegistryManager.listInstalledBundles.resolves([]);
      mockRegistryManager.listSources.resolves([]);

      // Trigger loadBundles
      await (marketplaceProvider as any).loadBundles();

      // Verify message was posted with setup state
      assert.strictEqual(postedMessages.length, 1);
      assert.strictEqual(postedMessages[0].type, 'bundlesLoaded');
      assert.strictEqual(postedMessages[0].setupState, SetupState.INCOMPLETE);
    });

    test('should include setup state in bundlesLoaded message when setup is not started', async () => {
      // Requirement 4.1: Setup prompt should show when setup is not_started
      mockSetupStateManager.getState.resolves(SetupState.NOT_STARTED);
      mockRegistryManager.searchBundles.resolves([]);
      mockRegistryManager.listInstalledBundles.resolves([]);
      mockRegistryManager.listSources.resolves([]);

      // Trigger loadBundles
      await (marketplaceProvider as any).loadBundles();

      // Verify message was posted with setup state
      assert.strictEqual(postedMessages.length, 1);
      assert.strictEqual(postedMessages[0].type, 'bundlesLoaded');
      assert.strictEqual(postedMessages[0].setupState, SetupState.NOT_STARTED);
    });

    test('should include setup state in bundlesLoaded message when setup is complete', async () => {
      // Requirement 4.5: WHEN setup complete and no bundles, show "Syncing sources..."
      mockSetupStateManager.getState.resolves(SetupState.COMPLETE);
      mockRegistryManager.searchBundles.resolves([]);
      mockRegistryManager.listInstalledBundles.resolves([]);
      mockRegistryManager.listSources.resolves([]);

      // Trigger loadBundles
      await (marketplaceProvider as any).loadBundles();

      // Verify message was posted with setup state
      assert.strictEqual(postedMessages.length, 1);
      assert.strictEqual(postedMessages[0].type, 'bundlesLoaded');
      assert.strictEqual(postedMessages[0].setupState, SetupState.COMPLETE);
    });

    test('should include sourcesCount in bundlesLoaded message', async () => {
      // WHEN setup is complete but no sources are configured, sourcesCount must be 0
      // so the webview can show "Setup Not Complete" instead of the infinite spinner
      mockSetupStateManager.getState.resolves(SetupState.COMPLETE);
      mockRegistryManager.searchBundles.resolves([]);
      mockRegistryManager.listInstalledBundles.resolves([]);
      mockRegistryManager.listSources.resolves([]);

      await (marketplaceProvider as any).loadBundles();

      assert.strictEqual(postedMessages.length, 1);
      assert.strictEqual(postedMessages[0].type, 'bundlesLoaded');
      assert.strictEqual(postedMessages[0].sourcesCount, 0,
        'sourcesCount should be 0 when no sources configured');
    });

    test('should include correct sourcesCount when sources are configured', async () => {
      mockSetupStateManager.getState.resolves(SetupState.COMPLETE);
      mockRegistryManager.searchBundles.resolves([]);
      mockRegistryManager.listInstalledBundles.resolves([]);
      mockRegistryManager.listSources.resolves([
        { id: 'source-1' } as any,
        { id: 'source-2' } as any
      ]);

      await (marketplaceProvider as any).loadBundles();

      assert.strictEqual(postedMessages.length, 1);
      assert.strictEqual(postedMessages[0].sourcesCount, 2,
        'sourcesCount should reflect actual number of sources');
    });

    test('should include setup state in bundlesLoaded message when setup is in progress', async () => {
      mockSetupStateManager.getState.resolves(SetupState.IN_PROGRESS);
      mockRegistryManager.searchBundles.resolves([]);
      mockRegistryManager.listInstalledBundles.resolves([]);
      mockRegistryManager.listSources.resolves([]);

      // Trigger loadBundles
      await (marketplaceProvider as any).loadBundles();

      // Verify message was posted with setup state
      assert.strictEqual(postedMessages.length, 1);
      assert.strictEqual(postedMessages[0].type, 'bundlesLoaded');
      assert.strictEqual(postedMessages[0].setupState, SetupState.IN_PROGRESS);
    });
  });

  suite('completeSetup message handler', () => {
    test('should call markStarted before executing initializeHub command', async () => {
      // Requirement 4.4: State should be marked as started before triggering flow
      const executeCommandStub = sandbox.stub(vscode.commands, 'executeCommand').resolves();
      mockSetupStateManager.getState.resolves(SetupState.COMPLETE);
      mockRegistryManager.searchBundles.resolves([]);
      mockRegistryManager.listInstalledBundles.resolves([]);
      mockRegistryManager.listSources.resolves([]);

      // Call handleCompleteSetup
      await (marketplaceProvider as any).handleCompleteSetup();

      // Verify markStarted was called
      assert.ok(mockSetupStateManager.markStarted.calledOnce, 'markStarted should be called');

      // Verify markStarted was called before executeCommand
      assert.ok(mockSetupStateManager.markStarted.calledBefore(executeCommandStub),
        'markStarted should be called before executeCommand');
    });

    test('should handle completeSetup message and execute initializeHub command', async () => {
      // Requirement 4.4: WHEN user clicks "Complete Setup", trigger first-run configuration flow
      const executeCommandStub = sandbox.stub(vscode.commands, 'executeCommand').resolves();
      mockSetupStateManager.getState.resolves(SetupState.COMPLETE);
      mockRegistryManager.searchBundles.resolves([]);
      mockRegistryManager.listInstalledBundles.resolves([]);
      mockRegistryManager.listSources.resolves([]);

      // Call handleCompleteSetup
      await (marketplaceProvider as any).handleCompleteSetup();

      // Verify command was executed
      assert.ok(executeCommandStub.calledOnce, 'executeCommand should be called once');
      assert.ok(executeCommandStub.calledWith('promptRegistry.initializeHub'),
        'should call promptRegistry.initializeHub command');
    });

    test('should NOT call markComplete directly (delegated to initializeHub)', async () => {
      // State management is delegated to initializeHub command
      sandbox.stub(vscode.commands, 'executeCommand').resolves();
      mockSetupStateManager.getState.resolves(SetupState.COMPLETE);
      mockRegistryManager.searchBundles.resolves([]);
      mockRegistryManager.listInstalledBundles.resolves([]);
      mockRegistryManager.listSources.resolves([]);

      // Call handleCompleteSetup
      await (marketplaceProvider as any).handleCompleteSetup();

      // Verify markComplete was NOT called (initializeHub handles this)
      assert.ok(!mockSetupStateManager.markComplete.called,
        'markComplete should NOT be called directly - delegated to initializeHub');
    });

    test('should refresh marketplace after completing setup', async () => {
      // Requirement 4.4: After setup, marketplace should refresh
      sandbox.stub(vscode.commands, 'executeCommand').resolves();
      mockSetupStateManager.getState.resolves(SetupState.COMPLETE);
      mockRegistryManager.searchBundles.resolves([]);
      mockRegistryManager.listInstalledBundles.resolves([]);
      mockRegistryManager.listSources.resolves([]);

      // Clear any previous messages
      postedMessages = [];

      // Call handleCompleteSetup
      await (marketplaceProvider as any).handleCompleteSetup();

      // Verify loadBundles was called (which posts bundlesLoaded message)
      assert.strictEqual(postedMessages.length, 1);
      assert.strictEqual(postedMessages[0].type, 'bundlesLoaded');
    });

    test('should NOT call markIncomplete directly when setup fails (delegated to initializeHub)', async () => {
      // State management is delegated to initializeHub command
      sandbox.stub(vscode.commands, 'executeCommand')
        .rejects(new Error('Setup failed'));
      sandbox.stub(vscode.window, 'showErrorMessage').resolves();
      mockSetupStateManager.getState.resolves(SetupState.COMPLETE);
      mockRegistryManager.searchBundles.resolves([]);
      mockRegistryManager.listInstalledBundles.resolves([]);
      mockRegistryManager.listSources.resolves([]);

      // Call handleCompleteSetup - should not throw
      await (marketplaceProvider as any).handleCompleteSetup();

      // Verify markIncomplete was NOT called directly (initializeHub handles this)
      assert.ok(!mockSetupStateManager.markIncomplete.called,
        'markIncomplete should NOT be called directly - delegated to initializeHub');
    });

    test('should handle errors gracefully when completing setup fails', async () => {
      // Requirement 4.4: Error handling
      sandbox.stub(vscode.commands, 'executeCommand')
        .rejects(new Error('Setup failed'));
      const showErrorStub = sandbox.stub(vscode.window, 'showErrorMessage').resolves();

      // Call handleCompleteSetup - should not throw
      await (marketplaceProvider as any).handleCompleteSetup();

      // Verify error message was shown
      assert.ok(showErrorStub.calledOnce);
      assert.ok(showErrorStub.firstCall.args[0].includes('Failed to complete setup'));
    });

    test('should not call markComplete when setup fails', async () => {
      // Requirement 4.4: markComplete should not be called on error
      sandbox.stub(vscode.commands, 'executeCommand')
        .rejects(new Error('Setup failed'));
      sandbox.stub(vscode.window, 'showErrorMessage').resolves();

      // Call handleCompleteSetup
      await (marketplaceProvider as any).handleCompleteSetup();

      // Verify markComplete was NOT called
      assert.ok(mockSetupStateManager.markComplete.notCalled,
        'markComplete should not be called when setup fails');
    });
  });

  suite('HTML content generation', () => {
    test('should reference external CSS file in HTML', () => {
      // Requirement 4.3: HTML should load external CSS with marketplace styles
      const html = (marketplaceProvider as any).getHtmlContent(mockWebview);

      // Verify external CSS is referenced
      assert.ok(html.includes('marketplace.css'), 'HTML should reference marketplace.css');
      assert.ok(html.includes('<link rel="stylesheet"'), 'HTML should include stylesheet link');
    });

    test('should reference external JS file in HTML', () => {
      // Requirement 4.2: HTML should load external JS
      const html = (marketplaceProvider as any).getHtmlContent(mockWebview);

      // Verify external JS is referenced
      assert.ok(html.includes('marketplace.js'), 'HTML should reference marketplace.js');
      assert.ok(html.includes('<script'), 'HTML should include script tag');
    });

    test('should include Content Security Policy in HTML', () => {
      // CSP should be set for security
      const html = (marketplaceProvider as any).getHtmlContent(mockWebview);

      // Verify CSP is included
      assert.ok(html.includes('Content-Security-Policy'), 'HTML should include CSP meta tag');
      assert.ok(html.includes('nonce-'), 'CSP should include nonce');
    });

    test('external marketplace JS should include setupState variable', () => {
      // Requirement 4.1: UI should check setup state
      const jsPath = path.join(PROJECT_ROOT, 'src', 'ui', 'webview', 'marketplace', 'marketplace.js');
      if (!fs.existsSync(jsPath)) {
        return;
      }
      const jsContent = fs.readFileSync(jsPath, 'utf8');

      // Verify setupState variable is defined
      assert.ok(jsContent.includes('setupState'),
        'marketplace.js should include setupState variable');
    });

    test('external marketplace JS should include setup incomplete check', () => {
      // Requirement 4.1: Show setup prompt when setup incomplete
      const jsPath = path.join(PROJECT_ROOT, 'src', 'ui', 'webview', 'marketplace', 'marketplace.js');
      if (!fs.existsSync(jsPath)) {
        return;
      }
      const jsContent = fs.readFileSync(jsPath, 'utf8');

      assert.ok(jsContent.includes('Setup Not Complete'),
        'marketplace.js should include "Setup Not Complete" message');
      assert.ok(jsContent.includes('No hub is configured'),
        'marketplace.js should include explanation about no hub configured');
      assert.ok(jsContent.includes('No sources are configured'),
        'marketplace.js should include explanation for complete+no-sources case');
    });

    test('external marketplace JS should include syncing message', () => {
      // Requirement 4.5: Show "Syncing sources..." when setup complete but no bundles
      const jsPath = path.join(PROJECT_ROOT, 'src', 'ui', 'webview', 'marketplace', 'marketplace.js');
      if (!fs.existsSync(jsPath)) {
        return;
      }
      const jsContent = fs.readFileSync(jsPath, 'utf8');

      assert.ok(jsContent.includes('Syncing sources...'),
        'marketplace.js should include "Syncing sources..." message');
      assert.ok(jsContent.includes('Bundles will appear as sources are synced'),
        'marketplace.js should include explanation about syncing');
    });
  });
});
