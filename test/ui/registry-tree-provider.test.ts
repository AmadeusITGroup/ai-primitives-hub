import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  CachedRating,
  RatingCache,
} from '../../src/services/engagement/rating-cache';
import {
  HubManager,
} from '../../src/services/hub-manager';
import {
  RegistryManager,
} from '../../src/services/registry-manager';
import {
  HubProfile,
} from '../../src/types/hub';
import {
  Bundle,
  InstalledBundle,
} from '../../src/types/registry';
import {
  RegistryTreeItem,
  RegistryTreeProvider,
  TreeItemType,
} from '../../src/ui/registry-tree-provider';
import {
  setupTreeProviderMocks,
} from '../helpers/ui-test-helpers';

suite('RegistryTreeProvider - Hub Profiles', () => {
  let provider: RegistryTreeProvider;
  let registryManagerStub: sinon.SinonStubbedInstance<RegistryManager>;
  let hubManagerStub: sinon.SinonStubbedInstance<HubManager>;
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
    registryManagerStub = sandbox.createStubInstance(RegistryManager);
    hubManagerStub = sandbox.createStubInstance(HubManager);

    // Use shared helper for consistent mock setup
    setupTreeProviderMocks(registryManagerStub, hubManagerStub, sandbox);

    provider = new RegistryTreeProvider(registryManagerStub, hubManagerStub);
  });

  teardown(() => {
    sandbox.restore();
  });

  test('getFavoritesItems should return items with correct contextValue for menu actions', async () => {
    (provider as any).viewMode = 'favorites';
    const mockProfile: HubProfile = {
      id: 'test-profile',
      name: 'Test Profile',
      description: 'Test Description',
      bundles: [],
      active: false,
      icon: 'test-icon',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const favorites = {
      'test-hub': ['test-profile']
    };

    hubManagerStub.getFavoriteProfiles.resolves(favorites);
    hubManagerStub.getHubProfile.resolves(mockProfile);
    // Mock getHubInfo for the hub grouping
    hubManagerStub.getHubInfo.withArgs('test-hub').resolves({
      id: 'test-hub',
      config: { metadata: { name: 'Test Hub' } } as any,
      reference: {} as any,
      metadata: {} as any
    });
    registryManagerStub.listLocalProfiles.resolves([]); // Mock empty local profiles

    // Access private method for testing via any cast
    const items = await (provider as any).getFavoritesItems();

    // 1 Hub Item + 0 local + 1 create button = 2 items
    assert.strictEqual(items.length, 3);

    const hubItem = items.find((i: RegistryTreeItem) => i.label === 'Test Hub');
    assert.ok(hubItem);
    assert.strictEqual(hubItem.type, TreeItemType.HUB);

    // Get children of Hub Item to find the profile
    hubManagerStub.listProfilesFromHub.withArgs('test-hub').resolves([mockProfile]);
    const children = await provider.getChildren(hubItem);

    const profileItem = children.find((i: RegistryTreeItem) => i.label === 'test-icon ⭐ Test Profile');
    assert.ok(profileItem);
    assert.strictEqual(profileItem.type, TreeItemType.HUB_PROFILE);
    // contextValue should enable profile actions
    assert.ok(profileItem.contextValue && profileItem.contextValue.includes('hub_profile'));
  });

  test('Favorites view should include local profiles and Create New Profile item', async () => {
    (provider as any).viewMode = 'favorites';
    const mockHubProfile: HubProfile = {
      id: 'test-hub-profile',
      name: 'Hub Profile',
      description: 'Test Description',
      bundles: [],
      active: false,
      icon: 'test-icon',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const mockLocalProfile = {
      id: 'local-profile',
      name: 'Local Profile',
      description: 'Local Description',
      bundles: [],
      active: true,
      icon: 'local-icon',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const favorites = {
      'test-hub': ['test-hub-profile']
    };

    hubManagerStub.getFavoriteProfiles.resolves(favorites);
    hubManagerStub.getHubProfile.resolves(mockHubProfile);
    hubManagerStub.getHubInfo.withArgs('test-hub').resolves({
      id: 'test-hub',
      config: { metadata: { name: 'Test Hub' } } as any,
      reference: {} as any,
      metadata: {} as any
    });
    registryManagerStub.listLocalProfiles.resolves([mockLocalProfile]);

    // Access private method
    const items = await (provider as any).getFavoritesItems();

    // Should contain: 1 Hub Item + 1 Local Profiles folder + 1 create button
    assert.strictEqual(items.length, 4);

    const hubItem = items.find((i: RegistryTreeItem) => i.label === 'Test Hub');
    assert.ok(hubItem, 'Hub item should be present for favorited hub profiles');

    const localProfilesFolder = items.find((i: RegistryTreeItem) => i.label === 'Local Profiles');
    assert.ok(localProfilesFolder, 'Local Profiles folder should be present');

    const createItem = items.find((i: RegistryTreeItem) => i.type === TreeItemType.CREATE_PROFILE);
    assert.ok(createItem, 'Create Profile item should be present');
  });

  test('Active Hub Profile should be indicated', async () => {
    (provider as any).viewMode = 'favorites';
    const mockProfile: HubProfile = {
      id: 'test-profile',
      name: 'Test Profile',
      description: 'Test Description',
      bundles: [],
      active: true, // Active
      icon: 'test-icon',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const favorites = {
      'test-hub': ['test-profile']
    };

    hubManagerStub.getFavoriteProfiles.resolves(favorites);
    hubManagerStub.getHubProfile.resolves(mockProfile);
    hubManagerStub.listProfilesFromHub.withArgs('test-hub').resolves([mockProfile]);
    hubManagerStub.getHubInfo.withArgs('test-hub').resolves({
      id: 'test-hub',
      config: { metadata: { name: 'Test Hub' } } as any,
      reference: {} as any,
      metadata: {} as any
    });
    registryManagerStub.listLocalProfiles.resolves([]);

    const items = await (provider as any).getFavoritesItems();
    const hubItem = items.find((i: RegistryTreeItem) => i.label === 'Test Hub');

    const children = await provider.getChildren(hubItem);
    const item = children.find((i: RegistryTreeItem) => i.label === 'test-icon ⭐ Test Profile'); // Expect profile icon + star

    assert.ok(item);
    assert.strictEqual(item.description, '[Active]');
  });

  test('Favorites root item should not have emoji in label', () => {
    (provider as any).viewMode = 'favorites';
    const roots = (provider as any).getRootItems();
    const favoritesRoot = roots.find((i: RegistryTreeItem) => i.type === TreeItemType.FAVORITES_ROOT);

    assert.strictEqual(favoritesRoot.label, 'Favorites');
  });

  test('Favorites view should show Active Profile section with None when no profile is active', async () => {
    (provider as any).viewMode = 'favorites';

    hubManagerStub.getFavoriteProfiles.resolves({});
    registryManagerStub.listLocalProfiles.resolves([]);
    hubManagerStub.listAllActiveProfiles.resolves([]);

    const items = await (provider as any).getFavoritesItems();

    assert.strictEqual(items[0].label, 'Active Profile');

    const activeProfileSection = items.find((i: RegistryTreeItem) => i.label === 'Active Profile');
    assert.ok(activeProfileSection);

    const children = await provider.getChildren(activeProfileSection);
    assert.strictEqual(children.length, 1);
    assert.strictEqual(children[0].label, 'None');
  });

  test('Favorites view should show active local profile in Active Profile section', async () => {
    (provider as any).viewMode = 'favorites';

    const mockLocalProfile = {
      id: 'local-profile',
      name: 'Local Profile',
      description: 'Local Description',
      bundles: [],
      active: true,
      icon: 'local-icon',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    hubManagerStub.getFavoriteProfiles.resolves({});
    registryManagerStub.listLocalProfiles.resolves([mockLocalProfile]);
    hubManagerStub.listAllActiveProfiles.resolves([]);

    const items = await (provider as any).getFavoritesItems();
    const activeProfileSection = items.find((i: RegistryTreeItem) => i.label === 'Active Profile');
    assert.ok(activeProfileSection);

    const children = await provider.getChildren(activeProfileSection);
    const activeItem = children.find((i: RegistryTreeItem) => i.label === 'Local Profile');
    assert.ok(activeItem);
    assert.strictEqual(activeItem.type, TreeItemType.PROFILE);
    assert.strictEqual(activeItem.description, '[Active]');
  });

  test('Favorites view should show active hub profile in Active Profile section', async () => {
    (provider as any).viewMode = 'favorites';

    const hubId = 'test-hub';
    const activeProfile: HubProfile = {
      id: 'active-profile',
      name: 'Active Profile',
      description: 'Active',
      bundles: [],
      active: true,
      icon: 'icon',
      path: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    hubManagerStub.getFavoriteProfiles.resolves({});
    registryManagerStub.listLocalProfiles.resolves([]);
    hubManagerStub.listAllActiveProfiles.resolves([
      {
        hubId,
        profileId: 'active-profile',
        activatedAt: new Date().toISOString(),
        syncedBundles: []
      }
    ]);
    hubManagerStub.getHubProfile.withArgs(hubId, 'active-profile').resolves(activeProfile);

    const items = await (provider as any).getFavoritesItems();
    const activeProfileSection = items.find((i: RegistryTreeItem) => i.label === 'Active Profile');
    assert.ok(activeProfileSection);

    const children = await provider.getChildren(activeProfileSection);
    const activeItem = children.find((i: RegistryTreeItem) => i.label === 'icon Active Profile');
    assert.ok(activeItem);
    assert.strictEqual(activeItem.type, TreeItemType.HUB_PROFILE);
    assert.strictEqual(activeItem.description, '[Active]');
  });

  test('should deduplicate items when local profile matches favorite Hub Profile', async () => {
    (provider as any).viewMode = 'favorites';
    const commonId = 'common-profile';

    const mockHubProfile: HubProfile = {
      id: commonId,
      name: 'Common Profile',
      description: 'Hub Version',
      bundles: [],
      active: false,
      icon: 'hub-icon',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const mockLocalProfile = {
      id: commonId,
      name: 'Common Profile',
      description: 'Local Version',
      bundles: [],
      active: true,
      icon: 'local-icon',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Profile is favorited
    const favorites = {
      'test-hub': [commonId]
    };

    hubManagerStub.getFavoriteProfiles.resolves(favorites);
    hubManagerStub.getHubProfile.resolves(mockHubProfile);
    hubManagerStub.listProfilesFromHub.withArgs('test-hub').resolves([mockHubProfile]);
    hubManagerStub.getHubInfo.withArgs('test-hub').resolves({
      id: 'test-hub',
      config: { metadata: { name: 'Test Hub' } } as any,
      reference: {} as any,
      metadata: {} as any
    });
    registryManagerStub.listLocalProfiles.resolves([mockLocalProfile]);

    const items = await (provider as any).getFavoritesItems();

    // Should return 3 items: 1 Hub Item + 1 Local Profiles folder + 1 Create Button
    // Local profiles are now in their own folder, separate from hub favorites
    assert.strictEqual(items.length, 4);

    const hubItem = items.find((i: RegistryTreeItem) => i.type === TreeItemType.HUB);
    assert.ok(hubItem, 'Hub Item should be present');

    const localProfilesFolder = items.find((i: RegistryTreeItem) => i.type === TreeItemType.LOCAL_PROFILES_FOLDER);
    assert.ok(localProfilesFolder, 'Local Profiles folder should be present');
  });

  test('Shared Profiles view should indicate active status', async () => {
    // Setup provider in 'all' mode (Shared Profiles)
    (provider as any).viewMode = 'all';

    const hubId = 'test-hub';
    const activeProfile: HubProfile = {
      id: 'active-profile',
      name: 'Active Profile',
      description: 'Active',
      bundles: [],
      active: true,
      icon: 'icon',
      path: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const inactiveProfile: HubProfile = {
      id: 'inactive-profile',
      name: 'Inactive Profile',
      description: 'Inactive',
      bundles: [],
      active: false,
      icon: 'icon',
      path: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    hubManagerStub.listProfilesFromHub.withArgs(hubId).resolves([activeProfile, inactiveProfile]);
    hubManagerStub.getFavoriteProfiles.resolves({});

    // Mock a hub item as parent
    const hubItem = new RegistryTreeItem(
      'Test Hub',
      TreeItemType.HUB,
      { id: hubId, name: 'Test Hub' },
      vscode.TreeItemCollapsibleState.Expanded
    );

    const items = await provider.getChildren(hubItem);

    const activeItem = items.find((i) => i.label === 'icon Active Profile');
    assert.ok(activeItem);
    assert.strictEqual(activeItem.description, '[Active]');

    const inactiveItem = items.find((i) => i.label === 'icon Inactive Profile');
    assert.ok(inactiveItem);
    // Inactive profiles have empty string description to match PROFILE behavior
    assert.strictEqual(inactiveItem.description, '');
  });

  test('should organize profiles by path', async () => {
    (provider as any).viewMode = 'all';
    const hubId = 'test-hub';

    const rootProfile: HubProfile = {
      id: 'root-profile',
      name: 'Root Profile',
      description: '',
      bundles: [],
      path: [],
      active: false,
      icon: 'icon',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const nestedProfile: HubProfile = {
      id: 'nested-profile',
      name: 'Nested Profile',
      description: '',
      bundles: [],
      path: ['Folder', 'Subfolder'],
      active: false,
      icon: 'icon',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    hubManagerStub.listProfilesFromHub.withArgs(hubId).resolves([rootProfile, nestedProfile]);
    hubManagerStub.getFavoriteProfiles.resolves({});

    // Get root children
    const hubItem = new RegistryTreeItem(
      'Test Hub',
      TreeItemType.HUB,
      { id: hubId },
      vscode.TreeItemCollapsibleState.Expanded
    );

    const rootItems = await provider.getChildren(hubItem);

    // Should find "Root Profile" (with icon prefix) and "Folder"
    const rootProfileItem = rootItems.find((i) => i.label === 'icon Root Profile');
    const folderItem = rootItems.find((i) => i.label === 'Folder');

    assert.ok(rootProfileItem, 'Root Profile not found');
    assert.ok(folderItem, 'Folder not found');
    assert.strictEqual(folderItem.type, TreeItemType.PROFILE_FOLDER);

    // Get Folder children
    const folderChildren = await provider.getChildren(folderItem);

    // Should find "Subfolder"
    const subfolderItem = folderChildren.find((i) => i.label === 'Subfolder');
    assert.ok(subfolderItem, 'Subfolder not found');
    assert.strictEqual(subfolderItem.type, TreeItemType.PROFILE_FOLDER);

    // Get Subfolder children
    const subfolderChildren = await provider.getChildren(subfolderItem);

    // Should find "Nested Profile" (with icon prefix)
    const nestedProfileItem = subfolderChildren.find((i) => i.label === 'icon Nested Profile');
    assert.ok(nestedProfileItem, 'Nested Profile not found');
  });
});

suite('RegistryTreeProvider - Dual-Scope Display', () => {
  let provider: RegistryTreeProvider;
  let registryManagerStub: sinon.SinonStubbedInstance<RegistryManager>;
  let hubManagerStub: sinon.SinonStubbedInstance<HubManager>;
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
    registryManagerStub = sandbox.createStubInstance(RegistryManager);
    hubManagerStub = sandbox.createStubInstance(HubManager);

    // Use shared helper for consistent mock setup
    setupTreeProviderMocks(registryManagerStub, hubManagerStub, sandbox);

    provider = new RegistryTreeProvider(registryManagerStub, hubManagerStub);
  });

  teardown(() => {
    sandbox.restore();
  });

  test('should list bundles from both user and repository scopes', async () => {
    const userBundle = {
      bundleId: 'user-bundle',
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      scope: 'user' as const,
      installPath: '/user/path',
      manifest: {} as any
    };

    const repositoryBundle = {
      bundleId: 'repo-bundle',
      version: '2.0.0',
      installedAt: new Date().toISOString(),
      scope: 'repository' as const,
      installPath: '/repo/path',
      manifest: {} as any
    };

    registryManagerStub.listInstalledBundles.resolves([userBundle, repositoryBundle]);
    registryManagerStub.getBundleDetails.withArgs('user-bundle').resolves({
      id: 'user-bundle',
      name: 'User Bundle',
      version: '1.0.0',
      description: 'User bundle',
      author: 'Author',
      sourceId: 'source1',
      environments: [],
      tags: [],
      lastUpdated: new Date().toISOString(),
      size: '1MB',
      dependencies: [],
      license: 'MIT',
      manifestUrl: 'https://example.com/manifest',
      downloadUrl: 'https://example.com/download'
    });
    registryManagerStub.getBundleDetails.withArgs('repo-bundle').resolves({
      id: 'repo-bundle',
      name: 'Repository Bundle',
      version: '2.0.0',
      description: 'Repository bundle',
      author: 'Author',
      sourceId: 'source1',
      environments: [],
      tags: [],
      lastUpdated: new Date().toISOString(),
      size: '2MB',
      dependencies: [],
      license: 'MIT',
      manifestUrl: 'https://example.com/manifest',
      downloadUrl: 'https://example.com/download'
    });

    const installedRoot = new RegistryTreeItem(
      'Installed Bundles',
      TreeItemType.INSTALLED_ROOT,
      undefined,
      vscode.TreeItemCollapsibleState.Expanded
    );

    const items = await provider.getChildren(installedRoot);

    assert.strictEqual(items.length, 2, 'Should display both user and repository bundles');

    const userItem = items.find((i) => i.label.includes('User Bundle'));
    const repoItem = items.find((i) => i.label.includes('Repository Bundle'));

    assert.ok(userItem, 'User bundle should be displayed');
    assert.ok(repoItem, 'Repository bundle should be displayed');
  });

  test('should show scope indicator for repository bundles', async () => {
    const repositoryBundle = {
      bundleId: 'repo-bundle',
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      scope: 'repository' as const,
      commitMode: 'commit' as const,
      installPath: '/repo/path',
      manifest: {} as any
    };

    registryManagerStub.listInstalledBundles.resolves([repositoryBundle]);
    registryManagerStub.getBundleDetails.withArgs('repo-bundle').resolves({
      id: 'repo-bundle',
      name: 'Repository Bundle',
      version: '1.0.0',
      description: 'Repository bundle',
      author: 'Author',
      sourceId: 'source1',
      environments: [],
      tags: [],
      lastUpdated: new Date().toISOString(),
      size: '1MB',
      dependencies: [],
      license: 'MIT',
      manifestUrl: 'https://example.com/manifest',
      downloadUrl: 'https://example.com/download'
    });

    const installedRoot = new RegistryTreeItem(
      'Installed Bundles',
      TreeItemType.INSTALLED_ROOT,
      undefined,
      vscode.TreeItemCollapsibleState.Expanded
    );

    const items = await provider.getChildren(installedRoot);

    assert.strictEqual(items.length, 1);
    const item = items[0];

    // Should have scope indicator in context value
    assert.ok(item.contextValue, 'Should have context value');
    assert.ok(
      item.contextValue.includes('repository') || item.data.scope === 'repository',
      'Should indicate repository scope'
    );

    // Verify scope is accessible from bundle data
    assert.strictEqual(item.data.scope, 'repository', 'Bundle data should contain repository scope');
  });

  test('should show scope indicator for user bundles', async () => {
    const userBundle = {
      bundleId: 'user-bundle',
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      scope: 'user' as const,
      installPath: '/user/path',
      manifest: {} as any
    };

    registryManagerStub.listInstalledBundles.resolves([userBundle]);
    registryManagerStub.getBundleDetails.withArgs('user-bundle').resolves({
      id: 'user-bundle',
      name: 'User Bundle',
      version: '1.0.0',
      description: 'User bundle',
      author: 'Author',
      sourceId: 'source1',
      environments: [],
      tags: [],
      lastUpdated: new Date().toISOString(),
      size: '1MB',
      dependencies: [],
      license: 'MIT',
      manifestUrl: 'https://example.com/manifest',
      downloadUrl: 'https://example.com/download'
    });

    const installedRoot = new RegistryTreeItem(
      'Installed Bundles',
      TreeItemType.INSTALLED_ROOT,
      undefined,
      vscode.TreeItemCollapsibleState.Expanded
    );

    const items = await provider.getChildren(installedRoot);

    assert.strictEqual(items.length, 1);
    const item = items[0];

    // Verify scope is accessible from bundle data
    assert.strictEqual(item.data.scope, 'user', 'Bundle data should contain user scope');
  });

  test('should show update indicators for both user and repository scopes', async () => {
    const userBundle = {
      bundleId: 'user-bundle',
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      scope: 'user' as const,
      installPath: '/user/path',
      manifest: {} as any
    };

    const repositoryBundle = {
      bundleId: 'repo-bundle',
      version: '2.0.0',
      installedAt: new Date().toISOString(),
      scope: 'repository' as const,
      installPath: '/repo/path',
      manifest: {} as any
    };

    registryManagerStub.listInstalledBundles.resolves([userBundle, repositoryBundle]);
    registryManagerStub.getBundleDetails.withArgs('user-bundle').resolves({
      id: 'user-bundle',
      name: 'User Bundle',
      version: '1.0.0',
      description: 'User bundle',
      author: 'Author',
      sourceId: 'source1',
      environments: [],
      tags: [],
      lastUpdated: new Date().toISOString(),
      size: '1MB',
      dependencies: [],
      license: 'MIT',
      manifestUrl: 'https://example.com/manifest',
      downloadUrl: 'https://example.com/download'
    });
    registryManagerStub.getBundleDetails.withArgs('repo-bundle').resolves({
      id: 'repo-bundle',
      name: 'Repository Bundle',
      version: '2.0.0',
      description: 'Repository bundle',
      author: 'Author',
      sourceId: 'source1',
      environments: [],
      tags: [],
      lastUpdated: new Date().toISOString(),
      size: '2MB',
      dependencies: [],
      license: 'MIT',
      manifestUrl: 'https://example.com/manifest',
      downloadUrl: 'https://example.com/download'
    });

    // Simulate updates available for both bundles
    provider.onUpdatesDetected([
      {
        bundleId: 'user-bundle',
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        releaseDate: new Date().toISOString(),
        downloadUrl: 'https://example.com/download',
        autoUpdateEnabled: false
      },
      {
        bundleId: 'repo-bundle',
        currentVersion: '2.0.0',
        latestVersion: '2.1.0',
        releaseDate: new Date().toISOString(),
        downloadUrl: 'https://example.com/download',
        autoUpdateEnabled: false
      }
    ]);

    const installedRoot = new RegistryTreeItem(
      'Installed Bundles',
      TreeItemType.INSTALLED_ROOT,
      undefined,
      vscode.TreeItemCollapsibleState.Expanded
    );

    const items = await provider.getChildren(installedRoot);

    assert.strictEqual(items.length, 2);

    // Both should show update indicator
    const userItem = items.find((i) => i.label.includes('User Bundle'));
    const repoItem = items.find((i) => i.label.includes('Repository Bundle'));

    assert.ok(userItem, 'User bundle should be displayed');
    assert.ok(repoItem, 'Repository bundle should be displayed');

    // Check for update indicator (⬆️)
    assert.ok(userItem.label.includes('⬆️'), 'User bundle should show update indicator');
    assert.ok(repoItem.label.includes('⬆️'), 'Repository bundle should show update indicator');

    // Check version display shows both versions
    assert.ok(userItem.description && typeof userItem.description === 'string' && userItem.description.includes('→'), 'User bundle should show version arrow');
    assert.ok(repoItem.description && typeof repoItem.description === 'string' && repoItem.description.includes('→'), 'Repository bundle should show version arrow');
  });

  test('should differentiate commit mode in context value for repository bundles', async () => {
    const commitBundle = {
      bundleId: 'commit-bundle',
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      scope: 'repository' as const,
      commitMode: 'commit' as const,
      installPath: '/repo/path',
      manifest: {} as any
    };

    const localOnlyBundle = {
      bundleId: 'local-bundle',
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      scope: 'repository' as const,
      commitMode: 'local-only' as const,
      installPath: '/repo/path',
      manifest: {} as any
    };

    registryManagerStub.listInstalledBundles.resolves([commitBundle, localOnlyBundle]);
    registryManagerStub.getBundleDetails.withArgs('commit-bundle').resolves({
      id: 'commit-bundle',
      name: 'Commit Bundle',
      version: '1.0.0',
      description: 'Commit bundle',
      author: 'Author',
      sourceId: 'source1',
      environments: [],
      tags: [],
      lastUpdated: new Date().toISOString(),
      size: '1MB',
      dependencies: [],
      license: 'MIT',
      manifestUrl: 'https://example.com/manifest',
      downloadUrl: 'https://example.com/download'
    });
    registryManagerStub.getBundleDetails.withArgs('local-bundle').resolves({
      id: 'local-bundle',
      name: 'Local Bundle',
      version: '1.0.0',
      description: 'Local bundle',
      author: 'Author',
      sourceId: 'source1',
      environments: [],
      tags: [],
      lastUpdated: new Date().toISOString(),
      size: '1MB',
      dependencies: [],
      license: 'MIT',
      manifestUrl: 'https://example.com/manifest',
      downloadUrl: 'https://example.com/download'
    });

    const installedRoot = new RegistryTreeItem(
      'Installed Bundles',
      TreeItemType.INSTALLED_ROOT,
      undefined,
      vscode.TreeItemCollapsibleState.Expanded
    );

    const items = await provider.getChildren(installedRoot);

    assert.strictEqual(items.length, 2);

    const commitItem = items.find((i) => i.label.includes('Commit Bundle'));
    const localItem = items.find((i) => i.label.includes('Local Bundle'));

    assert.ok(commitItem, 'Commit bundle should be displayed');
    assert.ok(localItem, 'Local bundle should be displayed');

    // Verify commit mode is accessible from data
    assert.strictEqual(commitItem.data.commitMode, 'commit');
    assert.strictEqual(localItem.data.commitMode, 'local-only');
  });

  test('Favorites view should organize hub profiles by path', async () => {
    (provider as any).viewMode = 'favorites';
    const hubId = 'test-hub';

    const nestedProfile: HubProfile = {
      id: 'nested-profile',
      name: 'Nested Profile',
      description: '',
      bundles: [],
      path: ['Folder', 'Subfolder'],
      active: true, // Make it active
      icon: 'icon',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const favorites = {
      [hubId]: ['nested-profile']
    };

    hubManagerStub.getFavoriteProfiles.resolves(favorites);
    hubManagerStub.listProfilesFromHub.withArgs(hubId).resolves([nestedProfile]);
    hubManagerStub.getHubInfo.withArgs(hubId).resolves({
      id: hubId,
      config: { metadata: { name: 'Test Hub' } } as any,
      reference: {} as any,
      metadata: {} as any
    });

    const items = await (provider as any).getFavoritesItems();

    // Should find "Test Hub" as a root item in favorites
    const hubItem = items.find((i: RegistryTreeItem) => i.label === 'Test Hub');
    assert.ok(hubItem, 'Hub item not found in favorites');
    assert.strictEqual(hubItem.type, TreeItemType.HUB);

    // Get children of the hub item
    const children = await provider.getChildren(hubItem);

    // Should find "Folder"
    const folderItem = children.find((i: RegistryTreeItem) => i.label === 'Folder');
    assert.ok(folderItem, 'Folder not found in favorites');
    assert.strictEqual(folderItem.type, TreeItemType.PROFILE_FOLDER);

    // Get children of folder
    const folderChildren = await provider.getChildren(folderItem);

    // Should find "Subfolder"
    const subfolderItem = folderChildren.find((i: RegistryTreeItem) => i.label === 'Subfolder');
    assert.ok(subfolderItem, 'Subfolder not found');
    assert.strictEqual(subfolderItem.type, TreeItemType.PROFILE_FOLDER);

    // Get Subfolder children
    const subfolderChildren = await provider.getChildren(subfolderItem);

    // Should find "Nested Profile" with icon prefix, star, and active status
    const nestedProfileItem = subfolderChildren.find((i: RegistryTreeItem) => i.label === 'icon ⭐ Nested Profile');
    assert.ok(nestedProfileItem, 'Nested Profile not found');
    assert.strictEqual(nestedProfileItem.description, '[Active]', 'Nested profile should be indicated as active');
  });
});

/**
 * Property 11: UI Warning Display
 * Validates: Requirements 3.3
 *
 * For any bundle with `filesMissing` set to `true`, the UI SHALL display
 * a warning indicator distinguishing it from bundles with valid files.
 */
suite('RegistryTreeProvider - Files Missing Warning Indicator', () => {
  let provider: RegistryTreeProvider;
  let registryManagerStub: sinon.SinonStubbedInstance<RegistryManager>;
  let hubManagerStub: sinon.SinonStubbedInstance<HubManager>;
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
    registryManagerStub = sandbox.createStubInstance(RegistryManager);
    hubManagerStub = sandbox.createStubInstance(HubManager);

    // Use shared helper for consistent mock setup
    setupTreeProviderMocks(registryManagerStub, hubManagerStub, sandbox);

    provider = new RegistryTreeProvider(registryManagerStub, hubManagerStub);
  });

  teardown(() => {
    sandbox.restore();
  });

  test('should show warning indicator for bundle with filesMissing flag', async () => {
    const bundleWithMissingFiles = {
      bundleId: 'missing-files-bundle',
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      scope: 'repository' as const,
      commitMode: 'commit' as const,
      installPath: '/repo/path',
      manifest: {} as any,
      filesMissing: true
    };

    registryManagerStub.listInstalledBundles.resolves([bundleWithMissingFiles]);
    registryManagerStub.getBundleDetails.withArgs('missing-files-bundle').resolves({
      id: 'missing-files-bundle',
      name: 'Missing Files Bundle',
      version: '1.0.0',
      description: 'Bundle with missing files',
      author: 'Author',
      sourceId: 'source1',
      environments: [],
      tags: [],
      lastUpdated: new Date().toISOString(),
      size: '1MB',
      dependencies: [],
      license: 'MIT',
      manifestUrl: 'https://example.com/manifest',
      downloadUrl: 'https://example.com/download'
    });

    const installedRoot = new RegistryTreeItem(
      'Installed Bundles',
      TreeItemType.INSTALLED_ROOT,
      undefined,
      vscode.TreeItemCollapsibleState.Expanded
    );

    const items = await provider.getChildren(installedRoot);

    assert.strictEqual(items.length, 1);
    const item = items[0];

    // Should show warning emoji prefix
    assert.ok(item.label.includes('⚠️'), 'Bundle with missing files should show warning emoji');

    // Should have warning tooltip
    assert.ok(
      item.tooltip && typeof item.tooltip === 'string' && item.tooltip.includes('Files missing'),
      'Bundle with missing files should have warning tooltip'
    );

    // Should have warning icon
    assert.ok(item.iconPath, 'Bundle with missing files should have warning icon');
    assert.ok(
      item.iconPath instanceof vscode.ThemeIcon && item.iconPath.id === 'warning',
      'Icon should be warning ThemeIcon'
    );

    // Should have filesMissing context value (with scope suffix for repository bundles)
    assert.ok(
      item.contextValue?.startsWith('installedBundle.filesMissing'),
      `Context value should start with installedBundle.filesMissing, got: ${item.contextValue}`
    );
  });

  test('should NOT show warning indicator for bundle without filesMissing flag', async () => {
    const normalBundle = {
      bundleId: 'normal-bundle',
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      scope: 'repository' as const,
      commitMode: 'commit' as const,
      installPath: '/repo/path',
      manifest: {} as any,
      filesMissing: false
    };

    registryManagerStub.listInstalledBundles.resolves([normalBundle]);
    registryManagerStub.getBundleDetails.withArgs('normal-bundle').resolves({
      id: 'normal-bundle',
      name: 'Normal Bundle',
      version: '1.0.0',
      description: 'Normal bundle',
      author: 'Author',
      sourceId: 'source1',
      environments: [],
      tags: [],
      lastUpdated: new Date().toISOString(),
      size: '1MB',
      dependencies: [],
      license: 'MIT',
      manifestUrl: 'https://example.com/manifest',
      downloadUrl: 'https://example.com/download'
    });

    const installedRoot = new RegistryTreeItem(
      'Installed Bundles',
      TreeItemType.INSTALLED_ROOT,
      undefined,
      vscode.TreeItemCollapsibleState.Expanded
    );

    const items = await provider.getChildren(installedRoot);

    assert.strictEqual(items.length, 1);
    const item = items[0];

    // Should NOT show warning emoji prefix
    assert.ok(!item.label.includes('⚠️'), 'Normal bundle should not show warning emoji');

    // Should have normal context value (not filesMissing)
    assert.ok(
      !item.contextValue?.startsWith('installedBundle.filesMissing'),
      'Normal bundle should not have filesMissing context value'
    );
  });

  test('should show warning indicator when bundle details are not available', async () => {
    const bundleWithMissingFiles = {
      bundleId: 'missing-files-bundle-no-details',
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      scope: 'repository' as const,
      commitMode: 'commit' as const,
      installPath: '/repo/path',
      manifest: {} as any,
      filesMissing: true
    };

    registryManagerStub.listInstalledBundles.resolves([bundleWithMissingFiles]);
    registryManagerStub.getBundleDetails.withArgs('missing-files-bundle-no-details').rejects(new Error('Bundle not found'));

    const installedRoot = new RegistryTreeItem(
      'Installed Bundles',
      TreeItemType.INSTALLED_ROOT,
      undefined,
      vscode.TreeItemCollapsibleState.Expanded
    );

    const items = await provider.getChildren(installedRoot);

    assert.strictEqual(items.length, 1);
    const item = items[0];

    // Should show warning emoji prefix even when details are not available
    assert.ok(item.label.includes('⚠️'), 'Bundle with missing files should show warning emoji even without details');

    // Should have warning tooltip with bundle ID
    assert.ok(
      item.tooltip && typeof item.tooltip === 'string' && item.tooltip.includes('Files missing'),
      'Bundle with missing files should have warning tooltip'
    );

    // Should have filesMissing context value (with scope suffix for repository bundles)
    assert.ok(
      item.contextValue?.startsWith('installedBundle.filesMissing'),
      `Context value should start with installedBundle.filesMissing, got: ${item.contextValue}`
    );
  });

  test('should distinguish between bundles with and without missing files', async () => {
    const bundleWithMissingFiles = {
      bundleId: 'missing-files-bundle',
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      scope: 'repository' as const,
      commitMode: 'commit' as const,
      installPath: '/repo/path',
      manifest: {} as any,
      filesMissing: true
    };

    const normalBundle = {
      bundleId: 'normal-bundle',
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      scope: 'user' as const,
      installPath: '/user/path',
      manifest: {} as any,
      filesMissing: false
    };

    registryManagerStub.listInstalledBundles.resolves([bundleWithMissingFiles, normalBundle]);
    registryManagerStub.getBundleDetails.withArgs('missing-files-bundle').resolves({
      id: 'missing-files-bundle',
      name: 'Missing Files Bundle',
      version: '1.0.0',
      description: 'Bundle with missing files',
      author: 'Author',
      sourceId: 'source1',
      environments: [],
      tags: [],
      lastUpdated: new Date().toISOString(),
      size: '1MB',
      dependencies: [],
      license: 'MIT',
      manifestUrl: 'https://example.com/manifest',
      downloadUrl: 'https://example.com/download'
    });
    registryManagerStub.getBundleDetails.withArgs('normal-bundle').resolves({
      id: 'normal-bundle',
      name: 'Normal Bundle',
      version: '1.0.0',
      description: 'Normal bundle',
      author: 'Author',
      sourceId: 'source1',
      environments: [],
      tags: [],
      lastUpdated: new Date().toISOString(),
      size: '1MB',
      dependencies: [],
      license: 'MIT',
      manifestUrl: 'https://example.com/manifest',
      downloadUrl: 'https://example.com/download'
    });

    const installedRoot = new RegistryTreeItem(
      'Installed Bundles',
      TreeItemType.INSTALLED_ROOT,
      undefined,
      vscode.TreeItemCollapsibleState.Expanded
    );

    const items = await provider.getChildren(installedRoot);

    assert.strictEqual(items.length, 2);

    const missingFilesItem = items.find((i) => i.label.includes('Missing Files Bundle'));
    const normalItem = items.find((i) => i.label.includes('Normal Bundle'));

    assert.ok(missingFilesItem, 'Missing files bundle should be displayed');
    assert.ok(normalItem, 'Normal bundle should be displayed');

    // Missing files bundle should have warning indicator
    assert.ok(missingFilesItem.label.includes('⚠️'), 'Missing files bundle should show warning emoji');
    assert.ok(
      missingFilesItem.contextValue?.startsWith('installedBundle.filesMissing'),
      `Missing files bundle context value should start with installedBundle.filesMissing, got: ${missingFilesItem.contextValue}`
    );

    // Normal bundle should NOT have warning indicator
    assert.ok(!normalItem.label.includes('⚠️'), 'Normal bundle should not show warning emoji');
    assert.ok(
      !normalItem.contextValue?.startsWith('installedBundle.filesMissing'),
      'Normal bundle should not have filesMissing context value'
    );
  });
});

/**
 * Task 6: Rating suffix on tree-view bundle descriptions
 *
 * When a bundle has a cached rating, the tree item's description should be
 * suffixed with ` ★ X.X (N)` so users can see community ratings alongside
 * the version number.
 */
suite('RegistryTreeProvider - Rating Suffix on Descriptions', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
    // Reset RatingCache singleton so each test starts clean
    RatingCache.resetInstance();
  });

  teardown(() => {
    sandbox.restore();
    RatingCache.resetInstance();
  });

  const makeCachedRating = (overrides: Partial<CachedRating> = {}): CachedRating => {
    return {
      sourceId: 'source1',
      bundleId: 'bundle-1',
      starRating: 4.2,
      wilsonScore: 0.8,
      voteCount: 10,
      confidence: 'medium',
      cachedAt: Date.now(),
      ...overrides
    };
  };

  const makeInstalledBundle = (overrides: Partial<InstalledBundle> = {}): InstalledBundle => {
    return {
      bundleId: 'bundle-1',
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      scope: 'user',
      installPath: '/user/path',
      manifest: {} as any,
      sourceId: 'source1',
      ...overrides
    };
  };

  const makeBundle = (overrides: Partial<Bundle> = {}): Bundle => {
    return {
      id: 'bundle-1',
      name: 'Bundle One',
      version: '1.0.0',
      description: 'desc',
      author: 'author',
      sourceId: 'source1',
      environments: [],
      tags: [],
      lastUpdated: new Date().toISOString(),
      size: '1MB',
      dependencies: [],
      license: 'MIT',
      manifestUrl: 'https://example.com/manifest',
      downloadUrl: 'https://example.com/download',
      ...overrides
    };
  };

  test('INSTALLED_BUNDLE description includes star suffix when rating is cached', () => {
    sandbox.stub(RatingCache.getInstance(), 'getRating').returns(
      makeCachedRating({ starRating: 4.2, voteCount: 10 })
    );

    const installed = makeInstalledBundle();
    const item = new RegistryTreeItem(
      'Bundle One',
      TreeItemType.INSTALLED_BUNDLE,
      installed,
      vscode.TreeItemCollapsibleState.None
    );

    assert.ok(typeof item.description === 'string', 'description should be a string');
    const desc = item.description;
    assert.ok(desc.startsWith('v1.0.0'), `description should start with version, got: ${desc}`);
    assert.ok(desc.includes('★ 4.2'), `description should include star rating, got: ${desc}`);
    assert.ok(desc.includes('(10)'), `description should include vote count, got: ${desc}`);
  });

  test('INSTALLED_BUNDLE description has no star suffix when no rating is cached', () => {
    sandbox.stub(RatingCache.getInstance(), 'getRating').returns(undefined);

    const installed = makeInstalledBundle();
    const item = new RegistryTreeItem(
      'Bundle One',
      TreeItemType.INSTALLED_BUNDLE,
      installed,
      vscode.TreeItemCollapsibleState.None
    );

    assert.strictEqual(item.description, 'v1.0.0');
  });

  test('INSTALLED_BUNDLE with undefined sourceId short-circuits to no star suffix', () => {
    const getRatingStub = sandbox.stub(RatingCache.getInstance(), 'getRating').returns(
      makeCachedRating({ starRating: 4.2, voteCount: 10 })
    );

    const installed = makeInstalledBundle({ sourceId: undefined });
    const item = new RegistryTreeItem(
      'Bundle One',
      TreeItemType.INSTALLED_BUNDLE,
      installed,
      vscode.TreeItemCollapsibleState.None
    );

    assert.strictEqual(item.description, 'v1.0.0');
    assert.strictEqual(getRatingStub.called, false, 'getRating should not be called when sourceId is undefined');
  });

  test('INSTALLED_BUNDLE description has no star suffix when cached rating has zero votes', () => {
    sandbox.stub(RatingCache.getInstance(), 'getRating').returns(
      makeCachedRating({ starRating: 0, voteCount: 0 })
    );

    const installed = makeInstalledBundle();
    const item = new RegistryTreeItem(
      'Bundle One',
      TreeItemType.INSTALLED_BUNDLE,
      installed,
      vscode.TreeItemCollapsibleState.None
    );

    assert.strictEqual(item.description, 'v1.0.0');
  });

  test('BUNDLE description includes star suffix when rating is cached', () => {
    sandbox.stub(RatingCache.getInstance(), 'getRating').returns(
      makeCachedRating({ starRating: 4.2, voteCount: 10 })
    );

    const bundle = makeBundle();
    const item = new RegistryTreeItem(
      bundle.name,
      TreeItemType.BUNDLE,
      bundle,
      vscode.TreeItemCollapsibleState.None
    );

    assert.ok(typeof item.description === 'string', 'description should be a string');
    const desc = item.description;
    assert.ok(desc.startsWith('1.0.0'), `description should start with version, got: ${desc}`);
    assert.ok(desc.includes('★ 4.2'), `description should include star rating, got: ${desc}`);
    assert.ok(desc.includes('(10)'), `description should include vote count, got: ${desc}`);
  });

  test('BUNDLE description has no star suffix when no rating is cached', () => {
    sandbox.stub(RatingCache.getInstance(), 'getRating').returns(undefined);

    const bundle = makeBundle();
    const item = new RegistryTreeItem(
      bundle.name,
      TreeItemType.BUNDLE,
      bundle,
      vscode.TreeItemCollapsibleState.None
    );

    assert.strictEqual(item.description, '1.0.0');
  });

  test('getInstalledBundleItems preserves rating suffix after setVersionDisplay overwrite', async () => {
    // Regression: setVersionDisplay used to flat-overwrite treeItem.description with a
    // version-only string, dropping the star suffix produced by RegistryTreeItem's constructor.
    sandbox.stub(RatingCache.getInstance(), 'getRating').returns(
      makeCachedRating({ starRating: 4.2, voteCount: 10 })
    );

    const registryManagerStub = sandbox.createStubInstance(RegistryManager);
    const hubManagerStub = sandbox.createStubInstance(HubManager);
    setupTreeProviderMocks(registryManagerStub, hubManagerStub, sandbox);

    const installed = makeInstalledBundle();
    registryManagerStub.listInstalledBundles.resolves([installed]);
    registryManagerStub.getBundleDetails.withArgs(installed.bundleId).resolves({
      id: installed.bundleId,
      name: 'Bundle One',
      version: '1.0.0',
      description: 'desc',
      author: 'author',
      sourceId: 'source1',
      environments: [],
      tags: [],
      lastUpdated: new Date().toISOString(),
      size: '1MB',
      dependencies: [],
      license: 'MIT',
      manifestUrl: 'https://example.com/manifest',
      downloadUrl: 'https://example.com/download'
    });

    const provider = new RegistryTreeProvider(registryManagerStub, hubManagerStub);

    const installedRoot = new RegistryTreeItem(
      'Installed Bundles',
      TreeItemType.INSTALLED_ROOT,
      undefined,
      vscode.TreeItemCollapsibleState.Expanded
    );

    const items = await provider.getChildren(installedRoot);

    assert.strictEqual(items.length, 1);
    const desc = items[0].description as string;
    assert.strictEqual(desc, 'v1.0.0 ★ 4.2 (10)');
  });
});
