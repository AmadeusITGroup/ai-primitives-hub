import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  HubCommands,
} from '../../src/commands/hub-commands';
import {
  HubConfig,
} from '../../src/types/hub';
import {
  generateHubSourceId,
} from '../../src/utils/source-id-utils';

// Mock RegistryManager
class MockRegistryManager {
  public sources: any[] = [];
  public profiles: any[] = [];

  public listSources() {
    return this.sources;
  }

  public addSource(source: any) {
    this.sources.push(source);
  }

  public createProfile(profile: any) {
    this.profiles.push(profile);
  }

  public listProfiles() {
    return this.profiles;
  }
}

// Mock HubManager
class MockHubManager {
  private readonly hubConfig: HubConfig;
  private readonly registryManager: any;
  private resolveProgressiveImportStarted!: () => void;
  public readonly progressiveImportStarted = new Promise<void>((resolve) => {
    this.resolveProgressiveImportStarted = resolve;
  });

  public onRegisteredPromise: Promise<void> = Promise.resolve();
  public onCompletePromise: Promise<void> = Promise.resolve();
  public onActiveHubPromise: Promise<void> = Promise.resolve();
  public completeStarted = false;
  public readonly setActiveHubCalls: { hubId: string; options?: { loadSources?: boolean } }[] = [];
  public readonly progressiveImportReferences: any[] = [];
  public hubs: any[] = [];
  public activeHub: any = null;

  constructor(config: HubConfig, registryManager?: any) {
    this.hubConfig = config;
    this.registryManager = registryManager;
  }

  public async importHub(reference: any, hubId?: string) {
    // Simulate loadHubSources behavior - add sources with new format IDs
    if (this.registryManager && this.hubConfig.sources) {
      for (const source of this.hubConfig.sources) {
        // Use new sourceId format: {type}-{12-char-hash}
        const sourceId = generateHubSourceId(source.type, source.url);
        const existingSources = await this.registryManager.listSources();
        const exists = existingSources.some((s: any) => s.id === sourceId);
        if (!exists) {
          await this.registryManager.addSource({
            ...source,
            id: sourceId,
            hubId: hubId || 'test-hub-id'
          });
        }
      }
    }
    return 'test-hub-id';
  }

  public async importHubProgressively(reference: any, hubId?: string) {
    this.progressiveImportReferences.push(reference);
    this.resolveProgressiveImportStarted();
    const importedHubId = await this.importHub(reference, hubId);
    return {
      hubId: importedHubId,
      onRegistered: async () => this.onRegisteredPromise,
      onFirstSettled: async () => {},
      onComplete: async () => {
        this.completeStarted = true;
        return this.onCompletePromise;
      }
    };
  }

  public loadHub(_hubId: string) {
    return {
      config: this.hubConfig,
      reference: { type: 'local', location: '/tmp/hub-config.yml' }
    };
  }

  public listHubs() {
    return this.hubs;
  }

  public async getActiveHub() {
    return this.activeHub;
  }

  public async getActiveHubId() {
    return this.activeHub?.id ?? null;
  }

  public verifyHubAvailabilityDetailed(_reference: any) {
    return Promise.resolve({ available: true, reason: undefined });
  }

  public async getHubInfo(hubId: string) {
    const hub = this.hubs.find((item: any) => item.id === hubId);
    return {
      config: {
        metadata: {
          name: hub?.name ?? hubId
        }
      }
    };
  }

  public async deleteHub(hubId: string) {
    this.hubs = this.hubs.filter((hub: any) => hub.id !== hubId);
  }

  public async setActiveHub(hubId: string, options?: { loadSources?: boolean }) {
    await this.onActiveHubPromise;
    this.setActiveHubCalls.push({ hubId, options });
  }
}

