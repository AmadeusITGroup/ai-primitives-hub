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
    await writeFile(path.join(root, 'collection-index.yml'), 'schemaVersion: 1\ncollections:\n  good: {sourceId: kept}\n  fine: {sourceId: changed}\n');
    const head = await commit(hubConfig([
      source('kept'),
      source('changed', ['    metadata:', '      description: Updated']),
      source('added'),
      source('disabled').replace('enabled: true', 'enabled: false'),
      source('awesome').replace('type: github', 'type: awesome-copilot'),
      source('missing')
    ]));
    // Neither uncommitted config nor index changes may alter the committed PR evidence.
    await writeFile(path.join(root, 'hub-config.yml'), hubConfig([source('untrusted')]));
    await writeFile(path.join(root, 'collection-index.yml'), 'schemaVersion: 1\ncollections:\n  good: {sourceId: added}\n  fine: {sourceId: changed}\n');
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
      checkSources: true
    });

    expect(sourceAdapterDeps.requests.toSorted()).toEqual(['/repos/owner/added/zipball', '/repos/owner/changed/zipball', '/repos/owner/missing/zipball']);
    expect(report.verdict).toBe('fail');
    expect(report.findings.filter((finding) => finding.ruleId === 'COL004')).toEqual([
      expect.objectContaining({ verified: true, message: expect.stringContaining("'bad' is not registered") }),
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

  it('checks profile-only changes against registered owners without downloading source catalogs', async () => {
    await writeFile(path.join(root, 'collection-index.yml'), 'schemaVersion: 1\ncollections:\n  shared: {sourceId: kept}\n');
    const config = hubConfig([source('kept'), source('second')]);
    const base = await commit(config);
    const head = await commit(config.replace('profiles: []', 'profiles:\n  - id: tools\n    bundles:\n      - id: owner-second-shared\n        source: second\n        version: 1.0.0'));
    const sourceAdapterDeps = deps({});
    const report = await runGovernance(fs, {
      subject: 'collection', repoRoot: root, baseRef: base, headRef: head, processRunner: new NodeArgvProcessRunner(),
      hubSources: createHubSourceAccess(sourceAdapterDeps), checkSources: true
    });
    expect(report.findings).toContainEqual(expect.objectContaining({
      ruleId: 'COL004', verified: true, message: "Collection ID 'shared' is registered to source 'kept', not 'second'."
    }));
    expect(sourceAdapterDeps.requests).toEqual([]);
  });

  it('rechecks profile owners when only the registry changes', async () => {
    await writeFile(path.join(root, 'collection-index.yml'), 'schemaVersion: 1\ncollections:\n  shared: {sourceId: kept}\n');
    const config = hubConfig([source('kept'), source('second')]).replace('profiles: []',
      'profiles:\n  - id: tools\n    bundles:\n      - id: owner-kept-shared\n        source: kept\n        version: 1.0.0');
    const base = await commit(config);
    await writeFile(path.join(root, 'collection-index.yml'), 'schemaVersion: 1\ncollections:\n  shared: {sourceId: second}\n');
    const head = await commit(config);
    const report = await runGovernance(fs, {
      subject: 'collection', repoRoot: root, baseRef: base, headRef: head, processRunner: new NodeArgvProcessRunner(), checkSources: true
    });
    expect(report.findings).toContainEqual(expect.objectContaining({ ruleId: 'COL004', verified: true, message: expect.stringContaining("registered to source 'second'") }));
  });

  it.each([
    ['missing', undefined],
    ['malformed', 'schemaVersion: "1"\ncollections: {}\n'],
    ['duplicate keys', 'schemaVersion: 1\ncollections:\n  tools: {sourceId: kept}\n  tools: {sourceId: kept}\n']
  ])('does not hide %s committed index evidence or replace it with working-tree data', async (_label, content) => {
    const config = hubConfig([source('kept')]);
    await writeFile(path.join(root, 'collection-index.yml'), 'schemaVersion: 1\ncollections: {}\n');
    const base = await commit(config);
    await (content === undefined ? rm(path.join(root, 'collection-index.yml')) : writeFile(path.join(root, 'collection-index.yml'), content));
    const head = await commit(config);
    await writeFile(path.join(root, 'collection-index.yml'), 'schemaVersion: 1\ncollections: {}\n');
    const report = await runGovernance(fs, {
      subject: 'collection', repoRoot: root, baseRef: base, headRef: head, processRunner: new NodeArgvProcessRunner(), checkSources: true
    });
    expect(report.findings).toContainEqual(expect.objectContaining({ ruleId: 'COL004', verified: false }));
    expect(report.verdict).toBe('fail');
  });

  it('reads explicit collection policies from the merge base instead of a relaxed head policy', async () => {
    await writeFile(path.join(root, 'policy.yml'), 'rules:\n  COL005:\n    enabled: false\n');
    const base = await commit(hubConfig([source('kept')]));
    await writeFile(path.join(root, 'policy.yml'), 'rules: {}\n');
    const head = await commit(hubConfig([source('kept')]));
    const report = await runGovernance(fs, {
      subject: 'collection', repoRoot: root, baseRef: base, headRef: head, processRunner: new NodeArgvProcessRunner(), policy: 'policy.yml'
    });
    expect(report.verdict).toBe('fail');
    expect(report.findings).toContainEqual(expect.objectContaining({ ruleId: 'CFG003' }));
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
