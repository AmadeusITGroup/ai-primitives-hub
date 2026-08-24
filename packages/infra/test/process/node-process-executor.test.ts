import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  NodeProcessExecutor,
} from '../../src/process/node-process-executor';

describe('NodeProcessExecutor', () => {
  it('passes arguments literally without shell interpretation', async () => {
    const result = await new NodeProcessExecutor().execFile(
      process.execPath,
      ['-e', 'process.stdout.write(process.argv[1])', 'literal value; not a command']
    );

    expect(result.stdout).toBe('literal value; not a command');
  });

  it('merges environment values and strips dynamic-loader injection variables', async () => {
    const result = await new NodeProcessExecutor().execFile(
      process.execPath,
      ['-e', "process.stdout.write([process.env.FOO, process.env.LD_PRELOAD, process.env.DYLD_INSERT_LIBRARIES].join('|'))"],
      { env: { FOO: 'bar', LD_PRELOAD: '/unsafe.so', DYLD_INSERT_LIBRARIES: '/unsafe.dylib' } }
    );

    expect(result.stdout).toBe('bar||');
  });

  it('rejects when the executable exits non-zero', async () => {
    await expect(new NodeProcessExecutor().execFile(process.execPath, ['-e', 'process.exit(1)'])).rejects.toThrow();
  });
});
