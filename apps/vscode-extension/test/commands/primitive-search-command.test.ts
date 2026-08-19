import * as assert from 'node:assert';
import type {
  BuildIndexResult,
} from '@ai-primitives-hub/app';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  PrimitiveSearchCommand,
} from '../../src/commands/primitive-search-command';
import type {
  PrimitiveIndexService,
} from '../../src/services/primitive-index-service';

suite('PrimitiveSearchCommand', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  test('shows progress and completion feedback while rebuilding the index', async () => {
    const result: BuildIndexResult = {
      outFile: '/tmp/primitive-index.v2.json',
      primitives: 12,
      bundles: 3,
      report: {
        state: 'ready',
        sourceCoverage: [],
        primitives: 12,
        bundles: 3,
        elapsedMs: 0
      }
    };
    const rebuild = sandbox.stub().resolves(result);
    const indexService = {
      getProfile: () => 'ternlight-dual-v1',
      rebuild
    } as unknown as PrimitiveIndexService;
    const withProgress = sandbox.stub(vscode.window, 'withProgress').callsFake(async (options, task) => {
      assert.strictEqual(options.location, vscode.ProgressLocation.Notification);
      assert.strictEqual(options.title, 'Rebuilding Primitive Index');
      assert.strictEqual(options.cancellable, false);
      return task({ report: sandbox.stub() }, {} as vscode.CancellationToken);
    });
    const showInformationMessage = sandbox.stub(vscode.window, 'showInformationMessage').resolves();

    await new PrimitiveSearchCommand(indexService).rebuild();

    assert.strictEqual(withProgress.callCount, 1);
    assert.strictEqual(rebuild.callCount, 1);
    assert.strictEqual(
      showInformationMessage.firstCall.args[0],
      'Primitive index rebuilt: 12 primitives from 3 bundles.'
    );
  });
});
