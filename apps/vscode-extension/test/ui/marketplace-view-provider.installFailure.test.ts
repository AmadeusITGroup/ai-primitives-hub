/**
 * Marketplace install failures must always reach the user.
 *
 * Regression guard: an earlier attempt at auth diagnostics fired the
 * diagnosis and returned, so `Failed to install bundle: …` was never shown
 * and a failed install could look successful.
 */

import * as assert from 'node:assert';
import {
  RegistryError,
} from '@ai-primitives-hub/core';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  RegistryManager,
} from '../../src/services/registry-manager';
import {
  SetupStateManager,
} from '../../src/services/setup-state-manager';
import {
  MarketplaceViewProvider,
} from '../../src/ui/marketplace-view-provider';

const PROJECT_ROOT = process.cwd();

suite('MarketplaceViewProvider - install failures', () => {
  let sandbox: sinon.SinonSandbox;
  let provider: MarketplaceViewProvider;
  let registryManager: sinon.SinonStubbedInstance<RegistryManager>;
  let showErrorStub: sinon.SinonStub;

  setup(() => {
    sandbox = sinon.createSandbox();
    showErrorStub = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
    sandbox.stub(vscode.commands, 'executeCommand').resolves(undefined);
    // Installing shows a progress notification; run the task inline.
    sandbox.stub(vscode.window, 'withProgress').callsFake(async (_options: unknown, task: unknown) =>
      (task as (progress: unknown, token: unknown) => Promise<unknown>)({ report: () => undefined }, {})
    );

    registryManager = {
      onBundleInstalled: sandbox.stub().returns({ dispose: () => undefined }),
      onBundleUninstalled: sandbox.stub().returns({ dispose: () => undefined }),
      onBundleUpdated: sandbox.stub().returns({ dispose: () => undefined }),
      onBundlesInstalled: sandbox.stub().returns({ dispose: () => undefined }),
      onBundlesUninstalled: sandbox.stub().returns({ dispose: () => undefined }),
      onSourceSynced: sandbox.stub().returns({ dispose: () => undefined }),
      onAutoUpdatePreferenceChanged: sandbox.stub().returns({ dispose: () => undefined }),
      onRepositoryBundlesChanged: sandbox.stub().returns({ dispose: () => undefined }),
      onReadmeDownloaded: sandbox.stub().returns({ dispose: () => undefined }),
      onReadmeDownloadComplete: sandbox.stub().returns({ dispose: () => undefined }),
      searchBundles: sandbox.stub().resolves([]),
      listInstalledBundles: sandbox.stub().resolves([]),
      listSources: sandbox.stub().resolves([]),
      installBundle: sandbox.stub(),
      autoUpdateService: null
    } as never;

    const setupStateManager = {
      getState: sandbox.stub(),
      isComplete: sandbox.stub().returns(true),
      isIncomplete: sandbox.stub().returns(false),
      markComplete: sandbox.stub().resolves()
    } as unknown as sinon.SinonStubbedInstance<SetupStateManager>;

    provider = new MarketplaceViewProvider(
      {
        subscriptions: [],
        extensionUri: vscode.Uri.file(PROJECT_ROOT),
        extensionPath: PROJECT_ROOT,
        extensionMode: 2
      } as never,
      registryManager,
      setupStateManager
    );
  });

  teardown(() => {
    sandbox.restore();
  });

  /**
   * Drive the install path with a chosen scope, so the test exercises the
   * provider's own failure handling rather than the scope dialog.
   * @param error - Failure the install should raise.
   */
  const installFailingWith = async (error: unknown): Promise<void> => {
    registryManager.installBundle.rejects(error as Error);
    const internals = provider as unknown as {
      promptForScope(): Promise<unknown>;
      handleInstall(id: string): Promise<void>;
    };
    sandbox.stub(internals, 'promptForScope').resolves({ scope: 'user', commitMode: undefined });
    await internals.handleInstall('acme.bundle');
  };

  test('reports an auth failure with the message and the auth actions', async () => {
    await installFailingWith(new RegistryError({
      code: 'AUTH.TOKEN_REJECTED',
      message: 'GitHub API error: 404',
      hint: 'GitHub rejected the credential itself (401 on /user)'
    }));

    assert.ok(showErrorStub.called, 'the failure must be shown, not replaced by a diagnostic');
    const [message, ...actions] = showErrorStub.firstCall.args as unknown as [string, ...string[]];
    assert.ok(message.includes('Failed to install bundle:'), message);
    assert.ok(actions.includes('Diagnose'), actions.join(', '));
    assert.ok(actions.includes('Reset GitHub Token'), actions.join(', '));
  });

  test('reports a non-auth failure as a plain error', async () => {
    await installFailingWith(new Error('disk full'));

    const [message, ...actions] = showErrorStub.firstCall.args as unknown as [string, ...string[]];
    assert.ok(message.includes('Failed to install bundle:'), message);
    assert.ok(message.includes('disk full'), message);
    assert.deepStrictEqual(actions, []);
  });
});
