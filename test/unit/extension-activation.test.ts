import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  PromptRegistryExtension,
} from '../../src/extension';
import {
  ApmRuntimeManager,
} from '../../src/services/apm-runtime-manager';
import {
  ExtensionNotifications,
} from '../../src/notifications/extension-notifications';
import {
  RegistryManager,
} from '../../src/services/registry-manager';
import {
  StatusBar,
} from '../../src/ui/status-bar';
import {
  Logger,
} from '../../src/utils/logger';
import {
  McpConfigLocator,
} from '../../src/utils/mcp-config-locator';

suite('PromptRegistryExtension activation', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  test('registers commands even if registry initialization fails', async () => {
    const mockLogger = {
      info: sandbox.stub(),
      warn: sandbox.stub(),
      error: sandbox.stub(),
      debug: sandbox.stub(),
      show: sandbox.stub()
    } as any;
    const mockStatusBar = {} as any;
    const mockNotifications = {
      showError: sandbox.stub().resolves(undefined)
    } as any;
    const mockRegistryManager = {
      initialize: sandbox.stub().rejects(new Error('init failed'))
    } as any;
    const mockRuntimeManager = {
      initialize: sandbox.stub()
    } as any;
    const mockContext = {
      globalState: {
        get: sandbox.stub(),
        update: sandbox.stub().resolves()
      },
      workspaceState: {
        get: sandbox.stub(),
        update: sandbox.stub().resolves()
      },
      subscriptions: [],
      extensionPath: '/mock/extension',
      extensionMode: 3,
      globalStorageUri: vscode.Uri.file('/mock/global-storage')
    } as unknown as vscode.ExtensionContext;

    sandbox.stub(Logger, 'getInstance').returns(mockLogger);
    sandbox.stub(StatusBar, 'getInstance').returns(mockStatusBar);
    sandbox.stub(ExtensionNotifications, 'getInstance').returns(mockNotifications);
    sandbox.stub(RegistryManager, 'getInstance').returns(mockRegistryManager);
    sandbox.stub(ApmRuntimeManager, 'getInstance').returns(mockRuntimeManager);
    sandbox.stub(McpConfigLocator, 'initialize');

    const extension = new PromptRegistryExtension(mockContext);
    const registerCommandsStub = sandbox.stub(extension as any, 'registerCommands');

    await extension.activate();

    assert.strictEqual(registerCommandsStub.calledOnce, true, 'Commands should be registered before initialization can fail');
  });
});