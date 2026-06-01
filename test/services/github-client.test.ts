import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  GitHubClient,
} from '../../src/services/github-client';

suite('GitHubClient', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('constructor', () => {
    test('parses HTTPS URL to extract owner and repo', () => {
      const client = new GitHubClient({
        sourceUrl: 'https://github.com/octocat/hello-world'
      });
      assert.strictEqual(client.owner, 'octocat');
      assert.strictEqual(client.repo, 'hello-world');
    });

    test('parses HTTPS URL with .git suffix', () => {
      const client = new GitHubClient({
        sourceUrl: 'https://github.com/octocat/hello-world.git'
      });
      assert.strictEqual(client.owner, 'octocat');
      assert.strictEqual(client.repo, 'hello-world');
    });

    test('parses SSH URL', () => {
      const client = new GitHubClient({
        sourceUrl: 'git@github.com:octocat/hello-world.git'
      });
      assert.strictEqual(client.owner, 'octocat');
      assert.strictEqual(client.repo, 'hello-world');
    });

    test('throws on invalid URL', () => {
      assert.throws(
        () => new GitHubClient({ sourceUrl: 'https://gitlab.com/foo/bar' }),
        /Invalid GitHub URL/
      );
    });

    test('throws on malformed URL', () => {
      assert.throws(
        () => new GitHubClient({ sourceUrl: 'not-a-url' }),
        /Invalid GitHub URL/
      );
    });
  });

  suite('authenticate()', () => {
    test('uses VS Code session as primary auth method', async () => {
      const mockSession = { accessToken: 'vscode-token-12345678' };
      sandbox.stub(vscode.authentication, 'getSession').resolves(mockSession as any);

      const client = new GitHubClient({
        sourceUrl: 'https://github.com/octocat/hello-world',
        explicitToken: 'explicit-token'
      });
      await client.authenticate();

      assert.strictEqual(client.getAuthMethod(), 'vscode');
    });

    test('falls back to explicit token when VS Code auth fails', async () => {
      sandbox.stub(vscode.authentication, 'getSession').rejects(new Error('no session'));

      const client = new GitHubClient({
        sourceUrl: 'https://github.com/octocat/hello-world',
        explicitToken: 'explicit-token-1234'
      });
      await client.authenticate();

      assert.strictEqual(client.getAuthMethod(), 'explicit');
    });

    test('falls back to gh CLI when VS Code and explicit both fail', async () => {
      sandbox.stub(vscode.authentication, 'getSession').rejects(new Error('no session'));

      const client = new GitHubClient({
        sourceUrl: 'https://github.com/octocat/hello-world'
      });

      sandbox.stub(client as any, 'execGhAuthToken').resolves('gh-cli-token-12345678');

      await client.authenticate();

      assert.strictEqual(client.getAuthMethod(), 'gh-cli');
    });

    test('falls back to unauthenticated when all methods fail', async () => {
      sandbox.stub(vscode.authentication, 'getSession').rejects(new Error('no session'));

      const client = new GitHubClient({
        sourceUrl: 'https://github.com/octocat/hello-world'
      });

      sandbox.stub(client as any, 'execGhAuthToken').rejects(new Error('gh not found'));

      await client.authenticate();

      assert.strictEqual(client.getAuthMethod(), 'none');
    });

    test('caches authentication result on subsequent calls', async () => {
      const getSessionStub = sandbox.stub(vscode.authentication, 'getSession')
        .resolves({ accessToken: 'cached-token' } as any);

      const client = new GitHubClient({
        sourceUrl: 'https://github.com/octocat/hello-world'
      });

      await client.authenticate();
      await client.authenticate();

      assert.strictEqual(getSessionStub.callCount, 1);
    });
  });

  suite('getContents()', () => {
    let client: GitHubClient;

    setup(async () => {
      sandbox.stub(vscode.authentication, 'getSession').resolves({ accessToken: 'test-token' } as any);
      client = new GitHubClient({ sourceUrl: 'https://github.com/octocat/hello-world' });
      await client.authenticate();
    });

    test('returns directory contents', async () => {
      const mockResponse = {
        data: [
          { name: 'file1.md', path: 'skills/file1.md', type: 'file', download_url: 'https://raw.github.com/file1.md', sha: 'abc123', size: 100 },
          { name: 'subdir', path: 'skills/subdir', type: 'dir', download_url: null, sha: 'def456', size: 0 }
        ]
      };
      sandbox.stub((client as any).octokit.repos, 'getContent').resolves(mockResponse);

      const result = await client.getContents('skills');

      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].name, 'file1.md');
      assert.strictEqual(result[0].type, 'file');
      assert.strictEqual(result[1].name, 'subdir');
      assert.strictEqual(result[1].type, 'dir');
    });

    test('throws GitHubNotFoundError on 404', async () => {
      const error = new Error('Not Found') as any;
      error.status = 404;
      sandbox.stub((client as any).octokit.repos, 'getContent').rejects(error);

      await assert.rejects(
        () => client.getContents('nonexistent'),
        (err: any) => err.name === 'GitHubNotFoundError'
      );
    });
  });

  suite('listReleases()', () => {
    let client: GitHubClient;

    setup(async () => {
      sandbox.stub(vscode.authentication, 'getSession').resolves({ accessToken: 'test-token' } as any);
      client = new GitHubClient({ sourceUrl: 'https://github.com/octocat/hello-world' });
      await client.authenticate();
    });

    test('returns releases list', async () => {
      const mockReleases = [
        { tag_name: 'v1.0.0', name: 'Release 1.0', body: 'First release', assets: [], published_at: '2026-01-01T00:00:00Z' },
        { tag_name: 'v2.0.0', name: 'Release 2.0', body: 'Second release', assets: [], published_at: '2026-02-01T00:00:00Z' }
      ];
      sandbox.stub((client as any).octokit.repos, 'listReleases').resolves({ data: mockReleases });

      const result = await client.listReleases();

      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].tag_name, 'v1.0.0');
      assert.strictEqual(result[1].tag_name, 'v2.0.0');
    });
  });

  suite('getTree()', () => {
    let client: GitHubClient;

    setup(async () => {
      sandbox.stub(vscode.authentication, 'getSession').resolves({ accessToken: 'test-token' } as any);
      client = new GitHubClient({ sourceUrl: 'https://github.com/octocat/hello-world' });
      await client.authenticate();
    });

    test('returns tree entries recursively', async () => {
      const mockTree = {
        data: {
          tree: [
            { path: 'src/index.ts', type: 'blob', sha: 'abc', size: 200 },
            { path: 'src/utils', type: 'tree', sha: 'def', size: 0 }
          ],
          truncated: false
        }
      };
      sandbox.stub((client as any).octokit.git, 'getTree').resolves(mockTree);

      const result = await client.getTree('main', true);

      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].path, 'src/index.ts');
      assert.strictEqual(result[0].type, 'blob');
    });
  });

  suite('getRepository()', () => {
    let client: GitHubClient;

    setup(async () => {
      sandbox.stub(vscode.authentication, 'getSession').resolves({ accessToken: 'test-token' } as any);
      client = new GitHubClient({ sourceUrl: 'https://github.com/octocat/hello-world' });
      await client.authenticate();
    });

    test('returns repository metadata', async () => {
      sandbox.stub((client as any).octokit.repos, 'get').resolves({
        data: { name: 'hello-world', description: 'A test repo', updated_at: '2026-01-01T00:00:00Z' }
      });

      const result = await client.getRepository();

      assert.strictEqual(result.name, 'hello-world');
      assert.strictEqual(result.description, 'A test repo');
      assert.strictEqual(result.updatedAt, '2026-01-01T00:00:00Z');
    });
  });

  suite('downloadAsset()', () => {
    let client: GitHubClient;

    setup(async () => {
      sandbox.stub(vscode.authentication, 'getSession').resolves({ accessToken: 'test-token' } as any);
      client = new GitHubClient({ sourceUrl: 'https://github.com/octocat/hello-world' });
      await client.authenticate();
    });

    test('downloads a release asset via octokit when URL matches asset pattern', async () => {
      const fakeBuffer = Buffer.from('zip-content');
      sandbox.stub((client as any).octokit.repos, 'getReleaseAsset').resolves({
        data: fakeBuffer
      });

      const result = await client.downloadAsset('https://api.github.com/repos/octocat/hello-world/releases/assets/123');
      assert.ok(Buffer.isBuffer(result));
      assert.strictEqual(result.toString(), 'zip-content');
    });

    test('uses fetchBuffer for non-asset URLs', async () => {
      const fakeBuffer = Buffer.from('raw-content');
      sandbox.stub(client as any, 'fetchBuffer').resolves(fakeBuffer);

      const result = await client.downloadAsset('https://github.com/octocat/hello-world/releases/download/v1.0/bundle.zip');
      assert.ok(Buffer.isBuffer(result));
      assert.strictEqual(result.toString(), 'raw-content');
    });
  });

  suite('downloadAssetsParallel()', () => {
    let client: GitHubClient;

    setup(async () => {
      sandbox.stub(vscode.authentication, 'getSession').resolves({ accessToken: 'test-token' } as any);
      client = new GitHubClient({ sourceUrl: 'https://github.com/octocat/hello-world' });
      await client.authenticate();
    });

    test('downloads multiple assets with concurrency limit', async () => {
      const stub = sandbox.stub(client, 'downloadAsset');
      stub.withArgs('url1').resolves(Buffer.from('content1'));
      stub.withArgs('url2').resolves(Buffer.from('content2'));
      stub.withArgs('url3').resolves(Buffer.from('content3'));

      const result = await client.downloadAssetsParallel(['url1', 'url2', 'url3'], 2);

      assert.strictEqual(result.size, 3);
      assert.strictEqual(result.get('url1')!.toString(), 'content1');
      assert.strictEqual(result.get('url2')!.toString(), 'content2');
      assert.strictEqual(result.get('url3')!.toString(), 'content3');
    });

    test('skips failed downloads without throwing', async () => {
      const stub = sandbox.stub(client, 'downloadAsset');
      stub.withArgs('url1').resolves(Buffer.from('content1'));
      stub.withArgs('url2').rejects(new Error('network error'));

      const result = await client.downloadAssetsParallel(['url1', 'url2'], 5);

      assert.strictEqual(result.size, 1);
      assert.strictEqual(result.get('url1')!.toString(), 'content1');
    });
  });

  suite('downloadRawContent()', () => {
    let client: GitHubClient;

    setup(async () => {
      sandbox.stub(vscode.authentication, 'getSession').resolves({ accessToken: 'test-token' } as any);
      client = new GitHubClient({ sourceUrl: 'https://github.com/octocat/hello-world' });
      await client.authenticate();
    });

    test('downloads raw content from URL', async () => {
      const fakeContent = Buffer.from('# SKILL.md content');
      sandbox.stub(client as any, 'fetchBuffer').resolves(fakeContent);

      const result = await client.downloadRawContent('https://raw.githubusercontent.com/owner/repo/main/file.md');

      assert.ok(Buffer.isBuffer(result));
      assert.strictEqual(result.toString(), '# SKILL.md content');
    });
  });
});
