/**
 * Tests for `framework/test-context.ts`.
 *
 * `createTestContext` is the hermetic fixture factory most command tests
 * rely on. Verify it defaults to an isolated in-memory environment and
 * exposes the captured output / exit code accessors the golden-test runner
 * consumes.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  createProductionContext,
  createTestContext,
  type FsAbstraction,
  isTestContext,
} from '../../src/framework';

describe('createTestContext', () => {
  it('defaults to an isolated, empty environment and cwd "/"', () => {
    const ctx = createTestContext();
    expect(ctx.cwd()).toBe('/');
    expect(ctx.env).toEqual({});
    expect(ctx.colorDepth).toBe(0);
  });

  it('captures stdout/stderr writes', () => {
    const ctx = createTestContext();
    ctx.stdout.write('hello stdout\n');
    ctx.stderr.write('hello stderr\n');
    expect(ctx.stdout.captured()).toBe('hello stdout\n');
    expect(ctx.stderr.captured()).toBe('hello stderr\n');
  });

  it('records the first exit code and defaults to 0', () => {
    const ctx = createTestContext();
    expect(ctx.exitCode()).toBe(0);
    ctx.exit(7);
    expect(ctx.exitCode()).toBe(7);
    ctx.exit(3); // first wins
    expect(ctx.exitCode()).toBe(7);
  });

  it('respects overrides for stdin, clock, env, and cwd', () => {
    const ctx = createTestContext({
      stdin: 'piped',
      now: 1_234_567_890_000,
      env: { FOO: 'bar' },
      cwd: '/workspace'
    });
    expect(ctx.stdin.read()).toBe('piped');
    expect(ctx.clock.now()).toBe(1_234_567_890_000);
    expect(ctx.clock.nowIso()).toBe(new Date(1_234_567_890_000).toISOString());
    ctx.clock.advance(1000);
    expect(ctx.clock.now()).toBe(1_234_567_891_000);
    expect(ctx.env).toEqual({ FOO: 'bar' });
    expect(ctx.cwd()).toBe('/workspace');
  });

  it('freezes env so tests cannot accidentally mutate shared state', () => {
    const ctx = createTestContext({ env: { FOO: 'bar' } });
    expect(() => {
      (ctx.env as Record<string, string>).FOO = 'baz';
    }).toThrow();
  });

  it('stubs fs and net so callers get descriptive errors', async () => {
    const ctx = createTestContext();
    await expect(ctx.fs.readFile('/foo')).rejects.toThrow('fs not wired yet');
    await expect(ctx.net.fetch('https://example.com')).rejects.toThrow('net not wired yet');
  });

  it('can accept a custom fs implementation', async () => {
    const customFs: FsAbstraction = {
      readFile: (): Promise<string> => Promise.resolve('custom'),
      exists: (): Promise<boolean> => Promise.resolve(false),
      readJson: <T>(): Promise<T> => Promise.resolve(JSON.parse('{}') as T),
      writeFile: (): Promise<void> => Promise.resolve(),
      writeJson: (): Promise<void> => Promise.resolve(),
      mkdir: (): Promise<void> => Promise.resolve(),
      readDir: (): Promise<string[]> => Promise.resolve([]),
      readDirEntries: (): Promise<{ name: string; isDirectory: boolean }[]> => Promise.resolve([]),
      stat: (): Promise<{ isFile: boolean; isDirectory: boolean; size: number; mtimeMs: number }> => Promise.resolve({
        isFile: false,
        isDirectory: false,
        size: 0,
        mtimeMs: 0
      }),
      remove: (): Promise<void> => Promise.resolve()
    };
    const ctx = createTestContext({ fs: customFs });
    expect(await ctx.fs.readFile('/foo')).toBe('custom');
  });
});

describe('isTestContext', () => {
  it('returns true for a test context', () => {
    expect(isTestContext(createTestContext())).toBe(true);
  });

  it('returns false for a production context', () => {
    const ctx = createProductionContext({ cwd: '/tmp' });
    expect(isTestContext(ctx)).toBe(false);
  });
});
