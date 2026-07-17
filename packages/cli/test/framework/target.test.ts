/**
 * Tests for `framework/target.ts`.
 *
 * Target resolution helpers (`loadTargets`, `findProjectLockfile`,
 * `lockfilePathForTarget`) route through the `app` and `infra` layers.
 * These tests use a real `NodeFileSystem` and temporary directories to
 * verify the wiring without in-memory doubles.
 */
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getLockfilePathForMode,
} from '@ai-primitives-hub/app';
import {
  NodeFileSystem,
} from '@ai-primitives-hub/infra';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  createTestContext,
  findProjectLockfile,
  loadTargets,
  lockfilePathForTarget,
} from '../../src/framework';

const makeTarget = (name: string, type: 'vscode' | 'copilot-cli' | 'kiro', scope: 'user' | 'workspace' | 'repository' = 'user'): import('@ai-primitives-hub/core').Target => ({
  name,
  type,
  scope
});

describe('loadTargets', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'cli-target-test-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('loads targets from the nearest project config', async () => {
    await writeFile(
      path.join(workspace, 'ai-primitives-hub.yml'),
      'targets:\n  - name: copilot\n    type: copilot-cli\n    scope: user\n'
    );
    const ctx = createTestContext({ fs: new NodeFileSystem(), cwd: workspace });
    const targets = await loadTargets(ctx);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.name).toBe('copilot');
  });

  it('returns an empty array when no project config or user config exists', async () => {
    const ctx = createTestContext({
      fs: new NodeFileSystem(),
      cwd: workspace,
      env: { XDG_CONFIG_HOME: path.join(workspace, '.config') }
    });
    const targets = await loadTargets(ctx);
    expect(targets).toEqual([]);
  });
});

describe('findProjectLockfile', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'cli-lockfile-test-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('finds a project lockfile in cwd', async () => {
    const lockfile = path.join(workspace, 'prompt-registry.lock.json');
    await writeFile(lockfile, '{}');
    const ctx = createTestContext({ fs: new NodeFileSystem(), cwd: workspace });
    const found = await findProjectLockfile(ctx);
    expect(found).toBe(lockfile);
  });

  it('walks upward to find a lockfile', async () => {
    const nested = path.join(workspace, 'packages', 'cli');
    await mkdir(nested, { recursive: true });
    const lockfile = path.join(workspace, 'prompt-registry.lock.json');
    await writeFile(lockfile, '{}');
    const ctx = createTestContext({ fs: new NodeFileSystem(), cwd: nested });
    const found = await findProjectLockfile(ctx);
    expect(found).toBe(lockfile);
  });

  it('returns null when no lockfile is found', async () => {
    const ctx = createTestContext({
      fs: new NodeFileSystem(),
      cwd: workspace,
      env: { XDG_CONFIG_HOME: path.join(workspace, '.config') }
    });
    const found = await findProjectLockfile(ctx);
    expect(found).toBeNull();
  });
});

describe('lockfilePathForTarget', () => {
  it('returns the user lockfile for non-repository scopes', () => {
    const ctx = createTestContext({ env: { XDG_CONFIG_HOME: '/home/user/.config' } });
    const target = makeTarget('copilot', 'copilot-cli', 'user');
    expect(lockfilePathForTarget(ctx, target)).toBe('/home/user/.config/ai-primitives-hub/ai-primitives-hub.lock.json');
  });

  it('uses the repository lockfile path for repository scope', () => {
    const ctx = createTestContext({ cwd: '/workspace' });
    const target = makeTarget('vscode', 'vscode', 'repository');
    expect(lockfilePathForTarget(ctx, target)).toBe(getLockfilePathForMode('/workspace', 'commit'));
  });

  it('honors the commitMode override for repository scope', () => {
    const ctx = createTestContext({ cwd: '/workspace' });
    const target = makeTarget('vscode', 'vscode', 'repository');
    expect(lockfilePathForTarget(ctx, target, 'local-only')).toBe(getLockfilePathForMode('/workspace', 'local-only'));
  });
});
