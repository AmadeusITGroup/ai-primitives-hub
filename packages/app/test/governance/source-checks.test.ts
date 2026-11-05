import {
  execFileSync,
} from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
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
  loadScopedGovernanceConfig,
  withDisplayPaths,
} from '../../src/governance/load-config';
import {
  renderGovernanceMarkdown,
} from '../../src/governance/report';
import {
  runGovernance,
} from '../../src/governance/run-governance';
import {
  createHubGovernanceSourceChecks,
} from '../../src/governance/source-checks';

describe('governance source checks through the public app entry point', () => {
  let root: string;
  const git = (...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd: root, encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')))
  }).trim();
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
  it('fails closed when the default merge-base policy cannot be read', async () => {
    const execFile = vi.fn().mockRejectedValue(new Error('Git timed out'));
    const config = await loadScopedGovernanceConfig(new NodeFileSystem(), {
      repoRoot: root, processRunner: { execFile }
    }, 'a'.repeat(40));
    expect(config.findings).toContainEqual(expect.objectContaining({ ruleId: 'CFG001', severity: 'error' }));
  });

  it('isolates temporary Git repositories from inherited Git locations and signing settings', async () => {
    const originalEnv = process.env;
    try {
      process.env = { ...originalEnv, GIT_DIR: path.join(root, 'wrong.git'), GIT_WORK_TREE: path.join(root, 'wrong'),
        GIT_INDEX_FILE: path.join(root, 'wrong-index'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'true' };
      git('init', '--quiet');
      git('config', 'user.name', 'Isolation Test');
      git('config', 'user.email', 'isolation@example.invalid');
      git('config', 'commit.gpgsign', 'true');
      git('add', '-A');
      git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Isolated');
      expect(await realpath(git('rev-parse', '--show-toplevel'))).toBe(await realpath(root));
    } finally {
      process.env = originalEnv;
    }
  });
  it('normalizes Windows relative finding paths without changing pathless findings', () => {
    expect(withDisplayPaths([
      { ruleId: 'COL005', severity: 'error', file: 'collections\\bad.collection.yml', message: 'Invalid collection' },
      { ruleId: 'COL005', severity: 'error', message: 'No collections' }
    ], root)).toEqual([
      { ruleId: 'COL005', severity: 'error', file: 'collections/bad.collection.yml', message: 'Invalid collection' },
      { ruleId: 'COL005', severity: 'error', message: 'No collections' }
    ]);
  });
  it('retains touched collection findings and normalized release and scope paths in a real Git run', async () => {
    git('init', '--quiet');
    git('config', 'user.name', 'Path Test');
    git('config', 'user.email', 'paths@example.invalid');
    git('add', '-A');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Base');
    const baseRef = git('rev-parse', 'HEAD');
    await writeFile(path.join(root, 'collections/test.collection.yml'),
      'id: test\nname: Test\nauthor: ""\nitems:\n  - path: missing.prompt.md\n    kind: prompt\n');
    git('add', '-A');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Broken collection');
    const headRef = git('rev-parse', 'HEAD');
    const report = await runGovernance(new NodeFileSystem(), {
      repoRoot: root, subject: 'collection', baseRef, headRef, processRunner: new NodeArgvProcessRunner(), checkReleases: true,
      releaseLookup: { lookup: () => Promise.resolve({ status: 'missing' }) }
    });
    expect(report.verdict).toBe('fail');
    for (const ruleId of ['COL003', 'COL005', 'COL006']) {
      expect(report.findings).toContainEqual(expect.objectContaining({ ruleId, file: 'collections/test.collection.yml' }));
    }
    expect(report.prScope?.validated).toEqual(['collections/test.collection.yml']);
    await writeFile(path.join(root, 'collections/test.collection.yml'),
      'id: test\nname: Test\nauthor: Test\nitems:\n  - path: test.prompt.md\n    kind: prompt\n');
    git('add', '-A');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Valid collection');
    const lookup = vi.fn().mockResolvedValue({ status: 'missing' });
    const published = await runGovernance(new NodeFileSystem(), {
      repoRoot: root, subject: 'collection', baseRef: headRef, headRef: git('rev-parse', 'HEAD'), processRunner: new NodeArgvProcessRunner(),
      checkReleases: true, releaseLookup: { lookup }
    });
    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ file: 'collections/test.collection.yml' }));
    expect(published.findings).toContainEqual(expect.objectContaining({ ruleId: 'COL002', file: 'collections/test.collection.yml' }));
    const previous = git('rev-parse', 'HEAD');
    await writeFile(path.join(root, 'collections/z-duplicate.collection.yml'),
      'id: test\nname: Test\nauthor: Test\nitems:\n  - path: test.prompt.md\n    kind: prompt\n');
    git('add', '-A');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Duplicate collection');
    const duplicate = await runGovernance(new NodeFileSystem(), {
      repoRoot: root, subject: 'collection', baseRef: previous, headRef: git('rev-parse', 'HEAD'), processRunner: new NodeArgvProcessRunner()
    });
    expect(duplicate.verdict).toBe('fail');
    expect(duplicate.findings).toContainEqual(expect.objectContaining({ ruleId: 'COL001', file: 'collections/z-duplicate.collection.yml' }));
  });
  it('retains COL005 for a deleted skill entry while tracking remaining skill files in PR scope', async () => {
    const skillPath = 'skills/example/SKILL.md';
    const scriptPath = 'skills/example/scripts/run.js';
    await mkdir(path.join(root, 'skills/example/scripts'), { recursive: true });
    await writeFile(path.join(root, skillPath), '# Example\n');
    await writeFile(path.join(root, scriptPath), '// Original\n');
    await writeFile(path.join(root, 'collections/test.collection.yml'),
      `id: test\nname: Test\nauthor: Test\nitems:\n  - path: ${skillPath}\n    kind: skill\n`);
    git('init', '--quiet');
    git('config', 'user.name', 'Skill Test');
    git('config', 'user.email', 'skills@example.invalid');
    git('add', '-A');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Base');
    const baseRef = git('rev-parse', 'HEAD');
    await rm(path.join(root, skillPath));
    git('add', '-A');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Delete skill entry');
    const report = await runGovernance(new NodeFileSystem(), {
      repoRoot: root, subject: 'collection', baseRef, headRef: git('rev-parse', 'HEAD'), processRunner: new NodeArgvProcessRunner()
    });
    expect(report.prScope?.changedFiles).toEqual([skillPath]);
    expect(report.prScope?.validated).toEqual(['collections/test.collection.yml']);
    expect(report.verdict).toBe('fail');
    expect(report.findings).toContainEqual(expect.objectContaining({
      ruleId: 'COL005', file: 'collections/test.collection.yml', message: expect.stringContaining(skillPath)
    }));

    const previous = git('rev-parse', 'HEAD');
    await writeFile(path.join(root, scriptPath), '// Updated\n');
    git('add', '-A');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Update remaining script');
    const scriptReport = await runGovernance(new NodeFileSystem(), {
      repoRoot: root, subject: 'collection', baseRef: previous, headRef: git('rev-parse', 'HEAD'), processRunner: new NodeArgvProcessRunner()
    });
    expect(scriptReport.prScope?.changedFiles).toEqual([scriptPath]);
    expect(scriptReport.prScope?.validated).toEqual(['collections/test.collection.yml']);
    expect(scriptReport.findings).toContainEqual(expect.objectContaining({ ruleId: 'COL005' }));
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
  it('uses the central index through the existing SDK factory without remote scans', async () => {
    await writeFile(path.join(root, 'hub-config.yml'), 'sources:\n  - id: tools\n    type: github\n    url: https://github.com/owner/tools\n    enabled: true\nprofiles: []\n');
    await mkdir(path.join(root, '.config/sources'), { recursive: true });
    await writeFile(path.join(root, '.config/sources/collection-index.yml'), 'schemaVersion: 1\ncollections:\n  test: {sourceId: tools}\n');
    const fs = new NodeFileSystem();
    const read = vi.spyOn(fs, 'readFile');
    const fetch = vi.fn().mockRejectedValue(new Error('Unexpected HTTP request'));
    const exec = vi.fn().mockRejectedValue(new Error('Unexpected subprocess'));
    const checks = createHubGovernanceSourceChecks(fs, path.join(root, 'hub-config.yml'), {
      fs, clock: { now: () => 0, nowIso: () => '1970-01-01T00:00:00.000Z' }, httpClient: { fetch }, processRunner: { exec }, fallbackTokenProviders: []
    });
    const inventory = await checks.collectionIndex.read();
    expect(inventory.registry?.owners.get('test')).toBe('tools');
    expect(read).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it('checks renamed IDs against a separately pinned registry and skips deleted collections in PR scope', async () => {
    const trusted = await mkdtemp(path.join(os.tmpdir(), 'trusted-collection-registry-'));
    try {
      await writeFile(path.join(trusted, 'hub-config.yml'), 'sources:\n  - id: tools\n    type: github\n    url: https://github.com/owner/tools\n    enabled: true\nprofiles: []\n');
      await mkdir(path.join(trusted, '.config/sources'), { recursive: true });
      await writeFile(path.join(trusted, '.config/sources/collection-index.yml'), 'schemaVersion: 1\ncollections:\n  test: {sourceId: tools}\n');
      git('init', '--quiet');
      git('config', 'user.name', 'Index Test');
      git('config', 'user.email', 'index@example.invalid');
      git('add', '-A');
      git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Base');
      const base = git('rev-parse', 'HEAD');
      await writeFile(path.join(root, 'collections/test.collection.yml'), 'id: renamed\nname: Test\nauthor: Test\nitems:\n  - path: test.prompt.md\n    kind: prompt\n');
      git('add', '-A');
      git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Rename');
      const head = git('rev-parse', 'HEAD');
      const request = {
        repoRoot: root, subject: 'collection' as const, checkSources: true, repository: 'owner/tools',
        config: path.join(trusted, 'hub-config.yml'), processRunner: new NodeArgvProcessRunner()
      };
      const renamed = await runGovernance(new NodeFileSystem(), { ...request, baseRef: base, headRef: head });
      expect(renamed.findings).toContainEqual(expect.objectContaining({ ruleId: 'COL004', verified: true, message: expect.stringContaining("'renamed' is not registered") }));
      await rm(path.join(root, 'collections/test.collection.yml'));
      git('add', '-A');
      git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Delete');
      const deleted = await runGovernance(new NodeFileSystem(), { ...request, baseRef: head, headRef: git('rev-parse', 'HEAD') });
      expect(deleted.verdict).toBe('pass');
      expect(deleted.findings).toEqual([]);
    } finally {
      await rm(trusted, { recursive: true, force: true });
    }
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
