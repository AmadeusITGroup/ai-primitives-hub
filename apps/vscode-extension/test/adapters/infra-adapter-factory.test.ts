/**
 * InfraAdapterFactory Tests
 */

import * as assert from 'node:assert';
import nock from 'nock';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  resetAuthReportingState,
} from '../../src/adapters/auth-event-logger';
import {
  createRegistryAdapter,
} from '../../src/adapters/infra-adapter-factory';
import {
  VsCodeSessionTokenProvider,
} from '../../src/adapters/vscode-session-token-provider';
import {
  RegistrySource,
} from '../../src/types/registry';
import {
  Logger,
} from '../../src/utils/logger';

function makeSource(overrides: Partial<RegistrySource> = {}): RegistrySource {
  return {
    id: 'test-source',
    name: 'Test Source',
    type: 'local',
    url: '/registry',
    enabled: true,
    priority: 0,
    ...overrides
  };
}

suite('createRegistryAdapter', () => {
  let sandbox: sinon.SinonSandbox;
  let getSessionStub: sinon.SinonStub;

  setup(() => {
    sandbox = sinon.createSandbox();
    getSessionStub = sandbox.stub(vscode.authentication, 'getSession').resolves(undefined);
    // Every GitHub-hosted adapter's first call goes through the token-provider
    // chain (reaching VS Code's auth session) before any HTTP request - but
    // still intercept the network so a real request is never attempted
    // regardless of the response the adapter under test happens to need.
    nock('https://api.github.com').persist().get(/.*/).reply(404);
    nock('https://raw.githubusercontent.com').persist().get(/.*/).reply(404);
  });

  teardown(() => {
    sandbox.restore();
    nock.cleanAll();
  });

  const cases: [RegistrySource['type'], string][] = [
    ['local', '/registry'],
    ['local-apm', '/registry'],
    ['local-awesome-copilot', '/registry'],
    ['local-skills', '/registry'],
    ['github', 'https://github.com/owner/repo'],
    ['skills', 'https://github.com/owner/repo'],
    ['awesome-copilot', 'https://github.com/owner/repo'],
    ['apm', 'https://github.com/owner/repo']
  ];

  for (const [type, url] of cases) {
    test(`builds a ${type} adapter with the matching .type`, () => {
      const adapter = createRegistryAdapter(makeSource({ type, url }));
      assert.strictEqual(adapter.type, type);
    });
  }

  test('throws a descriptive error for an unknown source type', () => {
    assert.throws(
      () => createRegistryAdapter(makeSource({ type: 'nonexistent' as never })),
      /No adapter for source type: nonexistent/
    );
  });

  test('requests createIfNone: true for a non-skills GitHub-hosted source', async () => {
    const adapter = createRegistryAdapter(makeSource({ type: 'github', url: 'https://github.com/owner/repo' }));

    // Any fetch triggers the token-provider chain, which reaches VS Code's
    // auth session as the first fallback step.
    await adapter.validate().catch(() => undefined);

    assert.ok(getSessionStub.calledWith('github', ['repo'], { createIfNone: true }));
  });

  test('requests createIfNone: false for a skills source', async () => {
    const adapter = createRegistryAdapter(makeSource({ type: 'skills', url: 'https://github.com/owner/repo' }));

    await adapter.fetchBundles().catch(() => undefined);

    assert.ok(getSessionStub.calledWith('github', ['repo'], { createIfNone: false }));
  });
});

suite('createRegistryAdapter auth observability', () => {
  let sandbox: sinon.SinonSandbox;
  let infoStub: sinon.SinonStub;
  let debugStub: sinon.SinonStub;

  setup(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(vscode.authentication, 'getSession').resolves(undefined);
    const logger = Logger.getInstance();
    infoStub = sandbox.stub(logger, 'info');
    debugStub = sandbox.stub(logger, 'debug');
    // Reporting is deduplicated process-wide, so a prior suite's outcome
    // would otherwise suppress the lines under test here.
    resetAuthReportingState();
    nock('https://api.github.com').persist().get(/.*/).reply(404);
    nock('https://raw.githubusercontent.com').persist().get(/.*/).reply(404);
  });

  teardown(() => {
    sandbox.restore();
    nock.cleanAll();
    VsCodeSessionTokenProvider.clearCache();
    resetAuthReportingState();
  });

  const lines = (stub: sinon.SinonStub): string[] => stub.getCalls().map((call) => String(call.args[0]));
  const authLines = (): string[] => [...lines(infoStub), ...lines(debugStub)].filter((line) => line.startsWith('[Auth]'));

  test('reports the origin that supplied a configured token', async () => {
    const adapter = createRegistryAdapter(makeSource({
      id: 'private-hub',
      type: 'github',
      url: 'https://github.com/owner/repo',
      token: 'ghp_configuredToken'
    }));

    await adapter.validate().catch(() => undefined);

    const resolved = lines(infoStub).filter((line) => line.includes('via=configured-token'));
    assert.ok(resolved.length > 0, 'expected the configured token to be named');
    assert.ok(resolved.every((line) => line.includes('type=ghp_')));
    assert.ok(!resolved.some((line) => line.includes('configuredToken')));
  });

  test('reports one summary line for a resolution, not a running commentary', async () => {
    const adapter = createRegistryAdapter(makeSource({
      id: 'private-hub',
      type: 'github',
      url: 'https://github.com/owner/repo',
      token: 'ghp_configuredToken'
    }));

    await adapter.validate().catch(() => undefined);

    // A validate() drives several requests through the chain; a per-call
    // narration is what flooded the output channel.
    assert.strictEqual(authLines().length, 1, `expected a single line, got:\n${authLines().join('\n')}`);
  });

  test('reports a shared credential once across sources, not once per source', async () => {
    for (const id of ['source-a', 'source-b', 'source-c']) {
      const adapter = createRegistryAdapter(makeSource({
        id,
        type: 'github',
        url: 'https://github.com/owner/repo',
        token: 'ghp_configuredToken'
      }));
      await adapter.validate().catch(() => undefined);
    }

    assert.strictEqual(authLines().length, 1, `expected one line for three sources, got:\n${authLines().join('\n')}`);
  });

  test('omits the source id from a success summary, since the credential is shared', async () => {
    const adapter = createRegistryAdapter(makeSource({
      id: 'private-hub',
      type: 'github',
      url: 'https://github.com/owner/repo',
      token: 'ghp_configuredToken'
    }));

    await adapter.validate().catch(() => undefined);

    assert.ok(authLines()[0].startsWith('[Auth] host='), authLines()[0]);
  });
});
