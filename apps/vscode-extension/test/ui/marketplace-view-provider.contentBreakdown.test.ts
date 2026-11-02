/**
 * Tests for the MarketplaceViewProvider content breakdown: the per-kind counts
 * sent to the marketplace webview and rendered in the bundle details panel,
 * Agent Plugins included.
 */
import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  RegistryManager,
} from '../../src/services/registry-manager';
import {
  SetupState,
} from '../../src/services/setup-state-manager';
import {
  Bundle,
  InstalledBundle,
} from '../../src/types/registry';
import {
  MarketplaceViewProvider,
} from '../../src/ui/marketplace-view-provider';
import {
  createMockBundleDetails,
  createMockInstalledBundle,
} from '../helpers/bundle-test-helpers';
import {
  setupRegistryManagerEventMocks,
} from '../helpers/ui-test-helpers';

// Project root for resolving webview assets in dist/
const PROJECT_ROOT = process.cwd();

const EMPTY_BREAKDOWN = { prompts: 0, instructions: 0, chatmodes: 0, agents: 0, skills: 0, plugins: 0, mcpServers: 0 };

const pluginItem = { path: 'plugins/demo/plugin.json', kind: 'plugin', id: 'demo' };
const promptItem = { path: 'prompts/hello.prompt.md', kind: 'prompt', id: 'hello' };

/**
 * A governed release manifest whose legacy `prompts` projection repeats its items.
 * @param items
 */
const releaseManifest = (items: { path: string; kind: string; id: string }[]): any => ({
  formatVersion: 1,
  id: 'bundle',
  version: '1.0.0',
  items,
  prompts: items.map((item) => ({ id: item.id, name: `Item ${item.id}`, file: item.path, type: item.kind }))
});

