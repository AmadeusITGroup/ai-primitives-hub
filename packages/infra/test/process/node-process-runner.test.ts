/**
 * Exercises NodeProcessRunner against real spawned processes rather than
 * mocking `node:child_process` - proves the actual env-merging/stripping
 * and cwd/timeout wiring, not just that the right mock was called.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  NodeProcessRunner,
} from '../../src/process/node-process-runner';

describe('NodeProcessRunner', () => {
  it('resolves with stdout/stderr for a successful command', async () => {
    const result = await new NodeProcessRunner().exec('echo hello');
    expect(result.stdout.trim()).toBe('hello');
  });

  it('rejects when the command exits non-zero', async () => {
    await expect(new NodeProcessRunner().exec('exit 1')).rejects.toThrow();
  });

  it('runs the command in the requested working directory', async () => {
    const result = await new NodeProcessRunner().exec('pwd', { cwd: '/tmp' });
    expect(result.stdout.trim()).toBe('/tmp');
  });

  it('merges caller-supplied env vars on top of the current process env, preserving PATH', async () => {
    const result = await new NodeProcessRunner().exec(
      'node -e "process.stdout.write((process.env.FOO || \'\') + \'|\' + (process.env.PATH ? \'has-path\' : \'no-path\'))"',
      { env: { FOO: 'bar' } }
    );
    expect(result.stdout).toBe('bar|has-path');
  });

  it('strips LD_PRELOAD and DYLD_INSERT_LIBRARIES even if explicitly requested', async () => {
    const result = await new NodeProcessRunner().exec(
      'node -e "process.stdout.write((process.env.LD_PRELOAD || \'unset\') + \'|\' + (process.env.DYLD_INSERT_LIBRARIES || \'unset\'))"',
      { env: { LD_PRELOAD: '/malicious.so', DYLD_INSERT_LIBRARIES: '/malicious.dylib' } }
    );
    expect(result.stdout).toBe('unset|unset');
  });

  it('rejects once the timeout elapses', async () => {
    await expect(new NodeProcessRunner().exec('sleep 5', { timeoutMs: 50 })).rejects.toThrow();
  });
});
