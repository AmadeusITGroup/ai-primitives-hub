import {
  execFileSync,
} from 'node:child_process';
import {
  mkdtemp,
  readFile,
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
  HubValidateCommand,
} from '../../src/commands/hub';
import {
  createTestContext,
  runCli,
} from '../../src/framework';

describe('released CLI scoped Hub governance', () => {
  let root: string;
  const fetch = vi.fn().mockRejectedValue(new Error('No network permitted'));
  const run = async (args: string[]) => {
    const ctx = createTestContext({ cwd: root, fs: new NodeFileSystem(), env: {} });
    const exitCode = await runCli(['hub', 'validate', ...args, '-o', 'json'], {
      ctx, name: 'ai-primitives-hub', version: 'test', commands: [], commandClasses: [HubValidateCommand], http: { fetch }, tokens: { getToken: () => Promise.resolve(undefined) }
    });
    return { exitCode, stdout: ctx.stdout.captured(), stderr: ctx.stderr.captured() };
  };
  beforeEach(async () => {
    fetch.mockClear();
    root = await mkdtemp(path.join(os.tmpdir(), 'cli-hub-scope-'));
    await writeFile(path.join(root, 'hub-config.yml'), JSON.stringify({ version: '1.0.0', metadata: { name: 'Hub', description: 'Hub', maintainer: 'Test', updatedAt: '2026-01-01T00:00:00Z' },
      sources: [{ id: 'a', type: 'github', url: 'https://github.com/owner/a', enabled: true, priority: 0 }, { id: 'bad-baseline', type: 'invalid', enabled: true, priority: 0 }], profiles: [] }));
    await writeFile(path.join(root, 'scope.json'), JSON.stringify({ schemaVersion: 1, sourceIds: ['a'], profileIds: [] }));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it('selects strict scope-file IDs and writes a scope-aware report', async () => {
    const result = await run(['--governance', '--scope-file', 'scope.json', '--report-path', 'report.md']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({ verdict: 'pass', scope: { schemaVersion: 1, origin: 'file', sourceIds: ['a'] } });
    expect(await readFile(path.join(root, 'report.md'), 'utf8')).toContain('PR scope');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps full audit behavior unchanged when scope flags are omitted', async () => {
    const result = await run(['--governance']);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).data.scope).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('recognizes exact-ref interface and fails closed on missing local history', async () => {
    const result = await run(['--governance', '--base-ref', 'a'.repeat(40), '--head-ref', 'b'.repeat(40)]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).data.findings).toContainEqual(expect.objectContaining({ ruleId: 'HUB001', message: expect.stringContaining('no checkout fallback') }));
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reads committed merge-base/head data rather than dirty checkout content', async () => {
    const git = (...args: string[]) => execFileSync('git', args, {
      cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
    }).trim();
    git('init', '--quiet');
    git('config', 'user.name', 'Scope Test');
    git('config', 'user.email', 'scope@example.invalid');
    git('add', 'hub-config.yml');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Base');
    const base = git('rev-parse', 'HEAD');
    const head = JSON.parse(await readFile(path.join(root, 'hub-config.yml'), 'utf8'));
    head.sources[0].priority = 1;
    await writeFile(path.join(root, 'hub-config.yml'), JSON.stringify(head));
    git('add', 'hub-config.yml');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Change source');
    const headRef = git('rev-parse', 'HEAD');
    await writeFile(path.join(root, 'hub-config.yml'), 'not valid hub configuration');
    const result = await run(['--governance', '--base-ref', base, '--head-ref', headRef]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data.scope).toMatchObject({ origin: 'git', mergeBase: base, sourceIds: ['a'], sources: { modified: ['a'] } });
    const noOp = await run(['--governance', '--base-ref', headRef, '--head-ref', headRef, '--check-sources']);
    expect(noOp.exitCode).toBe(0);
    expect(JSON.parse(noOp.stdout).data.scope.noOp).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    ['--base-ref', 'main', '--head-ref', 'HEAD'], ['--base-ref', 'a'.repeat(40)],
    ['--scope-file', 'scope.json', '--base-ref', 'a'.repeat(40), '--head-ref', 'b'.repeat(40)]
  ])('rejects invalid scope options %s', async (...args: string[]) => {
    const result = await run(['--governance', ...args]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).data.verdict).toBe('fail');
  });
  it('requires explicit governance opt-in for scope', async () => {
    const result = await run(['--scope-file', 'scope.json']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--governance');
  });
  it('validates thresholds even when explicit scope is empty', async () => {
    await writeFile(path.join(root, 'scope.json'), JSON.stringify({ schemaVersion: 1, sourceIds: [], profileIds: [] }));
    const result = await run(['--governance', '--scope-file', 'scope.json', '--min-score', 'NaN', '--check-sources']);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).data.findings).toContainEqual(expect.objectContaining({ ruleId: 'CFG004' }));
    expect(fetch).not.toHaveBeenCalled();
  });
});