suite('MarketplaceViewProvider - Content breakdown', () => {
  let sandbox: sinon.SinonSandbox;
  let mockRegistryManager: sinon.SinonStubbedInstance<RegistryManager>;
  let provider: MarketplaceViewProvider;
  let postedMessages: any[];
  let receiveMessage: (message: unknown) => Promise<void>;

  setup(() => {
    sandbox = sinon.createSandbox();
    postedMessages = [];
    const mockContext = {
      subscriptions: [],
      extensionUri: vscode.Uri.file(PROJECT_ROOT),
      extensionPath: PROJECT_ROOT,
      extensionMode: 2 // ExtensionMode.Test
    } as any;
    mockRegistryManager = {
      searchBundles: sandbox.stub().resolves([]),
      listInstalledBundles: sandbox.stub().resolves([]),
      listSources: sandbox.stub().resolves([]),
      getBundleDetails: sandbox.stub(),
      autoUpdateService: null
    } as any;
    setupRegistryManagerEventMocks(mockRegistryManager, sandbox);
    const mockSetupStateManager = {
      getState: sandbox.stub().resolves(SetupState.COMPLETE)
    } as any;
    provider = new MarketplaceViewProvider(mockContext, mockRegistryManager, mockSetupStateManager);

    const webview = {
      postMessage: (message: any) => {
        postedMessages.push(message);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => {
        receiveMessage = handler;
        return { dispose: () => {} };
      },
      asWebviewUri: (uri: vscode.Uri) => uri,
      cspSource: "'self'",
      options: {},
      html: ''
    };
    provider.resolveWebviewView(
      { webview, visible: true, onDidChangeVisibility: () => ({ dispose: () => {} }) } as any,
      {} as vscode.WebviewViewResolveContext,
      {} as vscode.CancellationToken
    );
  });

  teardown(() => {
    provider.dispose();
    sandbox.restore();
  });

  /**
   * Load the marketplace with the given bundles and return the breakdown sent for each.
   * @param bundles - Marketplace bundles.
   * @param installed - Installed bundles.
   */
  const loadBreakdowns = async (bundles: Bundle[], installed: InstalledBundle[] = []): Promise<Record<string, unknown>> => {
    mockRegistryManager.searchBundles.resolves(bundles);
    mockRegistryManager.listInstalledBundles.resolves(installed);
    await receiveMessage({ type: 'ready' });
    const loaded = postedMessages.find((message) => message.type === 'bundlesLoaded');
    assert.ok(loaded, 'bundlesLoaded was posted');
    return Object.fromEntries(loaded.bundles.map((bundle: any) => [bundle.id, bundle.contentBreakdown]));
  };

  test('counts the plugin of an installed plugin-only release once', async () => {
    const breakdowns = await loadBreakdowns(
      [createMockBundleDetails('plugin-only')],
      [createMockInstalledBundle('plugin-only', '1.0.0', { manifest: releaseManifest([pluginItem]) })]
    );
    assert.deepStrictEqual(breakdowns['plugin-only'], { ...EMPTY_BREAKDOWN, plugins: 1 });
  });

  test('counts the plugin and the other items of an installed mixed release', async () => {
    const breakdowns = await loadBreakdowns(
      [createMockBundleDetails('mixed')],
      [createMockInstalledBundle('mixed', '1.0.0', { manifest: releaseManifest([pluginItem, promptItem]) })]
    );
    assert.deepStrictEqual(breakdowns.mixed, { ...EMPTY_BREAKDOWN, plugins: 1, prompts: 1 });
  });

  test('counts an installed release with an empty item list as empty, not from the marketplace bundle data', async () => {
    const bundle = { ...createMockBundleDetails('emptied'), formatVersion: 1, items: [pluginItem] } as Bundle;
    const breakdowns = await loadBreakdowns(
      [bundle],
      [createMockInstalledBundle('emptied', '1.0.0', { manifest: releaseManifest([]) })]
    );
    assert.deepStrictEqual(breakdowns.emptied, EMPTY_BREAKDOWN);
  });

  test('falls back to the marketplace bundle data when the installed manifest declares no item list', async () => {
    const bundle = { ...createMockBundleDetails('minimal'), skills: [{ name: 'a' }, { name: 'b' }] } as Bundle;
    const breakdowns = await loadBreakdowns(
      [bundle],
      [createMockInstalledBundle('minimal', '1.0.0', { manifest: { common: { directories: ['skills/a'] } } as any })]
    );
    assert.deepStrictEqual(breakdowns.minimal, { ...EMPTY_BREAKDOWN, skills: 2 });
  });

  test('counts a plugin an uninstalled release declares only in items[] once', async () => {
    const itemsOnly = { ...createMockBundleDetails('items-only'), formatVersion: 1, items: [pluginItem] } as Bundle;
    const withProjection = { ...createMockBundleDetails('with-projection'), ...releaseManifest([pluginItem]), id: 'with-projection' } as Bundle;
    const breakdowns = await loadBreakdowns([itemsOnly, withProjection]);
    assert.deepStrictEqual(breakdowns['items-only'], { ...EMPTY_BREAKDOWN, plugins: 1 });
    assert.deepStrictEqual(breakdowns['with-projection'], { ...EMPTY_BREAKDOWN, plugins: 1 });
  });

  test('counts plugins embedded in uninstalled bundle data and keeps untyped entries as prompts', async () => {
    const bundle = {
      ...createMockBundleDetails('embedded'),
      prompts: [
        { id: 'demo', file: 'plugins/demo/plugin.json', type: 'plugin' },
        { id: 'hello', file: 'prompts/hello.prompt.md' }
      ]
    } as Bundle;
    const breakdowns = await loadBreakdowns([bundle]);
    assert.deepStrictEqual(breakdowns.embedded, { ...EMPTY_BREAKDOWN, plugins: 1, prompts: 1 });
  });

  test('keeps the adapter breakdown and skills-array paths', async () => {
    const withBreakdown = { ...createMockBundleDetails('with-breakdown'), breakdown: { skills: 2 } } as Bundle;
    const withSkills = {
      ...createMockBundleDetails('with-skills'),
      skills: [{ name: 'a' }, { name: 'b' }, { name: 'c' }]
    } as Bundle;
    const breakdowns = await loadBreakdowns([withBreakdown, withSkills]);
    assert.deepStrictEqual(breakdowns['with-breakdown'], { ...EMPTY_BREAKDOWN, skills: 2 });
    assert.deepStrictEqual(breakdowns['with-skills'], { ...EMPTY_BREAKDOWN, skills: 3 });
  });

  test('renders a Plugins breakdown row and labels plugin items in the details panel', async () => {
    const bundle = createMockBundleDetails('mixed');
    mockRegistryManager.getBundleDetails.resolves(bundle);
    mockRegistryManager.listInstalledBundles.resolves([
      createMockInstalledBundle('mixed', '1.0.0', { manifest: releaseManifest([pluginItem, promptItem]) })
    ]);
    const panel = {
      webview: {
        html: '',
        cspSource: "'self'",
        asWebviewUri: (uri: vscode.Uri) => uri,
        onDidReceiveMessage: () => ({ dispose: () => {} }),
        postMessage: () => Promise.resolve(true)
      },
      onDidDispose: () => ({ dispose: () => {} })
    };
    sandbox.stub(vscode.window, 'createWebviewPanel').returns(panel as any);

    await provider.openBundleDetails('mixed');

    const html = panel.webview.html;
    assert.match(
      html,
      /<div class="breakdown-icon fa-icon fa-plug-circle-check" aria-hidden="true"><\/div>\s*<div class="breakdown-count">1<\/div>\s*<div class="breakdown-label">Plugins<\/div>/
    );
    assert.match(html, /Item demo\s*<em[^>]*>\(Plugin\)<\/em>/);
    assert.match(html, /Item hello\s*<em[^>]*>\(Prompt\)<\/em>/);
    assert.doesNotMatch(html, /class="breakdown-icon(?![^"]*"\s+aria-hidden="true")/, 'every breakdown icon is decorative');
  });
});
