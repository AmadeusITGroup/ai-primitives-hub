/**
 * Target-managed Marketplace: per-installation rows in the bundlesLoaded
 * message, exact-row actions and delivery observation.
 */
import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  MarketplaceViewProvider,
} from '../../src/ui/marketplace-view-provider';
import {
  BundleBuilder,
} from '../helpers/bundle-test-helpers';
import {
  setupRegistryManagerEventMocks,
} from '../helpers/ui-test-helpers';

suite('MarketplaceViewProvider target installations', () => {
  let sandbox: sinon.SinonSandbox;
  let posted: any[];
  let registry: any;
  let provider: MarketplaceViewProvider;
  const bundle = BundleBuilder.github('owner', 'repo').withVersion('2.0.0').build();
  const row = (installationId: string, scope: string, version: string) => ({
    bundleId: bundle.id, version, scope, installationId, targetType: 'kiro', installedAt: '2026-01-01', installPath: '/x'
  });

  const build = (enabled: boolean, rows: unknown[]) => {
    registry = {
      searchBundles: sandbox.stub().resolves([bundle]),
      listInstalledBundles: sandbox.stub().resolves(rows),
      listSources: sandbox.stub().resolves([{ id: bundle.sourceId, type: 'github', name: 's', url: 'https://github.com/owner/repo', enabled: true, priority: 1 }]),
      isRuntimeTargetManagementEnabled: () => enabled,
      isBlockedByLegacyLockfile: sandbox.stub().resolves(false),
      uninstallBundle: sandbox.stub().resolves(),
      updateBundle: sandbox.stub().resolves(),
      autoUpdateService: null
    };
    setupRegistryManagerEventMocks(registry, sandbox);
    const setupState = { getState: sandbox.stub().resolves('complete') };
    provider = new MarketplaceViewProvider({ subscriptions: [], extensionUri: vscode.Uri.file(process.cwd()), extensionMode: 2 } as any, registry, setupState as any);
    (provider as any)._view = { webview: { postMessage: (m: unknown) => {
      posted.push(m);
      return Promise.resolve(true);
    }, options: {}, html: '' } };
    (provider as any).webviewReady = true;
  };

  setup(() => {
    sandbox = sinon.createSandbox();
    posted = [];
  });
  teardown(() => sandbox.restore());

  test('dual-scope rows are reported as installations; the oldest row drives the update state', async () => {
    build(true, [row('rcpt-user', 'user', '2.0.0'), row('rcpt-repo', 'repository', '1.0.0')]);
    await (provider as any).loadBundles();
    const card = posted.at(-1).bundles[0];
    assert.deepStrictEqual(card.installations.map((i: any) => [i.installationId, i.scope, i.version, i.targetType]), [
      ['rcpt-user', 'user', '2.0.0', 'kiro'],
      ['rcpt-repo', 'repository', '1.0.0', 'kiro']
    ]);
    assert.strictEqual(card.installed, true);
    assert.strictEqual(card.buttonState, 'update');
  });

  test('feature off keeps the legacy message shape', async () => {
    build(false, [row('rcpt-user', 'user', '2.0.0')]);
    await (provider as any).loadBundles();
    assert.ok(!('installations' in posted.at(-1).bundles[0]));
  });

  test('catalog still reaches the Marketplace when installed-state lockfile cannot be read', async () => {
    build(true, []);
    registry.listInstalledBundles.rejects(new Error('lockfile invalid: unsupported version 4.0.0'));

    await (provider as any).loadBundles();

    const delivered = posted.at(-1);
    assert.strictEqual(delivered.type, 'bundlesLoaded');
    assert.strictEqual(delivered.bundles.length, 1);
    assert.strictEqual(delivered.bundles[0].installed, false);
    assert.strictEqual(delivered.bundles[0].inventoryUnavailable, true);
    assert.match(delivered.inventoryWarning, /installed.*state|lockfile/i);
  });

  test('deliveredSnapshot returns the message actually posted to the webview', async () => {
    build(true, [row('rcpt-user', 'user', '2.0.0')]);
    await (provider as any).loadBundles();
    assert.strictEqual(await provider.deliveredSnapshot(100), posted.at(-1));
  });

  test('uninstall and update act on the exact installation row', async () => {
    build(true, [row('rcpt-user', 'user', '2.0.0'), row('rcpt-repo', 'repository', '1.0.0')]);
    await provider.handleWebviewMessage({ type: 'uninstall', bundleId: bundle.id, installationId: 'rcpt-repo' });
    assert.deepStrictEqual(registry.uninstallBundle.firstCall.args, [bundle.id, 'repository', false, 'rcpt-repo']);
    await provider.handleWebviewMessage({ type: 'update', bundleId: bundle.id, installationId: 'rcpt-repo' });
    assert.deepStrictEqual(registry.updateBundle.firstCall.args, [bundle.id, undefined, 'rcpt-repo']);
  });

  test('an ambiguous action asks which row instead of guessing; cancelling does nothing', async () => {
    build(true, [row('rcpt-user', 'user', '2.0.0'), row('rcpt-repo', 'repository', '1.0.0')]);
    const pick = sandbox.stub(vscode.window, 'showQuickPick');
    pick.callsFake(async (items: any) => (await items).find((i: any) => i.row.installationId === 'rcpt-user'));
    await provider.handleWebviewMessage({ type: 'uninstall', bundleId: bundle.id });
    assert.strictEqual(pick.callCount, 1);
    assert.strictEqual(registry.uninstallBundle.firstCall.args[3], 'rcpt-user');
    pick.resolves(undefined);
    await provider.handleWebviewMessage({ type: 'update', bundleId: bundle.id });
    assert.strictEqual(registry.updateBundle.callCount, 0);
  });

  test('a legacy lockfile blocks install, update and uninstall before any prompt', async () => {
    build(true, [row('rcpt-user', 'user', '2.0.0')]);
    registry.isBlockedByLegacyLockfile.resolves(true);
    const pick = sandbox.stub(vscode.window, 'showQuickPick');
    await provider.handleWebviewMessage({ type: 'uninstall', bundleId: bundle.id, installationId: 'rcpt-user' });
    await provider.handleWebviewMessage({ type: 'update', bundleId: bundle.id, installationId: 'rcpt-user' });
    await provider.handleWebviewMessage({ type: 'install', bundleId: bundle.id });
    assert.strictEqual(registry.uninstallBundle.callCount, 0);
    assert.strictEqual(registry.updateBundle.callCount, 0);
    assert.strictEqual(pick.callCount, 0);
  });

  test('installed rows whose source is not configured stay visible as their own card', async () => {
    build(true, [row('rcpt-user', 'user', '2.0.0'), { ...row('rcpt-orphan', 'repository', '1.0.0'), bundleId: 'orphan', manifestId: 'orphan', sourceId: 'gone' }]);
    await (provider as any).loadBundles();
    const cards = posted.at(-1).bundles;
    const orphan = cards.find((c: any) => c.manifestId === 'orphan');
    assert.ok(orphan);
    assert.deepStrictEqual(orphan.installations.map((i: any) => i.installationId), ['rcpt-orphan']);
    assert.strictEqual(orphan.installed, true);
  });
});
