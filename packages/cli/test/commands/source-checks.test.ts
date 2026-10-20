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
    expect(result).toMatchObject({ exitCode: 0, data: { mode: 'sources', verdict: 'pass', score: 97 } });
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });

  it('reports a verified missing release', async () => {
    const result = await run(['collection', 'validate', '--check-releases', '--repository', 'owner/repo', '-o', 'json'], httpFixture(false));
    expect(result).toMatchObject({ exitCode: 1, data: { verdict: 'fail', score: 87 } });
    expect(result.data.findings).toContainEqual(expect.objectContaining({ ruleId: 'COL002', verified: true }));
  });

  it('fails unverified without contacting HTTP when repository context is omitted', async () => {
    const http = httpFixture();
    const result = await run(['collection', 'validate', '--check-releases', '-o', 'json'], http);
    expect(result).toMatchObject({ exitCode: 1, data: { score: 97 } });
    expect(result.data.findings).toContainEqual(expect.objectContaining({ ruleId: 'COL002', verified: false }));
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it('identifies raw collection IDs shared across two Hub release sources', async () => {
    await writeHub();
    const result = await run(['hub', 'validate', '--governance', '--check-sources', '-o', 'json'], httpFixture());
    expect(result).toMatchObject({ exitCode: 1, data: { mode: 'sources', verdict: 'fail', score: 90 } });
    expect(result.data.findings).toContainEqual(expect.objectContaining({ ruleId: 'COL004', verified: true, message: expect.stringContaining('first, second') }));
    expect(result.data.findings.some((finding: { ruleId: string }) => finding.ruleId === 'COL002')).toBe(false);
  });

  it('does not contact sources in default Hub governance', async () => {
    await writeHub();
    const http = httpFixture();
    const result = await run(['hub', 'validate', '--governance', '-o', 'json'], http);
    expect(result).toMatchObject({ exitCode: 0, data: { mode: 'offline' } });
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it('does not penalize or leak inaccessible release evidence', async () => {
    const result = await run(['collection', 'validate', '--check-releases', '--repository', 'owner/repo', '-o', 'json'], httpFixture(true, 403));
    expect(result).toMatchObject({ exitCode: 1, data: { score: 97 } });
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
