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
import type {
  Bundle,
} from '../../src/types/registry';
import {
  MarketplaceViewProvider,
} from '../../src/ui/marketplace-view-provider';
import {
  BundleBuilder,
  createMockInstalledBundle,
} from '../helpers/bundle-test-helpers';
import {
  setupRegistryManagerEventMocks,
} from '../helpers/ui-test-helpers';

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

    // Create mock RegistryManager. Event emitters are provided by the shared
    // helper so new registry events are picked up centrally (see QA2).
    mockRegistryManager = {
      searchBundles: sandbox.stub().resolves([]),
      listInstalledBundles: sandbox.stub().resolves([]),
      listSources: sandbox.stub().resolves([]),
      autoUpdateService: null
    } as any;
    setupRegistryManagerEventMocks(mockRegistryManager, sandbox);

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
    // The webview only receives bundlesLoaded messages after signaling readiness.
    (marketplaceProvider as any).webviewReady = true;
  });

  teardown(() => {
    marketplaceProvider.dispose();
    sandbox.restore();
  });

  suite('Setup state in bundlesLoaded message', () => {
    [false, true].forEach((hasConfiguredHub) => {
      test(`reports actual hub presence (${hasConfiguredHub}) despite a stored complete state`, async () => {
        mockSetupStateManager.getState.resolves(SetupState.COMPLETE);
        mockRegistryManager.listSources.resolves([{ id: 'standalone-skills', type: 'skills' } as any]);
        marketplaceProvider.dispose();
        marketplaceProvider = new MarketplaceViewProvider(
          mockContext,
          mockRegistryManager,
          mockSetupStateManager,
          undefined,
          {
            getActiveHub: sandbox.stub().resolves(hasConfiguredHub ? { config: {} } : null),
            onActiveHubChanged: sandbox.stub().returns({ dispose: () => {} })
          }
        );
        marketplaceProvider.resolveWebviewView({
          webview: mockWebview,
          onDidChangeVisibility: sandbox.stub().returns({ dispose: () => {} })
        } as any, {} as any, {} as any);
        const receiveMessage = mockWebview.onDidReceiveMessage.lastCall.args[0];
        await receiveMessage({ type: 'ready' });

        const loaded = postedMessages.find((message) => message.type === 'bundlesLoaded');
        assert.ok(loaded, 'the ready handshake should deliver the catalog');
        assert.strictEqual(loaded.setupState, SetupState.COMPLETE);
        assert.strictEqual(loaded.sourcesCount, 1);
        assert.strictEqual(loaded.hasConfiguredHub, hasConfiguredHub);
      });
    });

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

  suite('Details panel auto-update messages', () => {
    const bundle = BundleBuilder.github('test-owner', 'test-repo').withVersion('1.0.0').build();

    setup(() => {
      mockRegistryManager.getBundleDetails = sandbox.stub<[string], Promise<Bundle>>().resolves(bundle);
      mockRegistryManager.enableAutoUpdate = sandbox.stub<[string], Promise<void>>().resolves();
      mockRegistryManager.disableAutoUpdate = sandbox.stub<[string], Promise<void>>().resolves();
      sandbox.stub(vscode.window, 'createWebviewPanel').returns({
        viewType: 'bundleDetails',
        title: 'Bundle details',
        options: {},
        viewColumn: vscode.ViewColumn.One,
        active: true,
        visible: true,
        webview: mockWebview,
        onDidDispose: () => ({ dispose: () => {} }),
        onDidChangeViewState: () => ({ dispose: () => {} }),
        reveal: () => {},
        dispose: () => {}
      });
    });

    [true, false].forEach((enabled) => {
      test(`uses the installed panel identity when setting auto-update to ${enabled}`, async () => {
        mockRegistryManager.listInstalledBundles.resolves([createMockInstalledBundle(bundle.id, bundle.version)]);
        await marketplaceProvider.openBundleDetails(bundle.id);
        const receiveMessage = mockWebview.onDidReceiveMessage.lastCall.args[0];
        await receiveMessage({ type: 'toggleAutoUpdate', bundleId: 'another-bundle', enabled });
        assert.deepStrictEqual(
          enabled ? mockRegistryManager.enableAutoUpdate.args : mockRegistryManager.disableAutoUpdate.args,
          [[bundle.id]]
        );
      });
    });

    test('rejects auto-update changes from an uninstalled bundle panel', async () => {
      const showError = sandbox.stub(vscode.window, 'showErrorMessage').resolves();
      await marketplaceProvider.openBundleDetails(bundle.id);
      const receiveMessage = mockWebview.onDidReceiveMessage.lastCall.args[0];
      await receiveMessage({ type: 'toggleAutoUpdate', bundleId: 'another-bundle', enabled: true });
      assert.ok(mockRegistryManager.enableAutoUpdate.notCalled);
      assert.ok(mockRegistryManager.disableAutoUpdate.notCalled);
      assert.ok(showError.calledOnce);
    });

    ['false', null, undefined, 1, {}].forEach((enabled) => {
      test(`rejects a non-boolean auto-update value (${JSON.stringify(enabled)})`, async () => {
        const showError = sandbox.stub(vscode.window, 'showErrorMessage').resolves();
        mockRegistryManager.listInstalledBundles.resolves([createMockInstalledBundle(bundle.id, bundle.version)]);
        await marketplaceProvider.openBundleDetails(bundle.id);
        const receiveMessage = mockWebview.onDidReceiveMessage.lastCall.args[0];
        await receiveMessage({ type: 'toggleAutoUpdate', bundleId: bundle.id, enabled });
        assert.ok(mockRegistryManager.enableAutoUpdate.notCalled);
        assert.ok(mockRegistryManager.disableAutoUpdate.notCalled);
        assert.ok(showError.calledOnce);
      });
    });
  });

  suite('HTML content generation', () => {
    test('opens declared prompt files from the installed bundle, not a WebView path', async () => {
      const installPath = path.join(PROJECT_ROOT, 'test-temp-prompt-open');
      fs.rmSync(installPath, { recursive: true, force: true });
      fs.mkdirSync(installPath, { recursive: true });
      fs.writeFileSync(path.join(installPath, 'prompt.md'), 'prompt');
      const installed = {
        bundleId: 'safe-bundle',
        version: '1.0.0',
        installedAt: new Date().toISOString(),
        scope: 'user',
        installPath,
        manifest: {
          prompts: [{ id: 'prompt', name: 'Prompt', type: 'prompt', file: 'prompt.md' }]
        }
      };
      mockRegistryManager.listInstalledBundles.resolves([installed] as any);
      const openTextDocument = sandbox.spy(vscode.workspace, 'openTextDocument');
      const showTextDocument = sandbox.spy(vscode.window, 'showTextDocument');

      try {
        marketplaceProvider.resolveWebviewView({
          webview: mockWebview,
          onDidChangeVisibility: sandbox.stub().returns({ dispose: () => {} })
        } as any, {} as any, {} as any);
        const receiveMessage = mockWebview.onDidReceiveMessage.lastCall.args[0];

        await receiveMessage({
          type: 'openPromptFile',
          bundleId: 'safe-bundle',
          installPath: '/',
          filePath: 'prompt.md'
        });
        const openedUri = openTextDocument.firstCall?.args[0] as vscode.Uri | undefined;
        assert.strictEqual(openedUri?.fsPath, path.join(installPath, 'prompt.md'));
        assert.strictEqual(showTextDocument.callCount, 1);

        await receiveMessage({
          type: 'openPromptFile',
          bundleId: 'safe-bundle',
          installPath: '/',
          filePath: '../../outside.md'
        });
        assert.strictEqual(openTextDocument.callCount, 1, 'Traversal paths must not be opened');
        assert.strictEqual(showTextDocument.callCount, 1);
      } finally {
        fs.rmSync(installPath, { recursive: true, force: true });
      }
    });

    test('renders attacker-controlled details fields as inert text and attributes', () => {
      const bundle = {
        id: `test' + globalThis.injected + '`,
        name: '<img src=x onerror=alert(1)>',
        version: '1.0.0',
        description: '<script nonce="{{nonce}}">alert(1)</script> $\' {{bundleId}}',
        author: 'author',
        sourceId: 'source',
        environments: ['vscode'],
        tags: ['<svg onload=alert(1)>'],
        lastUpdated: '2025-01-01T00:00:00Z',
        size: '1KB',
        dependencies: [],
        license: 'MIT',
        downloadUrl: 'https://example.com/bundle.zip',
        manifestUrl: 'https://example.com/manifest.json'
      };
      const installed = {
        bundleId: bundle.id,
        version: bundle.version,
        installedAt: new Date().toISOString(),
        scope: 'user',
        installPath: '/tmp/<img src=x onerror=alert(1)>',
        manifest: {
          prompts: [{
            id: '<div data-action="uninstallBundle">',
            name: '<script nonce="{{nonce}}">alert(2)</script>',
            type: 'prompt',
            file: 'prompt.md" data-action="uninstallBundle'
          }],
          mcpServers: {}
        }
      };

      const html = (marketplaceProvider as any).getBundleDetailsHtml(
        mockWebview,
        bundle,
        installed,
        { prompts: 1, instructions: 0, agents: 0, skills: 0, mcpServers: 0 }
      ) as string;

      assert.strictEqual((html.match(/<script\b/g) || []).length, 1, 'Only the trusted external script should remain');
      assert.ok(html.includes('&lt;script nonce=&quot;{{nonce}}&quot;&gt;'));
      assert.ok(html.includes('&lt;svg onload=alert(1)&gt;'));
      assert.ok(html.includes('data-file-path="prompt.md&quot; data-action=&quot;uninstallBundle"'));
      assert.ok(!html.includes(`nonce="` + html.match(/nonce-([A-Za-z0-9]+)/)?.[1] + `">alert`),
        'Untrusted content must not receive the active CSP nonce');
      assert.ok(!html.includes("bundleId: '"), 'Bundle identifiers must not enter an inline JavaScript string');
      assert.ok(html.includes('data-bundle-id="test&#039; + globalThis.injected + &#039;"'));
    });

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

    test('external marketplace JS should progressively refine semantic search results', () => {
      const jsPath = path.join(PROJECT_ROOT, 'src', 'ui', 'webview', 'marketplace', 'marketplace.js');
      if (!fs.existsSync(jsPath)) {
        return;
      }
      const jsContent = fs.readFileSync(jsPath, 'utf8');

      assert.ok(jsContent.includes('let semanticSearchPending = false;'),
        'marketplace.js should track pending semantic searches');
      assert.ok(jsContent.includes('if (semanticSearchPending && hasSearch && filteredBundles.length === 0)'),
        'marketplace.js should show a loading state when semantic results are still pending');
      assert.ok(jsContent.includes('updateMarketplaceSummary();\n        renderBundles();'),
        'marketplace.js should refresh counts when final semantic results arrive');
      assert.ok(jsContent.includes('title="Details"'),
        'marketplace.js should expose bundle details through a focusable button');
      assert.ok(jsContent.includes('title="Open Source Repository"'),
        'marketplace.js should retain an accessible title for the repository icon');
      assert.ok(!jsContent.includes('<span>Repository</span>'),
        'marketplace.js should render the repository action as an icon-only button');
      assert.ok(jsContent.includes('No installed bundles'),
        'marketplace.js should explain when the Installed tab is empty');
      assert.ok(jsContent.includes('All installed bundles are up to date'),
        'marketplace.js should explain when the Updates tab is empty');
      assert.ok(jsContent.includes('checkbox.checked = selectedTags.includes(tag);'),
        'marketplace.js should keep tag checkboxes synchronized with selected tags');
      assert.ok(jsContent.includes('updateFilterUI();\n    updateTagButtonText();\n    updateContentTypeButtonText();'),
        'marketplace.js should refresh the tag selector after removing a tag chip');
    });

    test('external marketplace HTML should not show a separate bundle count summary', () => {
      const htmlPath = path.join(PROJECT_ROOT, 'src', 'ui', 'webview', 'marketplace', 'marketplace.html');
      if (!fs.existsSync(htmlPath)) {
        return;
      }
      const htmlContent = fs.readFileSync(htmlPath, 'utf8');

      assert.ok(!htmlContent.includes('id="filterSummary"'),
        'marketplace.html should not include a separate bundle count summary');
    });
  });
});
