import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  showUnavailableHubNotifications,
} from '../src/extension';

suite('PromptRegistryExtension first-run hub notifications', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  test('shows one error notification for each unavailable hub', () => {
    const showErrorMessageStub = sandbox.stub(vscode.window, 'showErrorMessage').resolves();

    showUnavailableHubNotifications([
      {
        reference: {
          type: 'github',
          location: 'Amadeus-xDLC/genai.prompt-registry-config'
        },
        reason: 'connection timed out'
      },
      {
        reference: {
          type: 'github',
          location: 'AmadeusITGroup/prompt-registry-config'
        },
        reason: 'connection timed out'
      }
    ]);

    assert.strictEqual(showErrorMessageStub.callCount, 2);
    assert.match(showErrorMessageStub.firstCall.args[0], /Amadeus-xDLC\/genai\.prompt-registry-config/);
    assert.match(showErrorMessageStub.secondCall.args[0], /AmadeusITGroup\/prompt-registry-config/);
    assert.match(showErrorMessageStub.firstCall.args[0], /connection timed out/);
    assert.match(showErrorMessageStub.secondCall.args[0], /connection timed out/);
  });
});
