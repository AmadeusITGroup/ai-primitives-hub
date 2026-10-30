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
  renderGovernanceMarkdown,
} from '../../src/governance/report';
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
      repoRoot: root, subject: 'collection', checkSources: true, collectionIndex: { read }, releaseLookup: { lookup }
    });
    expect(report).toMatchObject({ mode: 'sources', verdict: 'fail' });
    expect(report.findings).toContainEqual(expect.objectContaining({ ruleId: 'COL004' }));
    expect(read).toHaveBeenCalledOnce();
  });
  it('does not perform collection inventory or publication checks in hub validation', async () => {
    await writeFile(path.join(root, 'hub-config.yml'), [
      'version: 1.0.0', 'metadata:', '  name: Test', '  description: Test',
      '  maintainer: Test', "  updatedAt: '2026-01-01T00:00:00Z'", 'sources:',
      '  - id: gh', '    name: GH', '    type: github', '    url: https://github.com/owner/gh', '    enabled: true', '    priority: 1',
      '  - id: awesome', '    name: Awesome', '    type: awesome-copilot', '    url: https://github.com/owner/awesome', '    enabled: true', '    priority: 2', '    config:', '      branch: main',
      '  - id: awesome-down', '    name: Down', '    type: awesome-copilot', '    url: https://github.com/owner/down', '    enabled: true', '    priority: 3', '    config:', '      branch: main',
      'profiles: []', ''
    ].join('\n'));
    const read = vi.fn().mockResolvedValue({
      collections: [{ id: 'a', sourceId: 'gh' }, { id: 'b', sourceId: 'awesome' }],
      unverifiedSources: [{ sourceId: 'awesome-down', message: 'Unavailable' }]
    });
    const lookup = vi.fn().mockResolvedValue({ status: 'missing' });
    const report = await runGovernance(new NodeFileSystem(), {
      repoRoot: root, subject: 'hub', checkSources: true, collectionIndex: { read }, releaseLookup: { lookup }
    });
    expect(lookup).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(report.findings.some((f) => f.ruleId.startsWith('COL'))).toBe(false);
  });
  it('reports a repository without a collections directory as having no collections', async () => {
    await rm(path.join(root, 'collections'), { recursive: true, force: true });
    const report = await runGovernance(new NodeFileSystem(), { repoRoot: root, subject: 'collection' });
    expect(report.findings).toEqual([expect.objectContaining({ ruleId: 'COL005', message: expect.stringContaining('No collection files found') })]);
  });
  it('passes a PR-scoped run in a repository without a collections directory', async () => {
    await rm(path.join(root, 'collections'), { recursive: true, force: true });
    const head = 'b'.repeat(40);
    const execFile = vi.fn((_file: string, args: readonly string[]) => {
      let stdout = 'README.md\0';
      if (args.includes('rev-parse')) {
        stdout = head;
      } else if (args.includes('merge-base')) {
        stdout = 'c'.repeat(40);
      }
      return Promise.resolve({ stdout, stderr: '' });
    });
    const report = await runGovernance(new NodeFileSystem(), {
      repoRoot: root, subject: 'collection', baseRef: 'a'.repeat(40), headRef: head, processRunner: { execFile }
    });
    expect(report.findings).toEqual([]);
    expect(report.verdict).toBe('pass');
  });
  it('reports collection problems once, with each affected file and its details', async () => {
    await writeFile(path.join(root, 'collections/bad.collection.yml'),
      'id: bad\nname: Bad\nauthor: ""\nitems:\n  - path: one.prompt.md\n    kind: prompt\n  - path: two.prompt.md\n    kind: prompt\n');
    const markdown = renderGovernanceMarkdown(await runGovernance(new NodeFileSystem(), { repoRoot: root, subject: 'collection' }));
    expect(markdown).toContain('| Referenced file not found | collections/bad&#46;collection&#46;yml (one&#46;prompt&#46;md, two&#46;prompt&#46;md) |');
    expect(markdown).toContain('| Collection author is empty | collections/bad&#46;collection&#46;yml |');
    expect(markdown).toMatch(/\| Collection has no readme \| collections\/bad&#46;collection&#46;yml, collections\/test&#46;collection&#46;yml \|/);
  });
  it('keeps missing inventory data distinct from verified failures', async () => {
    const report = await runGovernance(new NodeFileSystem(), {
      repoRoot: root, subject: 'collection', checkSources: true,
      collectionIndex: { read: async () => ({ collections: [], unverifiedSources: [{ sourceId: 'private', message: 'Unavailable' }] }) }
    });
    expect(report.verdict).toBe('fail');
    expect(report.findings).toContainEqual(expect.objectContaining({ ruleId: 'COL004', verified: false }));
  });

  it('cannot bypass mandatory publication checks by disabling uniqueness when inventory is unavailable', async () => {
    await writeFile(path.join(root, 'policy.yml'), 'rules:\n  COL004:\n    enabled: false\n    reason: Temporary uniqueness exemption\n');
    const report = await runGovernance(new NodeFileSystem(), {
      repoRoot: root, subject: 'collection', policy: 'policy.yml', checkSources: true, checkReleases: true,
      collectionIndex: { read: async () => ({ collections: [], unverifiedSources: [{ sourceId: 'private', message: 'Unavailable' }] }) }
    });
    expect(report.verdict).toBe('fail');
    expect(report.findings).toContainEqual(expect.objectContaining({ ruleId: 'COL002', verified: false }));
  });
});
