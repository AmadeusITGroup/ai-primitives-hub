/** Public command tests: real files, mocked HTTP boundary, no live source access. */
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
} from '@ai-primitives-hub/core';
import {
  NodeFileSystem,
} from '@ai-primitives-hub/infra';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  CollectionValidateCommand,
} from '../../src/commands/collection-validate';
import {
  HubValidateCommand,
} from '../../src/commands/hub';
import {
  createTestContext,
  runCli,
} from '../../src/framework';

describe('COL002 and COL004 through existing commands', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'source-check-commands-'));
    await mkdir(path.join(root, 'collections'));
    await writeFile(path.join(root, 'test.prompt.md'), 'Test prompt');
    await writeFile(path.join(root, 'collections/test.collection.yml'), 'id: shared\nname: Shared\nauthor: Test\nitems:\n  - path: test.prompt.md\n    kind: prompt\n');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const run = async (args: string[], http: HttpClient) => {
    const ctx = createTestContext({ cwd: root, fs: new NodeFileSystem(), env: {} });
    const exitCode = await runCli(args, {
      ctx, name: 'ai-primitives-hub', version: 'test', commands: [],
      commandClasses: [CollectionValidateCommand, HubValidateCommand], http,
      tokens: { getToken: async () => undefined }
    });
    return { exitCode, data: JSON.parse(ctx.stdout.captured()).data };
  };

  const httpFixture = (published = true, statusCode = 200) => {
    const fetch = vi.fn(async (request: HttpRequest): Promise<HttpResponse> => {
      const target = new URL(request.url);
      const repo = target.pathname.split('/')[3];
      let body: string;
      if (statusCode !== 200) {
        body = 'private-error-marker';
      } else if (target.pathname.endsWith('/releases')) {
        body = JSON.stringify(published
          ? [{
            tag_name: 'v1.0.0', draft: false, prerelease: false, published_at: '2026-10-13T00:00:00Z', assets: [
              { name: 'deployment-manifest.yml', url: `https://api.github.com/repos/owner/${repo}/releases/assets/1` },
              { name: 'bundle.zip', url: `https://api.github.com/repos/owner/${repo}/releases/assets/2` }
            ]
          }]
          : []);
      } else if (target.pathname.endsWith('/releases/assets/1')) {
        body = 'id: shared\nversion: 1.0.0\n';
      } else {
        throw new Error(`Unexpected test HTTP request: ${target.pathname}`);
      }
      return { statusCode, body: Buffer.from(body), finalUrl: request.url, headers: {} };
    });
    return { fetch };
  };

  const writeHub = async () => {
    await writeFile(path.join(root, 'hub-config.yml'), `version: 1.0.0
metadata:
  name: Test
  description: Test hub
  maintainer: Test
  updatedAt: '2026-10-13T00:00:00Z'
sources:
  - id: first
    type: github
    url: https://github.com/owner/first
    enabled: true
    priority: 1
  - id: second
    type: github
    url: https://github.com/owner/second
    enabled: true
    priority: 1
profiles: []
`);
  };

  it('checks publication through the existing collection command without requiring --governance', async () => {
    const http = httpFixture();
    const result = await run(['collection', 'validate', '--check-releases', '--repository', 'owner/repo', '-o', 'json'], http);
    expect(result).toMatchObject({ exitCode: 0, data: { mode: 'sources', verdict: 'pass' } });
    expect(result.data).not.toHaveProperty('score');
    expect(result.data).not.toHaveProperty('minScore');
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });

  it('reports a verified missing release', async () => {
    const result = await run(['collection', 'validate', '--check-releases', '--repository', 'owner/repo', '-o', 'json'], httpFixture(false));
    expect(result).toMatchObject({ exitCode: 1, data: { verdict: 'fail' } });
    expect(result.data.findings).toContainEqual(expect.objectContaining({ ruleId: 'COL002', verified: true }));
  });

  it('fails unverified without contacting HTTP when repository context is omitted', async () => {
    const http = httpFixture();
    const result = await run(['collection', 'validate', '--check-releases', '-o', 'json'], http);
    expect(result).toMatchObject({ exitCode: 1, data: { verdict: 'fail' } });
    expect(result.data.findings).toContainEqual(expect.objectContaining({ ruleId: 'COL002', verified: false }));
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it('checks ownership against the central index without contacting other sources', async () => {
    await writeHub();
    await writeFile(path.join(root, 'collection-index.yml'), 'schemaVersion: 1\ncollections:\n  shared:\n    sourceId: first\n');
    const http = httpFixture();
    const result = await run(['collection', 'validate', '--check-sources', '--repository', 'owner/second', '-o', 'json'], http);
    expect(result).toMatchObject({ exitCode: 1, data: { subject: 'collection', mode: 'sources', verdict: 'fail' } });
    expect(result.data.findings).toContainEqual(expect.objectContaining({ ruleId: 'COL004', verified: true, message: expect.stringContaining("registered to source 'first'") }));
    expect(result.data.findings.some((finding: { ruleId: string }) => finding.ruleId === 'COL002')).toBe(false);
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it('accepts same-source updates with thousands of registered collections and no HTTP', async () => {
    await writeHub();
    const entries = Array.from({ length: 10_000 }, (_, i) => `  tools-${i}:\n    sourceId: second`).join('\n');
    await writeFile(path.join(root, 'collection-index.yml'), `schemaVersion: 1\ncollections:\n  shared:\n    sourceId: first\n${entries}\n`);
    const http = httpFixture();
    const result = await run(['collection', 'validate', '--check-sources', '--repository', 'https://github.com/OWNER/FIRST.git', '-o', 'json'], http);
    expect(result).toMatchObject({ exitCode: 0, data: { verdict: 'pass' } });
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['missing index', undefined],
    ['duplicate key', 'schemaVersion: 1\ncollections:\n  shared: {sourceId: first}\n  shared: {sourceId: second}\n'],
    ['unsupported schema', 'schemaVersion: "1"\ncollections: {}\n'],
    ['unknown owner', 'schemaVersion: 1\ncollections:\n  shared: {sourceId: unknown}\n'],
    ['invalid ID', 'schemaVersion: 1\ncollections:\n  Bad_ID: {sourceId: first}\n'],
    ['invalid entry', 'schemaVersion: 1\ncollections:\n  shared: {sourceId: first, unexpected: true}\n']
  ])('fails closed for %s without scanning sources', async (_label, content) => {
    await writeHub();
    if (content !== undefined) {
      await writeFile(path.join(root, 'collection-index.yml'), content);
    }
    const http = httpFixture();
    const result = await run(['collection', 'validate', '--check-sources', '--repository', 'owner/first', '-o', 'json'], http);
    expect(result).toMatchObject({ exitCode: 1, data: { verdict: 'fail' } });
    expect(result.data.findings).toContainEqual(expect.objectContaining({ ruleId: 'COL004', verified: false }));
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it('rejects unregistered IDs and requires an unambiguous repository source', async () => {
    await writeHub();
    await writeFile(path.join(root, 'collection-index.yml'), 'schemaVersion: 1\ncollections: {}\n');
    const http = httpFixture();
    const unregistered = await run(['collection', 'validate', '--check-sources', '--repository', 'owner/first', '-o', 'json'], http);
    expect(unregistered.data.findings).toContainEqual(expect.objectContaining({ ruleId: 'COL004', verified: true, message: expect.stringContaining('not registered') }));
    const unknown = await run(['collection', 'validate', '--check-sources', '-o', 'json'], http);
    expect(unknown.data.findings).toContainEqual(expect.objectContaining({ ruleId: 'COL004', verified: false, message: expect.stringContaining('source identity') }));
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it('keeps reservations for disabled sources', async () => {
    await writeHub();
    const fs = new NodeFileSystem();
    const hubPath = path.join(root, 'hub-config.yml');
    await writeFile(hubPath, (await fs.readFile(hubPath)).replace('enabled: true', 'enabled: false'));
    await writeFile(path.join(root, 'collection-index.yml'), 'schemaVersion: 1\ncollections:\n  shared: {sourceId: first}\n');
    const http = httpFixture();
    const result = await run(['collection', 'validate', '--check-sources', '--repository', 'owner/second', '-o', 'json'], http);
    expect(result.data.findings).toContainEqual(expect.objectContaining({ ruleId: 'COL004', verified: true, message: expect.stringContaining("registered to source 'first'") }));
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it('fails unverified when repository ownership is ambiguous', async () => {
    await writeHub();
    const fs = new NodeFileSystem();
    const hubPath = path.join(root, 'hub-config.yml');
    await writeFile(hubPath, (await fs.readFile(hubPath)).replace('https://github.com/owner/second', 'https://github.com/owner/first'));
    await writeFile(path.join(root, 'collection-index.yml'), 'schemaVersion: 1\ncollections:\n  shared: {sourceId: first}\n');
    const http = httpFixture();
    const result = await run(['collection', 'validate', '--check-sources', '--repository', 'owner/first', '-o', 'json'], http);
    expect(result.data.findings).toContainEqual(expect.objectContaining({ ruleId: 'COL004', verified: false, message: expect.stringContaining('source identity') }));
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it('does not contact sources in default Hub governance', async () => {
    await writeHub();
    const http = httpFixture();
    const result = await run(['hub', 'validate', '--governance', '-o', 'json'], http);
    expect(result).toMatchObject({ exitCode: 0, data: { mode: 'offline' } });
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it('fails without leaking inaccessible release evidence', async () => {
    const result = await run(['collection', 'validate', '--check-releases', '--repository', 'owner/repo', '-o', 'json'], httpFixture(true, 403));
    expect(result).toMatchObject({ exitCode: 1, data: { verdict: 'fail' } });
    expect(result.data.findings).toContainEqual(expect.objectContaining({ ruleId: 'COL002', verified: false }));
    expect(JSON.stringify(result.data)).not.toContain('private-error-marker');
  });

  it('keeps the governance report shape for invalid Hub config even with App setup requested', async () => {
    await writeFile(path.join(root, 'hub-config.yml'), 'version: 1.0.0\nsources: []\n');
    const http = httpFixture();
    const result = await run(['hub', 'validate', '--governance', '--check-sources', '--github-app-id', '123', '-o', 'json'], http);
    expect(result).toMatchObject({ exitCode: 1, data: { subject: 'hub', verdict: 'fail' } });
    expect(result.data.findings).toContainEqual(expect.objectContaining({ ruleId: 'HUB001' }));
    expect(http.fetch).not.toHaveBeenCalled();
  });
});
