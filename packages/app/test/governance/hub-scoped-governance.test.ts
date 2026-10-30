import {
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
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
  runHubScopedGovernance,
} from '../../src/governance/hub-scoped-governance';
import type {
  SourceAdapterFactoryDeps,
} from '../../src/registry/create-source-adapter';

const source = (id: string) => ({ id, type: 'github', url: `https://github.com/owner/${id}`, enabled: true, priority: 0 });
const ref = (sourceId: string, version = '1.0.0') => ({ id: `owner-${sourceId}-selected-1.0.0`, source: sourceId, version, required: true });
const hub = () => ({ version: '1.0.0', metadata: { name: 'Test', description: 'Test', maintainer: 'Test', updatedAt: '2026-01-01T00:00:00Z' },
  sources: [source('a'), source('b')], profiles: [{ id: 'p', name: 'P', description: 'P', bundles: [ref('a'), ref('b')] }] });
describe('scoped Hub governance app', () => {
  let root: string;
  const fs = new NodeFileSystem();
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'hub-scoped-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const runner = (base: unknown, head: unknown, baseGovernance?: string) => ({ execFile: vi.fn((_file: string, args: readonly string[]) => {
    if (args.at(-1)?.endsWith(':hub-governance.yml')) {
      // Only the merge base ('c…') may carry the governance configuration in these tests.
      if (baseGovernance === undefined || !args.at(-1)?.startsWith('c')) {
        return Promise.reject(new Error('fatal: path does not exist'));
      }
      return Promise.resolve({ stdout: args.includes('blob') ? baseGovernance : 'blob', stderr: '' });
    }
    let stdout = args.at(-1)?.includes(':') ? 'blob' : 'commit';
    if (args.includes('merge-base')) {
      stdout = 'c'.repeat(40);
    }
    if (args.includes('blob')) {
      stdout = JSON.stringify(args.at(-1)?.startsWith('c') ? base : head);
    }
    return Promise.resolve({ stdout, stderr: '' });
  }) });
  const request = (base: unknown, head: unknown) => ({ repoRoot: root, baseRef: 'a'.repeat(40), headRef: 'b'.repeat(40), processRunner: runner(base, head) });
  const deps = (): SourceAdapterFactoryDeps => ({ fs, clock: { now: () => 0 }, processRunner: { exec: vi.fn().mockRejectedValue(new Error('No executable permitted')) }, fallbackTokenProviders: [],
    httpClient: { fetch: vi.fn(async (req) => {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/releases')) {
        return { statusCode: 200, body: Buffer.from(JSON.stringify([{ tag_name: 'v1.0.0', draft: false, prerelease: false, published_at: '2026-01-01T00:00:00Z', assets: [
          { name: 'deployment-manifest.yml', url: 'https://api.github.com/repos/owner/a/releases/assets/1' },
          { name: 'bundle.zip', url: 'https://api.github.com/repos/owner/a/releases/assets/2', browser_download_url: 'https://github.com/owner/a/releases/download/v1.0.0/bundle.zip' }
        ] }])), headers: {}, finalUrl: req.url };
      }
      if (url.pathname.endsWith('/releases/assets/1')) {
        return { statusCode: 200, body: Buffer.from('id: selected\nname: Selected\nversion: 1.0.0\n'), headers: {}, finalUrl: req.url };
      }
      if (url.pathname === '/repos/owner/a') {
        return { statusCode: 200, body: Buffer.from('{"full_name":"owner/a"}'), headers: {}, finalUrl: req.url };
      }
      throw new Error(`Unexpected HTTP ${url.pathname}`);
    }) }
  });
  it('ignores unrelated per-entity baseline errors and stays offline', async () => {
    const base = hub();
    base.sources[1].type = 'bad';
    const head = structuredClone(base);
    head.profiles[0].bundles[0].version = '2.0.0';
    const sourceAdapterDeps = deps();
    const report = await runHubScopedGovernance(fs, { ...request(base, head), sourceAdapterDeps });
    expect(report).toMatchObject({ verdict: 'pass', scope: { sourceIds: ['a'], profileIds: ['p'] } });
    expect(Reflect.get(sourceAdapterDeps.httpClient, 'fetch')).not.toHaveBeenCalled();
  });
  it('enforces policy and threshold even for semantic no-op', async () => {
    const base = hub();
    await writeFile(path.join(root, 'policy.yml'), 'rules:\n  HUB001:\n    enabled: false\n');
    const report = await runHubScopedGovernance(fs, { ...request(base, base), policy: 'policy.yml', minScore: Number.NaN, checkSources: true, sourceAdapterDeps: deps() });
    expect(report).toMatchObject({ verdict: 'fail', scope: { noOp: true } });
    expect(report.findings.map((f) => f.ruleId)).toEqual(expect.arrayContaining(['CFG003', 'CFG004']));
  });
  it('reads hub-governance.yml from the merge base, never from the PR head checkout', async () => {
    const base = hub();
    const head = structuredClone(base);
    head.profiles[0].bundles[0].version = '2.0.0';
    // The checkout (PR head) tries to relax the gate; the base configuration must win.
    await writeFile(path.join(root, 'hub-governance.yml'), 'minScore: 0\n');
    const report = await runHubScopedGovernance(fs, { ...request(base, head), processRunner: runner(base, head, 'minScore: 100\nrules:\n  HUB002:\n    enabled: false\n    reason: noisy\n') });
    expect(report).toMatchObject({ minScore: 100, suppressions: [{ ruleId: 'HUB002', action: 'disabled', reason: 'noisy' }] });
  });
  it('does not include collection rules in an offline hub run', async () => {
    const base = hub();
    const head = structuredClone(base);
    head.profiles[0].bundles[0].version = '2.0.0';
    const report = await runHubScopedGovernance(fs, request(base, head));
    expect(report.mode).toBe('offline');
    expect(report.notChecked).toEqual([]);
  });
  it('rejects duplicate IDs from full head context before projection', async () => {
    const head = hub();
    head.sources.push(head.sources[1]);
    expect((await runHubScopedGovernance(fs, request(hub(), head))).verdict).toBe('fail');
  });
  it('uses deep profile resolution to reject a missing pinned version', async () => {
    const base = hub();
    const head = hub();
    head.profiles[0].bundles[0].version = '2.0.0';
    const report = await runHubScopedGovernance(fs, { ...request(base, head), checkSources: true, sourceAdapterDeps: deps(),
      collectionIndex: { read: () => Promise.resolve({ collections: [], unverifiedSources: [] }) } });
    expect(report.verdict).toBe('fail');
    expect(report.findings).toContainEqual(expect.objectContaining({ ruleId: 'HUB001', message: expect.stringContaining('2.0.0') }));
    // The missing bundle is one problem: deep validation reports it, the release check must not repeat it.
    expect(report.findings.filter((finding) => finding.ruleId === 'COL002')).toEqual([]);
  });
  it('checks only selected publication and collisions, keeping other inventories as context', async () => {
    const base = hub();
    const head = hub();
    head.profiles[0].bundles[0].required = false;
    const lookup = vi.fn().mockResolvedValue({ status: 'published' });
    const report = await runHubScopedGovernance(fs, { ...request(base, head), checkSources: true, sourceAdapterDeps: deps(), releaseLookup: { lookup }, collectionIndex: { read: async () => ({
      collections: [{ sourceId: 'a', id: 'selected' }, { sourceId: 'b', id: 'unrelated' }, { sourceId: 'c', id: 'unrelated' }], unverifiedSources: []
    }) } });
    expect(report.verdict).toBe('pass');
    expect(lookup).not.toHaveBeenCalled();
    expect(report.findings.some((f) => f.ruleId === 'COL004')).toBe(false);
  });
  it('does not read unrelated collection inventories or fail HUB001 for missing uniqueness evidence', async () => {
    const base = hub();
    const head = hub();
    head.profiles[0].bundles[0].required = false;
    await writeFile(path.join(root, 'policy.yml'), 'rules:\n  COL004:\n    enabled: false\n');
    const report = await runHubScopedGovernance(fs, { ...request(base, head), checkSources: true, policy: 'policy.yml', sourceAdapterDeps: deps(),
      releaseLookup: { lookup: () => Promise.resolve({ status: 'published' }) },
      collectionIndex: { read: () => Promise.resolve({ collections: [{ sourceId: 'a', id: 'selected' }], unverifiedSources: [{ sourceId: 'b', message: 'Cannot read context' }] }) } });
    expect(report.verdict).toBe('pass');
    expect(report.findings.some((finding) => finding.ruleId.startsWith('COL'))).toBe(false);
  });
  it('validates scope-file IDs and never silently passes typo selectors', async () => {
    await writeFile(path.join(root, 'hub-config.yml'), JSON.stringify(hub()));
    await writeFile(path.join(root, 'scope.json'), JSON.stringify({ schemaVersion: 1, sourceIds: ['typo'], profileIds: [] }));
    expect((await runHubScopedGovernance(fs, { repoRoot: root, scopeFile: 'scope.json', processRunner: runner({}, {}) })).verdict).toBe('fail');
  });
  it('reports remaining profiles broken by a deleted source', async () => {
    const base = hub();
    const head = hub();
    head.sources = head.sources.filter((s) => s.id !== 'a');
    const report = await runHubScopedGovernance(fs, request(base, head));
    expect(report.verdict).toBe('fail');
    expect(report.scope?.sources.removed).toEqual(['a']);
    expect(report.findings.some((f) => f.message.includes('non-existent source'))).toBe(true);
  });
  it('resolves profile versions without performing collection inventory checks', async () => {
    const base = hub();
    const head = hub();
    base.sources[1].type = 'skills';
    head.sources[1].type = 'skills';
    base.profiles[0].bundles[0].version = '0.9.0';
    const sourceAdapterDeps = deps();
    const report = await runHubScopedGovernance(fs, { ...request(base, head), checkSources: true, sourceAdapterDeps });
    expect(report).toMatchObject({ verdict: 'pass', mode: 'sources', scope: { sourceIds: ['a'] } });
    expect(Reflect.get(sourceAdapterDeps.httpClient, 'fetch')).toHaveBeenCalled();
    const requests = vi.mocked(sourceAdapterDeps.httpClient).fetch.mock.calls.map(([httpRequest]) => httpRequest.url);
    expect(requests.filter((url) => url.includes('/releases?'))).toHaveLength(0);
    // The pinned profile reference still needs its manifest; this is HUB001 resolution, not COL002.
    expect(requests.filter((url) => url.endsWith('/releases/assets/1'))).toHaveLength(1);
  });
  it('skips all remote evidence for a genuine semantic no-op', async () => {
    const head = hub();
    const read = vi.fn();
    const sourceAdapterDeps = deps();
    const report = await runHubScopedGovernance(fs, { ...request(head, head), checkSources: true, sourceAdapterDeps, collectionIndex: { read } });
    expect(report).toMatchObject({ verdict: 'pass', scope: { noOp: true } });
    expect(read).not.toHaveBeenCalled();
    expect(Reflect.get(sourceAdapterDeps.httpClient, 'fetch')).not.toHaveBeenCalled();
  });
  it('keeps skill-only validation independent of local collection context', async () => {
    const head = hub();
    head.sources[1].type = 'local-awesome-copilot';
    head.sources[1].url = '/must-not-read';
    head.sources[0].enabled = false;
    head.sources[0].type = 'skills';
    head.profiles = [];
    const read = vi.fn();
    const sourceAdapterDeps = deps();
    // Select a skill source explicitly, leaving unrelated local context unchanged.
    await writeFile(path.join(root, 'hub-config.yml'), JSON.stringify(head));
    await writeFile(path.join(root, 'scope.json'), JSON.stringify({ schemaVersion: 1, sourceIds: ['a'], profileIds: [] }));
    const selected = await runHubScopedGovernance(fs, { repoRoot: root, scopeFile: 'scope.json', processRunner: runner({}, {}), checkSources: true, sourceAdapterDeps, collectionIndex: { read } });
    expect(selected.verdict).toBe('pass');
    expect(read).not.toHaveBeenCalled();
    expect(Reflect.get(sourceAdapterDeps.httpClient, 'fetch')).not.toHaveBeenCalled();
  });
  it('never runs a selected local/APM executable in scoped deep mode', async () => {
    const base = hub();
    const head = hub();
    head.sources[0].type = 'apm';
    const sourceAdapterDeps = deps();
    const report = await runHubScopedGovernance(fs, { ...request(base, head), checkSources: true, sourceAdapterDeps });
    expect(report.verdict).toBe('fail');
    expect(Reflect.get(sourceAdapterDeps.processRunner, 'exec')).not.toHaveBeenCalled();
    expect(Reflect.get(sourceAdapterDeps.httpClient, 'fetch')).not.toHaveBeenCalled();
  });
});
