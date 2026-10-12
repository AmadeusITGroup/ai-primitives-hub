/**
 * InfraAdapterFactory Tests
 */

import * as assert from 'node:assert';
import nock from 'nock';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  createRegistryAdapter,
  SourceVaultCredentialProvider,
} from '../../src/adapters/infra-adapter-factory';
import {
  SourceTokenVault,
} from '../../src/services/source-token-vault';
import {
  RegistrySource,
} from '../../src/types/registry';

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
    ['apm', 'https://github.com/owner/repo'],
    ['artifactory', 'https://artifactory.example/repository/']
  ];

  for (const [type, url] of cases) {
    test(`builds a ${type} adapter with the matching .type`, () => {
      const adapter = createRegistryAdapter(makeSource({ type, url }));
      assert.strictEqual(adapter.type, type);
    });
  }

  test('uses source-scoped Bearer credentials for Artifactory only within the source root', async () => {
    const secrets = new Map<string, string>([[SourceTokenVault.key('test-source'), 'artifactory-secret']]);
    const vault = new SourceTokenVault({
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => {
        secrets.set(key, value);
      },
      delete: async (key: string) => {
        secrets.delete(key);
      }
    } as any);
    const source = makeSource({ type: 'artifactory', url: 'https://artifactory.example/repository' });
    const provider = new SourceVaultCredentialProvider(vault, source);
    const context = { sourceId: 'https://artifactory.example/repository/', trustedOrigin: 'https://artifactory.example', trustedPathPrefix: '/repository/' };

    assert.deepStrictEqual(await provider.headersFor(`${source.url}/index.json`, context), { Authorization: 'Bearer artifactory-secret' });
    await assert.rejects(provider.headersFor('https://artifactory.example/other/index.json', context));
  });

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
