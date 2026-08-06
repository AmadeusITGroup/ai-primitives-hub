/**
 * DiagnoseGitHubAuthCommand Tests
 *
 * Covers what a user relies on when a bundle install fails with a GitHub
 * 404: the command must name the credential's origin, probe api.github.com
 * for the configured GitHub sources, offer the reset path when the
 * credential cannot reach one, and keep the probe count minimal (one
 * credential check, one request per distinct repository).
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  githubTokenProviderChain,
  sharedHttpClient,
} from '../../src/adapters/infra-adapter-factory';
import {
  DiagnoseGitHubAuthCommand,
  parseRepoLocation,
} from '../../src/commands/diagnose-github-auth-command';
import type {
  RegistryManager,
} from '../../src/services/registry-manager';

interface FakeSource {
  id: string;
  type: string;
  url: string;
}

function fakeRegistryManager(sources: FakeSource[]): RegistryManager {
  return { listSources: async () => sources } as unknown as RegistryManager;
}

function httpResponse(statusCode: number, body: unknown = {}, headers: Record<string, string> = {}): {
  statusCode: number;
  body: Uint8Array;
  finalUrl: string;
  headers: Record<string, string>;
} {
  return {
    statusCode,
    body: new TextEncoder().encode(JSON.stringify(body)),
    finalUrl: 'https://api.github.com/probe',
    headers
  };
}

const OK_USER = httpResponse(200, { login: 'octocat' }, { 'x-oauth-scopes': 'repo' });

suite('DiagnoseGitHubAuthCommand', () => {
  let sandbox: sinon.SinonSandbox;
  let fetchStub: sinon.SinonStub;
  let warningStub: sinon.SinonStub;
  let infoStub: sinon.SinonStub;
  let executeCommandStub: sinon.SinonStub;

  setup(() => {
    sandbox = sinon.createSandbox();
    fetchStub = sandbox.stub(sharedHttpClient, 'fetch');
    warningStub = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
    infoStub = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    executeCommandStub = sandbox.stub(vscode.commands, 'executeCommand').resolves(undefined);
    // No credential from any provider unless a test says otherwise.
    for (const entry of githubTokenProviderChain) {
      sandbox.stub(entry.provider, 'getToken').resolves(undefined);
    }
  });

  teardown(() => {
    sandbox.restore();
  });

  /**
   * Make the first provider in the chain resolve a token.
   * @param token - Token to resolve.
   */
  const withCredential = (token: string): void => {
    (githubTokenProviderChain[0].provider.getToken as sinon.SinonStub).resolves(token);
  };

  /**
   * Route probe responses by URL, so a concurrent probe order can't make
   * the assertions flaky.
   * @param user - Response for `GET /user`.
   * @param repos - Response per `owner/repo`.
   * @param control - Response for the public raw-content control probe;
   * defaults to a healthy public read.
   */
  const respond = (
    user: ReturnType<typeof httpResponse>,
    repos: Record<string, ReturnType<typeof httpResponse>> = {},
    control: ReturnType<typeof httpResponse> = httpResponse(200, {})
  ): void => {
    fetchStub.callsFake(async (request: { url: string }) => {
      if (request.url.startsWith('https://raw.githubusercontent.com/')) {
        return control;
      }
      if (request.url.endsWith('/user')) {
        return user;
      }
      const location = request.url.replace('https://api.github.com/repos/', '');
      return repos[location] ?? httpResponse(404);
    });
  };

  /** URLs the command probed, in call order. */
  const probedUrls = (): string[] => fetchStub.getCalls().map((call) => (call.args[0] as { url: string }).url);

  test('parseRepoLocation extracts owner/repo from GitHub URLs', () => {
    assert.strictEqual(parseRepoLocation('https://github.com/AmadeusITGroup/otter'), 'AmadeusITGroup/otter');
    assert.strictEqual(parseRepoLocation('https://github.com/AmadeusITGroup/otter.git'), 'AmadeusITGroup/otter');
    assert.strictEqual(
      parseRepoLocation('https://raw.githubusercontent.com/AmadeusITGroup/otter/main/collections/accessibility.collection.yml'),
      'AmadeusITGroup/otter'
    );
    assert.strictEqual(parseRepoLocation('https://example.com/some/path'), undefined);
  });

  test('diagnoses only the failing repository when a target URL is supplied', async () => {
    withCredential('gho_valid');
    respond(OK_USER, { 'AmadeusITGroup/otter': httpResponse(200) });

    const command = new DiagnoseGitHubAuthCommand(fakeRegistryManager([
      { id: 's1', type: 'awesome-copilot', url: 'https://github.com/AmadeusITGroup/otter' },
      { id: 's2', type: 'github', url: 'https://github.com/github/awesome-copilot' },
      { id: 's3', type: 'apm', url: 'https://github.com/some/other' }
    ]));
    await command.execute({
      url: 'https://raw.githubusercontent.com/AmadeusITGroup/otter/main/collections/accessibility.collection.yml',
      label: 'accessibility'
    });

    const urls = probedUrls();
    assert.deepStrictEqual(urls.filter((url) => url.startsWith('https://api.github.com/repos/')), ['https://api.github.com/repos/AmadeusITGroup/otter']);
    assert.strictEqual(urls.filter((url) => url.startsWith('https://raw.githubusercontent.com/')).length, 1, 'one public control probe');
    // Access is fine, so the message must point at the file, not the token.
    assert.match(infoStub.firstCall.args[0] as string, /failure was about the requested file/);
  });

  test('blames the credential when public raw content loads anonymously but not with the token', async () => {
    withCredential('gho_rejected_by_raw');
    // api.github.com accepts the token, raw.githubusercontent.com does not.
    respond(OK_USER, { 'AmadeusITGroup/otter': httpResponse(200) }, httpResponse(404));
    fetchStub.callsFake(async (request: { url: string; headers?: Record<string, string> }) => {
      if (request.url.startsWith('https://raw.githubusercontent.com/')) {
        // Authenticated attempt fails; the anonymous control attempt succeeds.
        return request.headers?.Authorization === undefined ? httpResponse(200) : httpResponse(404);
      }
      return request.url.endsWith('/user') ? OK_USER : httpResponse(200);
    });

    const command = new DiagnoseGitHubAuthCommand(fakeRegistryManager([]));
    await command.execute({ url: 'https://raw.githubusercontent.com/AmadeusITGroup/otter/main/collections/a.collection.yml' });

    assert.ok(warningStub.calledOnce, 'should warn about the credential');
    assert.match(warningStub.firstCall.args[0] as string, /rejecting the credential itself/);
  });

  test('skips the control probe when api.github.com already rejected the credential', async () => {
    withCredential('gho_expired');
    respond(httpResponse(401));

    const command = new DiagnoseGitHubAuthCommand(fakeRegistryManager([]));
    await command.execute({ url: 'https://github.com/AmadeusITGroup/otter' });

    assert.deepStrictEqual(probedUrls(), ['https://api.github.com/user']);
    assert.match(warningStub.firstCall.args[0] as string, /rejected the credential/);
  });

  test('reports the missing credential and offers remediation when no provider has one', async () => {
    const command = new DiagnoseGitHubAuthCommand(fakeRegistryManager([]));

    await command.execute();

    assert.ok(warningStub.calledOnce, 'should surface a warning');
    assert.match(warningStub.firstCall.args[0] as string, /No GitHub credential found/);
    assert.strictEqual(fetchStub.callCount, 0, 'should not probe GitHub without a credential');
  });

  test('reports success when the credential can reach every configured source', async () => {
    withCredential('gho_valid');
    respond(OK_USER, { 'AmadeusITGroup/otter': httpResponse(200, { full_name: 'AmadeusITGroup/otter' }) });

    const command = new DiagnoseGitHubAuthCommand(fakeRegistryManager([
      { id: 's1', type: 'awesome-copilot', url: 'https://github.com/AmadeusITGroup/otter' }
    ]));
    await command.execute();

    assert.ok(infoStub.calledOnce, 'should report health');
    assert.match(infoStub.firstCall.args[0] as string, /VS Code GitHub session/);
    assert.ok(warningStub.notCalled, 'should not warn when everything is reachable');
    assert.strictEqual(fetchStub.callCount, 2, 'one credential check + one repo probe');
  });

  test('validates the credential once, no matter how many sources share a repository', async () => {
    withCredential('gho_valid');
    respond(OK_USER, {
      'AmadeusITGroup/otter': httpResponse(200),
      'AmadeusITGroup/prompt-registry': httpResponse(200)
    });

    const command = new DiagnoseGitHubAuthCommand(fakeRegistryManager([
      { id: 's1', type: 'awesome-copilot', url: 'https://github.com/AmadeusITGroup/otter' },
      { id: 's2', type: 'github', url: 'https://github.com/AmadeusITGroup/otter.git' },
      { id: 's3', type: 'skills', url: 'https://github.com/AmadeusITGroup/prompt-registry' }
    ]));
    await command.execute();

    // 3 sources, 2 distinct repositories: /user once, each repo once.
    assert.strictEqual(fetchStub.callCount, 3);
  });

  test('skips repository probes entirely when the credential itself is rejected', async () => {
    withCredential('gho_expired');
    respond(httpResponse(401));

    const command = new DiagnoseGitHubAuthCommand(fakeRegistryManager([
      { id: 's1', type: 'github', url: 'https://github.com/AmadeusITGroup/otter' },
      { id: 's2', type: 'awesome-copilot', url: 'https://github.com/github/awesome-copilot' }
    ]));
    await command.execute();

    assert.strictEqual(fetchStub.callCount, 1, 'repo probes are meaningless once /user returns 401');
    assert.match(warningStub.firstCall.args[0] as string, /rejected the credential/);
  });

  test('names SSO authorization as the cause when the repository probe is SSO-challenged', async () => {
    withCredential('gho_valid');
    respond(OK_USER, {
      'AmadeusITGroup/otter': httpResponse(404, {}, { 'x-github-sso': 'required; url=https://github.com/orgs/AmadeusITGroup/sso' })
    });

    const command = new DiagnoseGitHubAuthCommand(fakeRegistryManager([
      { id: 's1', type: 'awesome-copilot', url: 'https://github.com/AmadeusITGroup/otter' }
    ]));
    await command.execute();

    assert.ok(warningStub.calledOnce, 'should warn');
    assert.match(warningStub.firstCall.args[0] as string, /not SSO-authorized for AmadeusITGroup\/otter/);
  });

  test('runs the force-auth command when the user picks Reset GitHub Token', async () => {
    withCredential('gho_expired');
    respond(httpResponse(401));
    warningStub.resolves('Reset GitHub Token');

    const command = new DiagnoseGitHubAuthCommand(fakeRegistryManager([
      { id: 's1', type: 'github', url: 'https://github.com/AmadeusITGroup/otter' }
    ]));
    await command.execute();

    assert.ok(executeCommandStub.calledWith('promptregistry.forceGitHubAuth'));
  });

  test('ignores local sources, which need no credential', async () => {
    withCredential('gho_valid');
    respond(OK_USER);

    const command = new DiagnoseGitHubAuthCommand(fakeRegistryManager([
      { id: 's1', type: 'local', url: 'file:///tmp/local' },
      { id: 's2', type: 'local-skills', url: 'https://github.com/some/repo' }
    ]));
    await command.execute();

    assert.strictEqual(fetchStub.callCount, 1, 'only the credential check runs');
    assert.ok(infoStub.calledOnce);
  });
});
