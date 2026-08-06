/**
 * Targeted GitHub auth diagnosis: it probes only what the caller named,
 * never signs the user in, and treats "no access to a default hub" as
 * information rather than a fault.
 */

import * as assert from 'node:assert';
import {
  getRecommendedHub,
} from '@ai-primitives-hub/infra';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  DiagnoseGitHubAuthCommand,
  parseRepoLocation,
} from '../../src/commands/diagnose-github-auth-command';
import {
  Logger,
} from '../../src/utils/logger';

const EXPECTED_CONTROL_URL = 'https://raw.githubusercontent.com/AmadeusITGroup/prompt-registry-config/main/README.md';
const SESSION_TOKEN = 'gho_session_token_00000000000000009c1e';

interface FakeResponse {
  statusCode: number;
  body?: unknown;
  headers?: Record<string, string>;
}

suite('DiagnoseGitHubAuthCommand', () => {
  let sandbox: sinon.SinonSandbox;
  let getSessionStub: sinon.SinonStub;
  let infoLogs: string[];
  let requestedUrls: string[];
  let responders: ((url: string) => FakeResponse | undefined)[];

  /**
   * Intercept the shared HTTP client the command probes with. The client is
   * a module-level singleton in `infra-adapter-factory`, so stubbing its
   * `fetch` is the external boundary here.
   * @param responder
   */
  const stubHttp = (responder: (url: string) => FakeResponse | undefined): void => {
    responders.push(responder);
  };

  setup(async () => {
    sandbox = sinon.createSandbox();
    infoLogs = [];
    requestedUrls = [];
    responders = [];

    getSessionStub = sandbox.stub(vscode.authentication, 'getSession').resolves({
      accessToken: SESSION_TOKEN,
      account: { id: 'octocat', label: 'octocat' },
      id: 'session-id',
      scopes: ['repo']
    });

    sandbox.stub(Logger.getInstance(), 'info').callsFake((message: string) => {
      infoLogs.push(message);
    });
    sandbox.stub(Logger.getInstance(), 'show');

    const factory = await import('../../src/adapters/infra-adapter-factory');
    sandbox.stub(factory.sharedHttpClient, 'fetch').callsFake(async (request: { url: string }) => {
      requestedUrls.push(request.url);
      for (const responder of responders) {
        const response = responder(request.url);
        if (response !== undefined) {
          return {
            statusCode: response.statusCode,
            body: new TextEncoder().encode(JSON.stringify(response.body ?? {})),
            finalUrl: request.url,
            headers: response.headers ?? {}
          };
        }
      }
      return { statusCode: 404, body: new Uint8Array(), finalUrl: request.url, headers: {} };
    });

    sandbox.stub(vscode.window, 'withProgress').callsFake(async (_options: unknown, task: unknown) =>
      (task as (progress: unknown, token: unknown) => Promise<unknown>)({ report: () => undefined }, {})
    );
  });

  teardown(() => {
    sandbox.restore();
  });

  test('parses owner/repo from both source and raw-content URLs', () => {
    assert.strictEqual(parseRepoLocation('https://github.com/acme/hub.git'), 'acme/hub');
    assert.strictEqual(
      parseRepoLocation('https://raw.githubusercontent.com/acme/hub/main/collections/a.yml'),
      'acme/hub'
    );
    assert.strictEqual(parseRepoLocation('https://example.com/acme/hub'), undefined);
  });

  test('never prompts for a sign-in: read-only diagnostics pass createIfNone false', async () => {
    stubHttp((url) => (url.startsWith('https://api.github.com/user') ? { statusCode: 200, body: { login: 'octocat' } } : undefined));
    sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);

    await new DiagnoseGitHubAuthCommand().execute({ url: 'https://github.com/acme/hub' });

    assert.ok(getSessionStub.called, 'the VS Code session provider should be consulted');
    for (const call of getSessionStub.getCalls()) {
      assert.deepStrictEqual(call.args[2], { createIfNone: false });
    }
  });

  test('logs the credential origin in the headline', async () => {
    stubHttp((url) => (url.startsWith('https://api.github.com/user') ? { statusCode: 200, body: { login: 'octocat' } } : undefined));
    sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);

    await new DiagnoseGitHubAuthCommand().execute({ url: 'https://github.com/acme/hub' });

    const headline = infoLogs.find((line) => line.includes('origin='));
    assert.ok(headline, `expected an origin= line in:\n${infoLogs.join('\n')}`);
    assert.ok(headline.includes('vscode-session(octocat)'), headline);
    assert.ok(!headline.includes(SESSION_TOKEN), 'the token value must never be logged');
  });

  test('detects a credential-level failure from repoStatus being absent', async () => {
    // /user answers 401, so the repo probe never runs and `repoStatus`
    // stays undefined — an explicit fact, not an inference from counts.
    stubHttp((url) => (url.startsWith('https://api.github.com/user') ? { statusCode: 401 } : undefined));
    const showWarning = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);

    await new DiagnoseGitHubAuthCommand().execute({ url: 'https://github.com/acme/hub' });

    const [message] = showWarning.firstCall.args as unknown as [string, ...string[]];
    assert.ok(message.includes('GitHub rejected the credential itself'), message);
    assert.ok(!requestedUrls.some((url) => url.startsWith('https://api.github.com/repos/')));
  });

  test('uses a constant, unambiguously public control URL', async () => {
    stubHttp((url) => {
      if (url.startsWith('https://api.github.com/user')) {
        return { statusCode: 200, body: { login: 'octocat' }, headers: { 'x-oauth-scopes': 'repo' } };
      }
      if (url.startsWith('https://api.github.com/repos/')) {
        return { statusCode: 200 };
      }
      return undefined;
    });
    sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);

    await new DiagnoseGitHubAuthCommand().execute({ url: 'https://github.com/acme/hub' });

    assert.ok(
      requestedUrls.includes(EXPECTED_CONTROL_URL),
      `expected the constant control URL, saw:\n${requestedUrls.join('\n')}`
    );
    // The recommended default hub is private, so it must never be the control.
    const recommended = getRecommendedHub();
    assert.ok(recommended);
    assert.ok(!requestedUrls.some((url) => url.includes(`${recommended.reference.location}/`) && url.endsWith('README.md')));
  });

  test('reports no access to a default hub as information, not a fault', async () => {
    const recommended = getRecommendedHub();
    assert.ok(recommended);
    stubHttp((url) => {
      if (url.startsWith('https://api.github.com/user')) {
        return { statusCode: 200, body: { login: 'octocat' }, headers: { 'x-oauth-scopes': 'repo' } };
      }
      if (url.startsWith('https://api.github.com/repos/')) {
        return { statusCode: 404 };
      }
      return undefined;
    });
    const showInfo = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    const showWarning = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);

    await new DiagnoseGitHubAuthCommand().execute({
      url: `https://github.com/${recommended.reference.location}`
    });

    assert.ok(showWarning.notCalled, 'an expected condition must not warn');
    const [message] = showInfo.firstCall.args as unknown as [string, ...string[]];
    assert.ok(message.includes('is not an error'), message);
    assert.ok(infoLogs.join('\n').includes('Expected for accounts outside the owning organization'));
  });

  test('warns when a non-default repository is inaccessible', async () => {
    stubHttp((url) => {
      if (url.startsWith('https://api.github.com/user')) {
        return { statusCode: 200, body: { login: 'octocat' }, headers: { 'x-oauth-scopes': 'repo' } };
      }
      if (url.startsWith('https://api.github.com/repos/')) {
        return { statusCode: 404 };
      }
      return undefined;
    });
    const showWarning = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
    sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);

    await new DiagnoseGitHubAuthCommand().execute({ url: 'https://github.com/someone/private-hub' });

    const [message] = showWarning.firstCall.args as unknown as [string, ...string[]];
    assert.ok(message.includes('cannot see someone/private-hub'), message);
    assert.ok(message.includes('origin='), message);
  });
});
