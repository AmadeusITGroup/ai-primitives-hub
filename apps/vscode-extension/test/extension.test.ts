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

  test('waits for the first sync, activates without reloading sources, and tracks completion', async () => {
    let releaseFirstSettled!: () => void;
    const firstSettled = new Promise<void>((resolve) => {
      releaseFirstSettled = resolve;
    });
    let releaseComplete!: () => void;
    const complete = new Promise<void>((resolve) => {
      releaseComplete = resolve;
    });
    let importStarted!: () => void;
    const importStartedPromise = new Promise<void>((resolve) => {
      importStarted = resolve;
    });
    let trackedSourceSync: Promise<void> | undefined;
    const setActiveHubStub = sandbox.stub().resolves();
    const importHubProgressivelyStub = sandbox.stub().callsFake(async () => {
      importStarted();
      return {
        hubId: 'verified-hub',
        onFirstSettled: () => firstSettled,
        onComplete: () => complete
      };
    });
    const showQuickPickStub = sandbox.stub(vscode.window, 'showQuickPick').resolves({
      label: '$(check) Verified Hub',
      hubConfig: {
        name: 'Verified Hub',
        reference: { type: 'github', location: 'owner/verified-hub' }
      }
    } as any);
    const showInformationStub = sandbox.stub(vscode.window, 'showInformationMessage').resolves();
    const verifyHubAvailabilityDetailedStub = sandbox.stub().resolves({ available: true });

    const selectorPromise = runFirstRunHubSelector({
      hubManager: {
        verifyHubAvailabilityDetailed: verifyHubAvailabilityDetailedStub,
        importHubProgressively: importHubProgressivelyStub,
        setActiveHub: setActiveHubStub
      },
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      },
      notifications: {
        showError: sandbox.stub().resolves()
      },
      onInitialSourceSync: (sourceSyncPromise) => {
        trackedSourceSync = sourceSyncPromise;
      }
    });

    await importStartedPromise;
    assert.strictEqual(setActiveHubStub.called, false);

    releaseFirstSettled();
    assert.strictEqual(await selectorPromise, true);
    assert.deepStrictEqual(setActiveHubStub.firstCall.args, [
      'verified-hub',
      { loadSources: false }
    ]);
    assert.strictEqual(showInformationStub.calledOnce, true);
    assert.ok(trackedSourceSync);

    releaseComplete();
    await trackedSourceSync;
    assert.strictEqual(showQuickPickStub.calledOnce, true);
  });

  test('reports a verified-hub import failure and rethrows it', async () => {
    const importError = new Error('hub config unavailable');
    const showQuickPickStub = sandbox.stub(vscode.window, 'showQuickPick').resolves({
      label: '$(check) Verified Hub',
      hubConfig: {
        name: 'Verified Hub',
        reference: { type: 'github', location: 'owner/verified-hub' }
      }
    } as any);
    const showErrorStub = sandbox.stub().resolves();
    const verifyHubAvailabilityDetailedStub = sandbox.stub().resolves({ available: true });
    const importHubProgressivelyStub = sandbox.stub().rejects(importError);

    await assert.rejects(
      runFirstRunHubSelector({
        hubManager: {
          verifyHubAvailabilityDetailed: verifyHubAvailabilityDetailedStub,
          importHubProgressively: importHubProgressivelyStub,
          setActiveHub: sandbox.stub()
        },
        logger: {
          debug: () => undefined,
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined
        },
        notifications: { showError: showErrorStub }
      }),
      /hub config unavailable/
    );

    assert.strictEqual(showQuickPickStub.calledOnce, true);
    assert.match(showErrorStub.firstCall.args[0], /Failed to import Verified Hub/);
  });

  test('returns false when custom hub import is cancelled', async () => {
    sandbox.stub(vscode.window, 'showQuickPick').resolves({
      label: '$(link-external) Custom Hub URL',
      hubConfig: null
    } as any);
    const executeCommandStub = sandbox.stub(vscode.commands, 'executeCommand').resolves(undefined);
    const verifyHubAvailabilityDetailedStub = sandbox.stub().resolves({ available: false });

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
      notifications: { showError: sandbox.stub().resolves() }
    });

    assert.strictEqual(configured, false);
    assert.strictEqual(executeCommandStub.calledOnceWithExactly('promptregistry.importHub'), true);
  });
});
