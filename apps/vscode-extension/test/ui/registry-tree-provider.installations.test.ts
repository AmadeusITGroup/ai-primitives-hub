/**
 * Explorer "Installed Bundles": one node per target-managed installation.
 */
import * as assert from 'node:assert';
import * as sinon from 'sinon';
import {
  RegistryTreeProvider,
  TreeItemType,
} from '../../src/ui/registry-tree-provider';
import {
  setupHubManagerEventMocks,
  setupRegistryManagerEventMocks,
} from '../helpers/ui-test-helpers';

suite('RegistryTreeProvider target installations', () => {
  const sandbox = sinon.createSandbox();
  teardown(() => sandbox.restore());

  const row = (installationId: string, scope: string, version: string) => ({
    bundleId: 'alpha', manifestId: 'alpha', version, scope, installationId, targetType: 'kiro', installedAt: '2026-01-01', installPath: '/x'
  });

  test('lists one node per installation with scope and version, carrying the installation id', async () => {
    const registry: any = {
      listInstalledBundles: sandbox.stub().resolves([row('rcpt-repo', 'repository', '1.0.0'), row('rcpt-user', 'user', '2.0.0')]),
      getBundleDetails: sandbox.stub().resolves({ name: 'Alpha' }),
      autoUpdateService: null
    };
    setupRegistryManagerEventMocks(registry, sandbox);
    const hub: any = { listHubs: sandbox.stub().resolves([]), getActiveHubId: sandbox.stub().resolves(undefined) };
    setupHubManagerEventMocks(hub, sandbox);
    const provider = new RegistryTreeProvider(registry, hub);
    const nodes = await provider.installedNodes();
    assert.deepStrictEqual(nodes, [
      { collection: 'alpha', scope: 'repository', version: '1.0.0', installationId: 'rcpt-repo' },
      { collection: 'alpha', scope: 'user', version: '2.0.0', installationId: 'rcpt-user' }
    ]);
    const items = await (provider as any).getInstalledBundleItems();
    assert.deepStrictEqual(items.map((i: any) => i.label), ['Alpha', 'Alpha'], 'tree icon supplies the installed mark without a duplicate glyph');
    assert.deepStrictEqual(items.map((i: any) => i.accessibilityInformation.label), [
      'Alpha, installed in repository scope, version 1.0.0',
      'Alpha, installed in user scope, version 2.0.0'
    ]);
    assert.deepStrictEqual(items.map((i: any) => i.description), ['repository · v1.0.0', 'user · v2.0.0']);
    provider.dispose?.();
  });

  test('renders an installed-state warning when the authoritative lockfile cannot be read', async () => {
    const registry: any = {
      listInstalledBundles: sandbox.stub().rejects(new Error('unsupported lockfile version 4.0.0')),
      getBundleDetails: sandbox.stub(),
      autoUpdateService: null
    };
    setupRegistryManagerEventMocks(registry, sandbox);
    const hub: any = { listHubs: sandbox.stub().resolves([]), getActiveHubId: sandbox.stub().resolves(undefined) };
    setupHubManagerEventMocks(hub, sandbox);
    const provider = new RegistryTreeProvider(registry, hub);
    const items = await provider.installedNodes();
    assert.deepStrictEqual(items, [{
      error: 'Installed state unavailable: unsupported lockfile version 4.0.0'
    }]);
    const roots = await provider.getChildren();
    const installedRoot = roots.find((item) => item.type === TreeItemType.INSTALLED_ROOT);
    const children = await provider.getChildren(installedRoot);
    assert.strictEqual(children[0].label, 'Installed state unavailable');
    const tooltip = children[0].tooltip;
    assert.strictEqual(typeof tooltip, 'string');
    if (typeof tooltip === 'string') {
      assert.match(tooltip, /unsupported lockfile version 4\.0\.0/);
    }
    provider.dispose?.();
  });
});
