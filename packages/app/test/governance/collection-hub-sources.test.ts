import {
  execFileSync,
} from 'node:child_process';
import {
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  HttpRequest,
} from '@ai-primitives-hub/core';
import {
  buildZip,
  NodeArgvProcessRunner,
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
  renderGovernanceMarkdown,
} from '../../src/governance/report';
import {
  runGovernance,
} from '../../src/governance/run-governance';
import {
  createHubSourceAccess,
} from '../../src/governance/source-checks';
import type {
  SourceAdapterFactoryDeps,
} from '../../src/registry/create-source-adapter';

const hubConfig = (sources: string[]): string => [
  'version: 1.0.0', 'metadata:', '  name: Test', '  description: Test', '  maintainer: Test', "  updatedAt: '2026-01-01T00:00:00Z'",
  'sources:', ...sources, 'profiles: []', ''
].join('\n');
const source = (id: string, extra: string[] = []): string => [
  `  - id: ${id}`, `    name: ${id}`, '    type: github', `    url: https://github.com/owner/${id}`, '    enabled: true', '    priority: 1', ...extra
].join('\n');
const text = (value: string) => new TextEncoder().encode(value);

describe('collection validation of hub sources changed by a PR', () => {
  let root: string;
  const fs = new NodeFileSystem();
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const commit = async (config: string): Promise<string> => {
    await writeFile(path.join(root, 'hub-config.yml'), config);
    git('add', '-A');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'change');
    return git('rev-parse', 'HEAD');
  };
  // The GitHub zipball nests every file under one "<owner>-<repo>-<sha>/" folder.
  const zipball = (repo: string, files: Record<string, string>) => buildZip(Object.entries(files).map(([file, content]) => ({
    path: `owner-${repo}-abc123/${file}`, bytes: text(content)
  })));
  const deps = (archives: Record<string, Uint8Array>): SourceAdapterFactoryDeps & { requests: string[] } => {
    const requests: string[] = [];
    return {
      requests, fs, clock: { now: () => 0, nowIso: () => '1970-01-01T00:00:00.000Z' }, fallbackTokenProviders: [],
      processRunner: { exec: vi.fn().mockRejectedValue(new Error('No executable permitted')) },
      httpClient: { fetch: vi.fn(async (req: HttpRequest) => {
        const url = new URL(req.url);
        requests.push(url.pathname);
        // Like GitHub, the zipball endpoint rejects the release-asset media type.
        if (url.pathname.includes('/zipball') && req.headers?.Accept === 'application/octet-stream') {
          return { statusCode: 415, body: text('{"message":"Unsupported Media Type"}'), headers: {}, finalUrl: req.url };
        }
        const archive = archives[url.pathname];
        return archive === undefined
          ? { statusCode: 404, body: text('{"message":"Not Found"}'), headers: {}, finalUrl: req.url }
          : { statusCode: 200, body: archive, headers: {}, finalUrl: req.url };
      }) }
    };
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'collection-hub-sources-'));
    git('init', '--quiet');
    git('config', 'user.name', 'PR Test');
    git('config', 'user.email', 'pr@example.invalid');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('downloads each added or modified github source and validates its collections', async () => {
    const base = await commit(hubConfig([source('kept'), source('changed')]));
    const head = await commit(hubConfig([
      source('kept'),
      source('changed', ['    metadata:', '      description: Updated']),
      source('added'),
      source('disabled').replace('enabled: true', 'enabled: false'),
      source('awesome').replace('type: github', 'type: awesome-copilot'),
      source('missing')
    ]));
    const sourceAdapterDeps = deps({
      '/repos/owner/added/zipball': zipball('added', {
        'collections/good.collection.yml': 'id: good\nname: Good\nauthor: Team\nitems:\n  - path: a.prompt.md\n    kind: prompt\n',
        'a.prompt.md': 'A',
        'collections/bad.collection.yml': 'id: bad\nname: Bad\nauthor: ""\nitems:\n  - path: a.prompt.md\n    kind: prompt\n'
      }),
      '/repos/owner/changed/zipball': zipball('changed', {
        'collections/fine.collection.yml': 'id: fine\nname: Fine\nauthor: Team\nitems:\n  - path: b.prompt.md\n    kind: prompt\n',
        'b.prompt.md': 'B'
      })
    });
    const report = await runGovernance(fs, {
      subject: 'collection', repoRoot: root, baseRef: base, headRef: head, processRunner: new NodeArgvProcessRunner(), hubSources: createHubSourceAccess(sourceAdapterDeps),
      checkSources: true, collectionIndex: { read: async () => ({ collections: [
        { id: 'good', sourceId: 'added' }, { id: 'good', sourceId: 'kept' },
        { id: 'baseline-only', sourceId: 'kept' }, { id: 'baseline-only', sourceId: 'unrelated' }
      ], unverifiedSources: [] }) }
    });

    expect(sourceAdapterDeps.requests.toSorted()).toEqual(['/repos/owner/added/zipball', '/repos/owner/changed/zipball', '/repos/owner/missing/zipball']);
    expect(report.verdict).toBe('fail');
    expect(report.findings.filter((finding) => finding.ruleId === 'COL004')).toEqual([
      expect.objectContaining({ verified: true, message: expect.stringContaining('good') })
    ]);
    expect(report.prScope?.sources).toEqual(['added', 'changed', 'missing']);
    expect(report.findings).toContainEqual(expect.objectContaining({ ruleId: 'COL003', file: 'added/collections/bad.collection.yml' }));
    expect(report.findings).toContainEqual(expect.objectContaining({
      ruleId: 'COL005', verified: false, subject: { kind: 'source', id: 'missing' }, problem: 'Source repository not found, or no access (HTTP 404)'
    }));
    expect(report.findings.filter((finding) => finding.file?.startsWith('changed/') && finding.severity === 'error')).toEqual([]);
    const markdown = renderGovernanceMarkdown(report);
    expect(markdown).toContain('Validated sources: added, changed, missing');
    expect(markdown).not.toContain(os.tmpdir());
  });

  it('checks published releases in each downloaded source when requested', async () => {
    const base = await commit(hubConfig([source('kept')]));
    const head = await commit(hubConfig([source('kept'), source('added', ['    config:', '      branch: release/v1'])]));
    const sourceAdapterDeps = deps({
      '/repos/owner/added/zipball/release/v1': zipball('added', {
        'collections/good.collection.yml': 'id: good\nname: Good\nauthor: Team\nitems:\n  - path: a.prompt.md\n    kind: prompt\n',
        'a.prompt.md': 'A'
      }),
      '/repos/owner/added/releases': text('[]')
    });
    const report = await runGovernance(fs, {
      subject: 'collection', repoRoot: root, baseRef: base, headRef: head, processRunner: new NodeArgvProcessRunner(), hubSources: createHubSourceAccess(sourceAdapterDeps), checkReleases: true
    });

    expect(report.findings).toContainEqual(expect.objectContaining({
      ruleId: 'COL002', verified: true, file: 'added/collections/good.collection.yml', subject: { kind: 'collection', id: 'good', source: 'added' }
    }));
  });

  it('validates collection primitives in changed hub sources, not unrelated source files', async () => {
    const base = await commit(hubConfig([source('kept')]));
    const head = await commit(hubConfig([source('kept'), source('added'), source('missing')]));
    const sourceAdapterDeps = deps({
      '/repos/owner/added/zipball': zipball('added', {
        'collections/one.collection.yml': 'id: one\nname: One\nauthor: Team\nitems:\n  - path: a.prompt.md\n    kind: prompt\n  - path: servers.json\n    kind: mcp-server\n',
        'collections/two.collection.yml': 'id: two\nname: Two\nauthor: Team\nitems:\n  - path: a.prompt.md\n    kind: prompt\n',
        'a.prompt.md': 'Missing frontmatter',
        'servers.json': '{"servers":{"test":{"command":"node","env":{"TOKEN":"literal-secret"}}}}',
        'unreferenced.agent.md': 'Not part of any collection'
      })
    });
    const report = await runGovernance(fs, {
      subject: 'primitive', repoRoot: root, baseRef: base, headRef: head, processRunner: new NodeArgvProcessRunner(), hubSources: createHubSourceAccess(sourceAdapterDeps)
    });
    expect(sourceAdapterDeps.requests.toSorted()).toEqual(['/repos/owner/added/zipball', '/repos/owner/missing/zipball']);
    expect(report.verdict).toBe('fail');
    expect(report.mode).toBe('sources');
    expect(report.prScope?.sources).toEqual(['added', 'missing']);
    expect(report.prScope?.validated).toEqual(['added/a.prompt.md', 'added/servers.json']);
    expect(report.findings.filter((finding) => finding.ruleId === 'PRM001')).toHaveLength(1);
    expect(report.findings).toContainEqual(expect.objectContaining({ ruleId: 'MCP002', file: 'added/servers.json' }));
    expect(report.findings).toContainEqual(expect.objectContaining({ verified: false, subject: { kind: 'source', id: 'missing' } }));
    expect(report.findings.some((finding) => finding.file?.includes('unreferenced'))).toBe(false);
    expect(renderGovernanceMarkdown(report)).not.toContain(os.tmpdir());
  });

  it('leaves the hub sources alone when the PR does not change the hub config', async () => {
    const base = await commit(hubConfig([source('kept')]));
    await writeFile(path.join(root, 'README.md'), 'Docs');
    git('add', '-A');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'docs');
    const head = git('rev-parse', 'HEAD');
    const sourceAdapterDeps = deps({});
    const report = await runGovernance(fs, {
      subject: 'collection', repoRoot: root, baseRef: base, headRef: head, processRunner: new NodeArgvProcessRunner(), hubSources: createHubSourceAccess(sourceAdapterDeps)
    });

    expect(report.verdict).toBe('pass');
    expect(sourceAdapterDeps.requests).toEqual([]);
  });
});
