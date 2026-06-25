/**
 * Tests for the `doctor` command.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  createDoctorCommand,
  createDoctorCommandClass,
  DOCTOR_DIAGNOSTICS_COMMAND_CLASS,
} from '../../src/commands/doctor';
import {
  createTestContext,
  runCommand,
} from '../../src/framework';

const baseEnv = {
  PATH: '/usr/bin:/bin',
  PROMPT_REGISTRY_SKIP_NETWORK: '1'
};

const createMockFs = (cwd = '/tmp/doctor-test'): import('../../src/framework').FsAbstraction => ({
  readFile: async () => '',
  writeFile: async () => undefined,
  readJson: async <T>(): Promise<T> => ({} as T),
  writeJson: async () => undefined,
  exists: async (p) => p === cwd,
  mkdir: async () => undefined,
  readDir: async () => [],
  remove: async () => undefined
});

describe('doctor command', () => {
  it('runs all checks and produces a summary', async () => {
    const cwd = '/tmp/doctor-test';
    const ctx = createTestContext({ env: baseEnv, cwd, fs: createMockFs(cwd) });
    const result = await runCommand(['doctor'], {
      commandClasses: [createDoctorCommandClass(ctx)],
      context: { env: baseEnv, cwd, fs: createMockFs(cwd) }
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('node-version');
    expect(result.stdout).toContain('network-config');
    expect(result.stdout).toContain('github-cli');
    expect(result.stdout).toContain('summary:');
  });

  it('produces JSON output', async () => {
    const cwd = '/tmp/doctor-test';
    const ctx = createTestContext({ env: baseEnv, cwd, fs: createMockFs(cwd) });
    const result = await runCommand(['doctor', '-o', 'json'], {
      commandClasses: [createDoctorCommandClass(ctx)],
      context: { env: baseEnv, cwd, fs: createMockFs(cwd) }
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"node-version"');
    expect(result.stdout).toContain('"summary"');
  });

  it('command definition produces a health report', async () => {
    const cwd = '/tmp/doctor-test';
    const ctx = createTestContext({ env: baseEnv, cwd, fs: createMockFs(cwd) });
    const def = createDoctorCommand({ output: 'text' });
    const exitCode = await def.run({ ctx });
    expect(exitCode).toBe(0);
  });
});

describe('doctor diagnostics command', () => {
  it('is registered as a clipanion class', () => {
    expect(DOCTOR_DIAGNOSTICS_COMMAND_CLASS.paths).toContainEqual(['doctor', 'diagnostics']);
  });
});
