/**
 * Tests for `framework/error.ts`.
 *
 * These helpers format and route RegistryError values through the Context
 * streams and encapsulate common target/hub resolution logic.
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
  failWith,
  generateTargetHint,
  getCommandContext,
  RegistryError,
  renderError,
  requireActiveHub,
  requireActiveHubOrFail,
  resolveTarget,
  resolveTargetName,
  throwTargetNotFoundError,
  validateInputs,
} from '../../src/framework';

describe('renderError', () => {
  it('writes a RegistryError to stderr with code, message, hint, and docs', () => {
    const ctx = createTestContext();
    const err = new RegistryError({
      code: 'USAGE.MISSING_FLAG',
      message: 'missing flag',
      hint: 'pass --target',
      docsUrl: 'https://example.com'
    });
    renderError(err, ctx);
    expect(ctx.stderr.captured()).toContain('error[USAGE.MISSING_FLAG]: missing flag');
    expect(ctx.stderr.captured()).toContain('pass --target');
    expect(ctx.stderr.captured()).toContain('https://example.com');
  });

  it('wraps non-RegistryError values as INTERNAL.UNEXPECTED', () => {
    const ctx = createTestContext();
    renderError('raw string', ctx);
    expect(ctx.stderr.captured()).toContain('error[INTERNAL.UNEXPECTED]: raw string');
  });
});

describe('failWith', () => {
  it('returns 1 and renders to stderr in text mode', () => {
    const ctx = createTestContext();
    const err = new RegistryError({
      code: 'BUNDLE.NOT_FOUND',
      message: 'not found'
    });
    const code = failWith(ctx, 'text', 'install', err);
    expect(code).toBe(1);
    expect(ctx.stderr.captured()).toContain('BUNDLE.NOT_FOUND');
  });

  it('returns 1 and emits a structured JSON error envelope', () => {
    const ctx = createTestContext();
    const err = new RegistryError({
      code: 'BUNDLE.NOT_FOUND',
      message: 'not found'
    });
    const code = failWith(ctx, 'json', 'install', err);
    expect(code).toBe(1);
    const envelope = JSON.parse(ctx.stdout.captured()) as { status: string; errors: unknown[] };
    expect(envelope.status).toBe('error');
    expect(envelope.errors).toHaveLength(1);
  });
});

describe('generateTargetHint', () => {
  it('lists multiple configured targets', () => {
    const hint = generateTargetHint([{ name: 'copilot' }, { name: 'kiro' }]);
    expect(hint).toContain('copilot, kiro');
    expect(hint).toContain('--target');
  });

  it('prompts to add a target when none exist', () => {
    const hint = generateTargetHint([]);
    expect(hint).toContain('target add');
  });
});

describe('throwTargetNotFoundError', () => {
  it('throws a USAGE.MISSING_FLAG RegistryError', () => {
    expect(() => throwTargetNotFoundError('install', 'missing', [])).toThrow(RegistryError);
  });
});

describe('resolveTargetName', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'cli-error-test-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('returns the provided target name when present', async () => {
    const result = await resolveTargetName('copilot', 'install', createTestContext(), () => Promise.resolve([]));
    expect(result).toBe('copilot');
  });

  it('falls back to the last used target from the project state file', async () => {
    const stateDir = path.join(workspace, '.ai-primitives-hub');
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, 'target-state.json'),
      JSON.stringify({
        targets: {
          copilot: { targetName: 'copilot', lastInstalledBundles: [], lastUsedAt: '2026-01-01T00:00:00Z' }
        }
      })
    );
    const ctx = createTestContext({ fs: new NodeFileSystem(), cwd: workspace });
    const result = await resolveTargetName(undefined, 'install', ctx, () => Promise.resolve([]));
    expect(result).toBe('copilot');
  });

  it('throws USAGE.MISSING_FLAG when no target and no last used target exists', async () => {
    const ctx = createTestContext({ fs: new NodeFileSystem(), cwd: workspace });
    await expect(resolveTargetName(undefined, 'install', ctx, () => Promise.resolve([]))).rejects.toThrow(RegistryError);
  });
});

describe('resolveTarget', () => {
  it('returns the matching target', async () => {
    const target = { name: 'copilot', type: 'copilot-cli' as const };
    const result = await resolveTarget('copilot', 'install', createTestContext(), () => Promise.resolve([target]));
    expect(result).toEqual(target);
  });

  it('throws when the target is not configured', async () => {
    await expect(resolveTarget('missing', 'install', createTestContext(), () => Promise.resolve([]))).rejects.toThrow(RegistryError);
  });
});

describe('validateInputs', () => {
  it('flags missing string and boolean flags', () => {
    const result = validateInputs({ target: '', source: 'foo', interactive: true, verbose: false }, {
      flags: ['target', 'source', 'interactive', 'verbose']
    });
    expect(result.target).toBe(true);
    expect(result.source).toBe(false);
    expect(result.interactive).toBe(false);
    expect(result.verbose).toBe(true);
  });

  it('flags missing flags of any type', () => {
    const result = validateInputs({ name: undefined }, { flags: ['name'] });
    expect(result.name).toBe(true);
  });
});

describe('getCommandContext', () => {
  it('returns the context from a command instance', () => {
    const ctx = createTestContext();
    const cmd = { commandContext: { ctx } };
    expect(getCommandContext(cmd)).toBe(ctx);
  });

  it('throws when no context is available', () => {
    expect(() => getCommandContext({})).toThrow('CommandContext not available');
  });
});

describe('requireActiveHub', () => {
  it('returns the active hub when the id matches', async () => {
    const mgr = { getActiveHub: () => Promise.resolve({ id: 'hub-1', config: { url: 'x' } }) };
    const result = await requireActiveHub(mgr, 'hub-1', 'sync');
    expect(result.id).toBe('hub-1');
  });

  it('throws HUB.NOT_FOUND when no hub is active', async () => {
    const mgr = { getActiveHub: () => Promise.resolve(null) };
    await expect(requireActiveHub(mgr, 'hub-1', 'sync')).rejects.toThrow(RegistryError);
  });

  it('throws HUB.NOT_FOUND when the requested hub is not active', async () => {
    const mgr = { getActiveHub: () => Promise.resolve({ id: 'hub-2', config: {} }) };
    await expect(requireActiveHub(mgr, 'hub-1', 'sync')).rejects.toThrow(RegistryError);
  });
});

describe('requireActiveHubOrFail', () => {
  it('returns the active hub when the id matches', async () => {
    const ctx = createTestContext();
    const mgr = { getActiveHub: () => Promise.resolve({ id: 'hub-1', config: { url: 'x' } }) };
    const result = await requireActiveHubOrFail(mgr, 'hub-1', 'sync', ctx, 'text');
    expect(result).toEqual({ id: 'hub-1', config: { url: 'x' } });
  });

  it('returns exit code 1 via failWith when no hub is active', async () => {
    const ctx = createTestContext();
    const mgr = { getActiveHub: () => Promise.resolve(null) };
    const result = await requireActiveHubOrFail(mgr, 'hub-1', 'sync', ctx, 'text');
    expect(result).toBe(1);
    expect(ctx.stderr.captured()).toContain('no active hub');
  });
});
