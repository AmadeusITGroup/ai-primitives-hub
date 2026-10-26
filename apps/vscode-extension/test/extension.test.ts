import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  bindPrimitiveIndexLifecycle,
  runFirstRunHubSelector,
  startInitialSourceSync,
} from '../src/extension';

suite('PromptRegistryExtension startup source sync', () => {
  test('does not block activation while an existing hub sync runs', async () => {
    let releaseSync!: () => void;
    const syncPromise = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    let ready = false;

    const startupPromise = startInitialSourceSync({
      checkFirstRun: async () => false,
      syncActiveHub: async () => syncPromise,
      hasInitialSourceSync: () => false,
      markInitialSourceSyncReady: () => {
        ready = true;
      }
    });

    assert.strictEqual(await startupPromise, false);
    assert.strictEqual(ready, false);

    releaseSync();
    await syncPromise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(ready, true);
  });

  test('does not start a second sync or release readiness for a tracked first-run sync', async () => {
    let syncStarted = false;
    let ready = false;

    const initialized = await startInitialSourceSync({
      checkFirstRun: async () => true,
      syncActiveHub: async () => {
        syncStarted = true;
      },
      hasInitialSourceSync: () => true,
      markInitialSourceSyncReady: () => {
        ready = true;
      }
    });

    assert.strictEqual(initialized, true);
    assert.strictEqual(syncStarted, false);
    assert.strictEqual(ready, false);
  });

  test('releases readiness when first-run setup has no source sync to track', async () => {
    let ready = false;

    const initialized = await startInitialSourceSync({
      checkFirstRun: async () => true,
      syncActiveHub: async () => undefined,
      hasInitialSourceSync: () => false,
      markInitialSourceSyncReady: () => {
        ready = true;
      }
    });

    assert.strictEqual(initialized, true);
    assert.strictEqual(ready, true);
  });

  test('releases readiness when an existing-hub sync fails', async () => {
    let ready = false;

    const initialized = await startInitialSourceSync({
      checkFirstRun: async () => false,
      syncActiveHub: async () => {
        throw new Error('remote hub unavailable');
      },
      hasInitialSourceSync: () => false,
      markInitialSourceSyncReady: () => {
        ready = true;
      }
    });

    assert.strictEqual(initialized, false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(ready, true);
  });
});

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
    assert.strictEqual(showErrorStub.callCount, 2);
    const notificationMessages = showErrorStub.getCalls().map((call) => String(call.args[0]));
    assert.ok(notificationMessages.some((message) => /Amadeus-xDLC\/genai\.prompt-registry-config/.test(message)));
    assert.ok(notificationMessages.some((message) => /AmadeusITGroup\/prompt-registry-config/.test(message)));
    notificationMessages.forEach((message) => {
      assert.match(message, /connection timed out/);
    });
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
        onRegistered: () => Promise.resolve(),
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

  test('reports a registration failure before activating the hub', async () => {
    const registrationError = new Error('source registration failed');
    const showQuickPickStub = sandbox.stub(vscode.window, 'showQuickPick').resolves({
      label: '$(check) Verified Hub',
      hubConfig: {
        name: 'Verified Hub',
        reference: { type: 'github', location: 'owner/verified-hub' }
      }
    } as any);
    const showErrorStub = sandbox.stub().resolves();
    const setActiveHubStub = sandbox.stub().resolves();
    const verifyHubAvailabilityDetailedStub = sandbox.stub().resolves({ available: true });
    const importHubProgressivelyStub = sandbox.stub().resolves({
      hubId: 'verified-hub',
      onRegistered: () => Promise.reject(registrationError),
      onFirstSettled: () => Promise.resolve(),
      onComplete: () => Promise.resolve()
    });

    await assert.rejects(
      runFirstRunHubSelector({
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
          showError: showErrorStub
        }
      }),
      registrationError
    );

    assert.strictEqual(setActiveHubStub.called, false);
    assert.strictEqual(showQuickPickStub.calledOnce, true);
    assert.strictEqual(showErrorStub.calledOnce, true);
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

suite('PromptRegistryExtension primitive index lifecycle', () => {
  test('rebuilds only on source lifecycle events and ignores bundle install/uninstall/update events', () => {
    const onSourceAdded = new vscode.EventEmitter<any>();
    const onSourceRemoved = new vscode.EventEmitter<string>();
    const onSourceUpdated = new vscode.EventEmitter<string>();
    const onSourceSynced = new vscode.EventEmitter<any>();
    const onBundleInstalled = new vscode.EventEmitter<any>();
    const onBundleUninstalled = new vscode.EventEmitter<string>();
    const onBundleUpdated = new vscode.EventEmitter<any>();
    const onBundlesInstalled = new vscode.EventEmitter<any[]>();
    const onBundlesUninstalled = new vscode.EventEmitter<string[]>();

    const reasons: string[] = [];
    let ready = true;

    const disposables = bindPrimitiveIndexLifecycle(
      {
        onSourceAdded: onSourceAdded.event,
        onSourceRemoved: onSourceRemoved.event,
        onSourceUpdated: onSourceUpdated.event,
        onSourceSynced: onSourceSynced.event
      },
      (reason) => reasons.push(reason),
      () => ready
    );

    try {
      // Bundle install/uninstall/update events must never trigger index rebuilds
      onBundleInstalled.fire({ bundleId: 'bundle-1' });
      onBundleUninstalled.fire('bundle-1');
      onBundleUpdated.fire({ bundleId: 'bundle-1' });
      onBundlesInstalled.fire([{ bundleId: 'bundle-1' }]);
      onBundlesUninstalled.fire(['bundle-1']);
      assert.deepStrictEqual(reasons, []);

      // Source events trigger index rebuilds when initial sync is ready
      onSourceAdded.fire({ id: 'src-1' });
      onSourceUpdated.fire('src-1');
      onSourceSynced.fire({ sourceId: 'src-1', bundleCount: 5 });
      onSourceRemoved.fire('src-1');
      assert.deepStrictEqual(reasons, [
        'source added',
        'source updated',
        'source synced',
        'source removed'
      ]);

      // Events before initial sync readiness are ignored
      ready = false;
      onSourceAdded.fire({ id: 'src-2' });
      assert.strictEqual(reasons.length, 4);
    } finally {
      disposables.forEach((d) => d.dispose());
      onSourceAdded.dispose();
      onSourceRemoved.dispose();
      onSourceUpdated.dispose();
      onSourceSynced.dispose();
      onBundleInstalled.dispose();
      onBundleUninstalled.dispose();
      onBundleUpdated.dispose();
      onBundlesInstalled.dispose();
      onBundlesUninstalled.dispose();
    }
  });
});