suite('HubCommands Source Sync', () => {
  let commands: HubCommands;
  let mockHubManager: any;
  let mockRegistryManager: any;
  let context: vscode.ExtensionContext;
  let showQuickPickStub: sinon.SinonStub;
  let showOpenDialogStub: sinon.SinonStub;
  let showInputBoxStub: sinon.SinonStub;
  let withProgressStub: sinon.SinonStub;
  let showWarningMessageStub: sinon.SinonStub;
  let executeCommandStub: sinon.SinonStub;
  let initialSourceSyncPromise: Promise<void> | undefined;

  setup(() => {
    initialSourceSyncPromise = undefined;

    // Stub vscode.window methods
    showQuickPickStub = sinon.stub(vscode.window, 'showQuickPick');
    showOpenDialogStub = sinon.stub(vscode.window, 'showOpenDialog');
    showInputBoxStub = sinon.stub(vscode.window, 'showInputBox');
    withProgressStub = sinon.stub(vscode.window, 'withProgress');
    showWarningMessageStub = sinon.stub(vscode.window, 'showWarningMessage');
    executeCommandStub = sinon.stub(vscode.commands, 'executeCommand').resolves();
    // We don't use showInformationMessage in this test suite directly but good to stub
    sinon.stub(vscode.window, 'showInformationMessage');

    // Setup successful progress execution
    withProgressStub.callsFake(async (options, task) => {
      const progress = { report: sinon.stub() };
      return await task(progress);
    });

    const hubConfig: HubConfig = {
      version: '1.0.0',
      metadata: {
        name: 'Test Hub',
        description: 'Test Description',
        maintainer: 'Test Maintainer',
        updatedAt: new Date().toISOString()
      },
      sources: [
        {
          id: 'source-1',
          name: 'Source 1',
          type: 'github',
          url: 'https://github.com/owner/repo1',
          enabled: true,
          priority: 1
        },
        {
          id: 'source-2',
          name: 'Source 2',
          type: 'awesome-copilot',
          url: 'https://example.com/source2',
          enabled: true,
          priority: 2
        }
      ],
      profiles: [
        {
          id: 'profile-1',
          name: 'Profile 1',
          description: 'Test Profile',
          icon: 'icon',
          bundles: [],
          active: false,
          createdAt: '',
          updatedAt: ''
        }
      ]
    };

    mockRegistryManager = new MockRegistryManager();
    mockHubManager = new MockHubManager(hubConfig, mockRegistryManager);

    context = {
      subscriptions: [],
      globalState: {
        get: () => undefined,
        update: async () => {}
      }
    } as any;

    commands = new HubCommands(
      mockHubManager,
      mockRegistryManager,
      context,
      (sourceSyncPromise) => {
        initialSourceSyncPromise = sourceSyncPromise;
      }
    );
  });

  teardown(() => {
    sinon.restore();
  });

  test('should sync sources when importing a hub', async () => {
    // Mock user input to select 'local' and provide a file
    showQuickPickStub.resolves({ value: 'local' });
    showOpenDialogStub.resolves([vscode.Uri.file('/tmp/hub-config.yml')]);
    showInputBoxStub.resolves('test-hub-id'); // Hub ID

    const result = await commands.importHub();

    assert.strictEqual(result, 'test-hub-id', 'Import should succeed and return ID');
    sinon.assert.calledWith(executeCommandStub, 'promptRegistry.refresh');

    // Verify sources were added to registry (now with new format IDs from HubManager.loadHubSources)
    assert.strictEqual(mockRegistryManager.sources.length, 2, 'Should have added 2 sources');

    // Compute expected sourceIds using the new format
    const expectedSource1Id = generateHubSourceId('github', 'https://github.com/owner/repo1');
    const expectedSource2Id = generateHubSourceId('awesome-copilot', 'https://example.com/source2');

    // Sources now have new format IDs: {type}-{12-char-hash}
    const source1 = mockRegistryManager.sources.find((s: any) => s.id === expectedSource1Id);
    assert.ok(source1, `Source 1 should be present with new format ID: ${expectedSource1Id}`);
    assert.strictEqual(source1.hubId, 'test-hub-id', 'Source should have hubId injected');

    const source2 = mockRegistryManager.sources.find((s: any) => s.id === expectedSource2Id);
    assert.ok(source2, `Source 2 should be present with new format ID: ${expectedSource2Id}`);
    assert.strictEqual(source2.hubId, 'test-hub-id', 'Source should have hubId injected');
  });

  test('waits for registration and tracks background sync before activating the hub', async () => {
    let releaseRegistration!: () => void;
    mockHubManager.onRegisteredPromise = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    let rejectCompletion!: (error: Error) => void;
    mockHubManager.onCompletePromise = new Promise<void>((_resolve, reject) => {
      rejectCompletion = reject;
    });
    let releaseActiveHub!: () => void;
    mockHubManager.onActiveHubPromise = new Promise<void>((resolve) => {
      releaseActiveHub = resolve;
    });

    showQuickPickStub.resolves({ value: 'local' });
    showOpenDialogStub.resolves([vscode.Uri.file('/tmp/hub-config.yml')]);
    showInputBoxStub.resolves('test-hub-id');

    const importPromise = commands.importHub();
    await mockHubManager.progressiveImportStarted;

    assert.strictEqual(mockHubManager.setActiveHubCalls.length, 0);

    releaseRegistration();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(initialSourceSyncPromise, undefined);

    releaseActiveHub();
    assert.strictEqual(await importPromise, 'test-hub-id');
    assert.deepStrictEqual(mockHubManager.setActiveHubCalls, [
      { hubId: 'test-hub-id', options: { loadSources: false } }
    ]);
    assert.strictEqual(mockHubManager.completeStarted, true);
    const trackedSourceSyncPromise = initialSourceSyncPromise;
    if (!trackedSourceSyncPromise) {
      throw new Error('Expected initial source sync promise to be tracked');
    }

    rejectCompletion(new Error('sync failed'));
    return trackedSourceSyncPromise;
  });

  test('should skip existing sources when importing a hub', async () => {
    // Compute expected sourceIds using the new format
    const expectedSource1Id = generateHubSourceId('github', 'https://github.com/owner/repo1');
    const expectedSource2Id = generateHubSourceId('awesome-copilot', 'https://example.com/source2');

    // Pre-populate registry with one source (with new format ID as HubManager would create)
    mockRegistryManager.sources.push({
      id: expectedSource1Id,
      name: 'Existing Source 1',
      type: 'github',
      url: 'https://github.com/owner/repo1',
      enabled: true,
      priority: 1,
      hubId: 'test-hub-id'
    });

    // Mock user input
    showQuickPickStub.resolves({ value: 'local' });
    showOpenDialogStub.resolves([vscode.Uri.file('/tmp/hub-config.yml')]);
    showInputBoxStub.resolves('test-hub-id');

    await commands.importHub();

    // Verify total sources (1 existing + 1 new = 2)
    assert.strictEqual(mockRegistryManager.sources.length, 2, 'Should have 2 sources total');

    // Verify source-2 was added with new format ID
    const source2 = mockRegistryManager.sources.find((s: any) => s.id === expectedSource2Id);
    assert.ok(source2, `Source 2 should be added with new format ID: ${expectedSource2Id}`);
  });

  test('should not create local profile copies when importing a hub', async () => {
    // Mock user input
    showQuickPickStub.resolves({ value: 'local' });
    showOpenDialogStub.resolves([vscode.Uri.file('/tmp/hub-config.yml')]);
    showInputBoxStub.resolves('test-hub-id');

    await commands.importHub();

    // Verify profiles were added to registry
    assert.strictEqual(mockRegistryManager.profiles.length, 0, 'Should not create local profile copies');
  });

  test('imports and activates a default hub from switch hub options', async () => {
    showQuickPickStub.callsFake((items: any[]) => {
      const defaultHubItem = items.find((item) => item.action === 'importDefault');
      return Promise.resolve(defaultHubItem);
    });

    await commands.switchHub();

    assert.strictEqual(mockHubManager.progressiveImportReferences.length, 1, 'should import a default hub');
    assert.strictEqual(
      mockHubManager.progressiveImportReferences[0].type,
      'github',
      'default hub import should pass a GitHub reference'
    );
    assert.deepStrictEqual(mockHubManager.setActiveHubCalls, [
      { hubId: 'test-hub-id', options: { loadSources: false } }
    ]);
    sinon.assert.calledWith(executeCommandStub, 'promptRegistry.refresh');
  });

  test('allows selecting the same default hub when already active without re-importing', async () => {
    mockHubManager.hubs = [
      {
        id: 'amadeus-hub-id',
        name: 'Amadeus',
        description: 'Profiles curated by Amadeus',
        reference: {
          type: 'github',
          location: 'Amadeus-xDLC/genai.prompt-registry-config',
          ref: 'main'
        }
      }
    ];
    mockHubManager.activeHub = { id: 'amadeus-hub-id', config: { metadata: { name: 'Amadeus' } } };

    showQuickPickStub.callsFake((items: any[]) => {
      const defaultHubItem = items.find((item) => item.action === 'importDefault');
      assert.ok(
        defaultHubItem?.description?.includes('[Active]'),
        'active default hub should have [Active] marker in description'
      );
      return Promise.resolve(defaultHubItem);
    });

    await commands.switchHub();

    assert.strictEqual(
      mockHubManager.progressiveImportReferences.length,
      0,
      'active default hub should not be re-imported'
    );
    assert.deepStrictEqual(mockHubManager.setActiveHubCalls, []);
    sinon.assert.called(showWarningMessageStub);
  });

  test('prefers the active imported default hub when multiple hubs share its reference', async () => {
    const reference = {
      type: 'github',
      location: 'Amadeus-xDLC/genai.prompt-registry-config'
    };
    mockHubManager.hubs = [
      { id: 'inactive-default', name: 'Inactive Default', reference },
      { id: 'active-default', name: 'Active Default', reference: { ...reference, ref: 'main' } }
    ];
    mockHubManager.activeHub = { id: 'active-default' };

    let selectedHub: any;
    showQuickPickStub.callsFake((items: any[]) => {
      selectedHub = items.find((item) => item.defaultHubConfig?.reference.location === reference.location);
      return Promise.resolve(selectedHub);
    });

    await commands.switchHub();

    assert.strictEqual(selectedHub?.hubId, 'active-default');
    assert.ok(selectedHub.description.includes('[Active]'));
    assert.deepStrictEqual(mockHubManager.setActiveHubCalls, []);
    assert.deepStrictEqual(mockHubManager.progressiveImportReferences, []);
    sinon.assert.calledWith(showWarningMessageStub, 'This hub is already active. Please select a different hub.');
    sinon.assert.notCalled(executeCommandStub);
  });

  test('reuses an inactive imported default hub without importing it again', async () => {
    mockHubManager.hubs = [{
      id: 'existing-default',
      name: 'Existing Default',
      reference: { type: 'github', location: 'Amadeus-xDLC/genai.prompt-registry-config', ref: 'main' }
    }];
    mockHubManager.activeHub = { id: 'other-hub' };
    showQuickPickStub.callsFake((items: any[]) => Promise.resolve(
      items.find((item) => item.hubId === 'existing-default')
    ));

    await commands.switchHub();

    assert.deepStrictEqual(mockHubManager.setActiveHubCalls, [{ hubId: 'existing-default', options: undefined }]);
    assert.deepStrictEqual(mockHubManager.progressiveImportReferences, []);
    sinon.assert.notCalled(showWarningMessageStub);
    sinon.assert.calledWith(executeCommandStub, 'promptRegistry.refresh');
  });

  test('shows default hubs, import option, and all imported custom hubs', async () => {
    mockHubManager.hubs = [
      {
        id: 'custom-hub-id',
        name: 'My Custom Hub',
        description: 'Custom',
        reference: {
          type: 'github',
          location: 'example/custom-hub',
          ref: 'main'
        }
      },
      {
        id: 'inactive-custom-hub-id',
        name: 'Inactive Custom Hub',
        description: 'Another custom hub',
        reference: { type: 'github', location: 'example/other-hub', ref: 'main' }
      }
    ];
    mockHubManager.activeHub = { id: 'custom-hub-id', config: { metadata: { name: 'My Custom Hub' } } };

    let labels: string[] = [];
    showQuickPickStub.callsFake((items: any[]) => {
      labels = items.map((item: any) => item.label);
      return Promise.resolve(undefined);
    });

    await commands.switchHub();

    assert.ok(labels.some((label) => label.includes('Amadeus')));
    assert.ok(labels.some((label) => label.includes('Prompt Registry Community Hub')));
    assert.ok(labels.some((label) => label.includes('Import New Hub')));
    assert.ok(labels.some((label) => label.includes('My Custom Hub')));
    assert.ok(labels.some((label) => label.includes('Inactive Custom Hub')));
  });

  test('allows switching to an inactive imported custom hub', async () => {
    mockHubManager.hubs = [
      { id: 'active-custom', name: 'Active Custom', reference: { type: 'local', location: '/tmp/active.yml' } },
      { id: 'inactive-custom', name: 'Inactive Custom', reference: { type: 'local', location: '/tmp/inactive.yml' } }
    ];
    mockHubManager.activeHub = { id: 'active-custom' };
    let selectedHub: any;
    showQuickPickStub.callsFake((items: any[]) => {
      selectedHub = items.find((item) => item.hubId === 'inactive-custom');
      return Promise.resolve(selectedHub);
    });

    await commands.switchHub();

    assert.ok(selectedHub, 'inactive custom hub should be selectable');
    assert.ok(!selectedHub.description?.includes('Active'), 'inactive hub must not be marked active');
    assert.deepStrictEqual(mockHubManager.setActiveHubCalls, [{ hubId: 'inactive-custom', options: undefined }]);
    sinon.assert.notCalled(showWarningMessageStub);
    sinon.assert.calledWith(executeCommandStub, 'promptRegistry.refresh');
  });

  test('warns only when selecting the active imported custom hub', async () => {
    mockHubManager.hubs = [{
      id: 'active-custom', name: 'Active Custom', reference: { type: 'local', location: '/tmp/active.yml' }
    }];
    mockHubManager.activeHub = { id: 'active-custom' };
    showQuickPickStub.callsFake((items: any[]) => Promise.resolve(
      items.find((item) => item.hubId === 'active-custom')
    ));

    await commands.switchHub();

    assert.deepStrictEqual(mockHubManager.setActiveHubCalls, []);
    sinon.assert.calledWith(showWarningMessageStub, 'This hub is already active. Please select a different hub.');
    sinon.assert.notCalled(executeCommandStub);
  });

  test('activates a hub directly from tree item context action', async () => {
    mockHubManager.activeHub = { id: 'hub-1' };

    const hubTreeItem = {
      data: {
        id: 'hub-2'
      }
    };

    await commands.activateHub(hubTreeItem);

    assert.deepStrictEqual(mockHubManager.setActiveHubCalls, [
      { hubId: 'hub-2', options: undefined }
    ]);
    sinon.assert.calledWith(executeCommandStub, 'promptRegistry.refresh');
  });

  test('deleting an active hub does not require manual switch flow', async () => {
    mockHubManager.hubs = [
      {
        id: 'hub-1',
        name: 'Hub One',
        description: 'First',
        reference: { type: 'github', location: 'owner/repo1', ref: 'main' }
      },
      {
        id: 'hub-2',
        name: 'Hub Two',
        description: 'Second',
        reference: { type: 'github', location: 'owner/repo2', ref: 'main' }
      }
    ];
    mockHubManager.activeHub = { id: 'hub-1', config: { metadata: { name: 'Hub One' } } };

    showWarningMessageStub.resolves('Delete');

    const switchHubStub = sinon.stub(commands, 'switchHub').resolves();

    await commands.deleteHub({ data: { id: 'hub-1' } });

    sinon.assert.notCalled(switchHubStub);
    sinon.assert.calledWith(executeCommandStub, 'promptRegistry.refresh');
  });
});
