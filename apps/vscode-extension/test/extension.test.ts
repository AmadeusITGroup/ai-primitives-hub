import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  runFirstRunHubSelector,
} from '../src/extension';

suite('PromptRegistryExtension first-run hub selector', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  test('shows unavailable reasons and keeps custom and skip choices available', async () => {
    const showQuickPickStub = sandbox.stub(vscode.window, 'showQuickPick').resolves({
      label: '$(x) Skip for now',
      hubConfig: null
    } as any);
    const executeCommandStub = sandbox.stub(vscode.commands, 'executeCommand').resolves();
    const showErrorStub = sandbox.stub().resolves();
    const verifyHubAvailabilityDetailedStub = sandbox.stub().resolves({
      available: false,
      reason: 'connection timed out'
    });

    const configured = await runFirstRunHubSelector({
      hubManager: {
        verifyHubAvailabilityDetailed: verifyHubAvailabilityDetailedStub,
        importHubProgressively: sandbox.stub(),
        setActiveHub: sandbox.stub()
      },
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      },
      notifications: {
        showError: showErrorStub
      }
    });

    assert.strictEqual(configured, false);
    assert.strictEqual(showErrorStub.callCount, 1);
    assert.match(showErrorStub.firstCall.args[0], /github\/awesome-copilot/);
    assert.match(showErrorStub.firstCall.args[0], /connection timed out/);
    assert.strictEqual(executeCommandStub.called, false);

    const items = showQuickPickStub.firstCall.args[0] as { label: string }[];
    assert.ok(items.some((item) => item.label.includes('Custom Hub URL')));
    assert.ok(items.some((item) => item.label.includes('Skip for now')));
    assert.ok(!items.some((item) => item.label.includes('Awesome Copilot Hub')));
  });

  test('does not wait for unavailable-hub notification actions before showing the picker', async () => {
    let releaseNotification!: () => void;
    const notificationShown = new Promise<void>((resolve) => {
      releaseNotification = resolve;
    });
    const showQuickPickStub = sandbox.stub(vscode.window, 'showQuickPick').resolves({
      label: '$(x) Skip for now',
      hubConfig: null
    } as any);
    const showErrorStub = sandbox.stub().returns(notificationShown.then(() => undefined));
    const verifyHubAvailabilityDetailedStub = sandbox.stub().resolves({
      available: false,
      reason: 'offline'
    });

    const configured = await runFirstRunHubSelector({
      hubManager: {
        verifyHubAvailabilityDetailed: verifyHubAvailabilityDetailedStub,
        importHubProgressively: sandbox.stub(),
        setActiveHub: sandbox.stub()
      },
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      },
      notifications: {
        showError: showErrorStub
      }
    });

    assert.strictEqual(configured, false);
    assert.strictEqual(showQuickPickStub.calledOnce, true);
    releaseNotification();
  });
});
