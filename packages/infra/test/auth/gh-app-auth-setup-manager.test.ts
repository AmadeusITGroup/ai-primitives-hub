import type {
  ProcessExecutor,
  ProcessResult,
  ProcessRunOptions,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  GhAppAuthSetupManager,
} from '../../src/auth/gh-app-auth-setup-manager';

class RecordingExecutor implements ProcessExecutor {
  public file = '';
  public args: readonly string[] = [];
  public options: ProcessRunOptions | undefined;

  public async execFile(file: string, args: readonly string[], options?: ProcessRunOptions): Promise<ProcessResult> {
    this.file = file;
    this.args = args;
    this.options = options;
    return { stdout: '', stderr: '' };
  }
}

describe('GhAppAuthSetupManager', () => {
  it('invokes setup with sorted routes and an isolated config path', async () => {
    const executor = new RecordingExecutor();
    const manager = new GhAppAuthSetupManager({
      appId: '123',
      keyFile: '/run/secrets/app-key',
      configPath: '/tmp/gh-app-auth.yml',
      routes: ['github.com/Z-org/*', 'github.com/a-org/*'],
      processExecutor: executor
    });

    await manager.setup();

    expect(executor.file).toBe('gh');
    expect(executor.args).toEqual([
      'app-auth', 'setup',
      '--app-id', '123',
      '--key-file', '/run/secrets/app-key',
      '--patterns', 'github.com/a-org/*,github.com/Z-org/*',
      '--use-filesystem'
    ]);
    expect(executor.options).toEqual({
      env: { GH_APP_AUTH_CONFIG: '/tmp/gh-app-auth.yml' },
      timeoutMs: 120_000
    });
  });

  it('rejects an empty route set before spawning', async () => {
    const executor = new RecordingExecutor();
    const manager = new GhAppAuthSetupManager({
      appId: '123',
      configPath: '/tmp/config.yml',
      routes: [],
      processExecutor: executor
    });

    await expect(manager.setup()).rejects.toMatchObject({ code: 'GH_APP_AUTH_SETUP_ROUTES_MISSING' });
    expect(executor.file).toBe('');
  });
});
