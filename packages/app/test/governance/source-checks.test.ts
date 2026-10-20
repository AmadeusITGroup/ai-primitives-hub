import {
  mkdir,
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
  runGovernance,
} from '../../src/governance/run-governance';

describe('governance source checks through the public app entry point', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'governance-sources-'));
    await mkdir(path.join(root, 'collections'));
    await writeFile(path.join(root, 'test.prompt.md'), 'Test');
    await writeFile(path.join(root, 'collections/test.collection.yml'), 'id: test\nname: Test\nauthor: Test\nitems:\n  - path: test.prompt.md\n    kind: prompt\n');
    await writeFile(path.join(root, 'hub-config.yml'), [
      'version: 1.0.0', 'metadata:', '  name: Test', '  description: Test',
      '  maintainer: Test', "  updatedAt: '2026-01-01T00:00:00Z'", 'sources: []', 'profiles: []', ''
    ].join('\n'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it('keeps plain governance offline even if network ports are supplied', async () => {
    const lookup = vi.fn();
    const report = await runGovernance(new NodeFileSystem(), { repoRoot: root, subject: 'collection', releaseLookup: { lookup } });
    expect(report.mode).toBe('offline');
    expect(lookup).not.toHaveBeenCalled();
  });
  it('checks releases for each selected local collection only when requested', async () => {
    const lookup = vi.fn().mockResolvedValue({ status: 'missing' });
    const report = await runGovernance(new NodeFileSystem(), {
      repoRoot: root, subject: 'collection', checkReleases: true, repository: 'https://github.com/owner/repo', releaseLookup: { lookup }
    });
    expect(report.mode).toBe('sources');
    expect(report.findings).toContainEqual(expect.objectContaining({ ruleId: 'COL002', verified: true }));
    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ id: 'test', repository: 'https://github.com/owner/repo' }));
  });
  it('does not silently skip requested release checks without repository context', async () => {
    const report = await runGovernance(new NodeFileSystem(), { repoRoot: root, subject: 'collection', checkReleases: true });
    expect(report.verdict).toBe('fail');
    expect(report.findings).toContainEqual(expect.objectContaining({ ruleId: 'COL002', verified: false }));
  });
  it('evaluates complete Hub inventories with the same rule engine', async () => {
    const read = vi.fn().mockResolvedValue({ collections: [{ id: 'test', sourceId: 'one' }, { id: 'test', sourceId: 'two' }], unverifiedSources: [] });
    const lookup = vi.fn().mockResolvedValue({ status: 'published' });
    const report = await runGovernance(new NodeFileSystem(), {
      repoRoot: root, subject: 'hub', checkSources: true, collectionIndex: { read }, releaseLookup: { lookup }
    });
    expect(report).toMatchObject({ mode: 'sources', verdict: 'fail', score: 90 });
    expect(report.findings).toContainEqual(expect.objectContaining({ ruleId: 'COL004' }));
    expect(read).toHaveBeenCalledOnce();
  });
  it('keeps missing inventory data distinct from verified failures', async () => {
    const report = await runGovernance(new NodeFileSystem(), {
      repoRoot: root, subject: 'hub', checkSources: true,
      collectionIndex: { read: async () => ({ collections: [], unverifiedSources: [{ sourceId: 'private', message: 'Unavailable' }] }) }
    });
    expect(report).toMatchObject({ verdict: 'fail', score: 100 });
    expect(report.findings).toContainEqual(expect.objectContaining({ ruleId: 'COL004', verified: false }));
  });

  it('cannot bypass mandatory publication checks by disabling uniqueness when inventory is unavailable', async () => {
    await writeFile(path.join(root, 'policy.yml'), 'rules:\n  COL004:\n    enabled: false\n    reason: Temporary uniqueness exemption\n');
    const report = await runGovernance(new NodeFileSystem(), {
      repoRoot: root, subject: 'hub', policy: 'policy.yml', checkSources: true,
      collectionIndex: { read: async () => ({ collections: [], unverifiedSources: [{ sourceId: 'private', message: 'Unavailable' }] }) }
    });
    expect(report).toMatchObject({ verdict: 'fail', score: 100 });
    expect(report.findings).toContainEqual(expect.objectContaining({ ruleId: 'COL002', verified: false }));
  });
});
