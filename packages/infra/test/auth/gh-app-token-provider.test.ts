import type {
  GitHubRepositoryTarget,
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
  GhAppAuthError,
  GhAppTokenProvider,
} from '../../src/auth/gh-app-token-provider';

interface ProcessCall {
  file: string;
  args: readonly string[];
  options: ProcessRunOptions | undefined;
}

class FakeProcessExecutor implements ProcessExecutor {
  public readonly calls: ProcessCall[] = [];
  public outputs: string[] = ['installation-token'];
  public pending: Promise<ProcessResult> | undefined;

  public async execFile(file: string, args: readonly string[], options?: ProcessRunOptions): Promise<ProcessResult> {
    this.calls.push({ file, args, options });
    if (this.pending !== undefined) {
      return this.pending;
    }
    return {
      stdout: this.outputs.shift() ?? 'installation-token',
      stderr: ''
    };
  }
}

const target = (owner: string, repository: string): GitHubRepositoryTarget => ({
  host: 'github.com',
  owner,
  repository
});

const makeProvider = (executor: FakeProcessExecutor, now: () => number = () => 1000): GhAppTokenProvider =>
  new GhAppTokenProvider({
    appId: '123',
    configPath: '/tmp/isolated-gh-app-auth.yml',
    processExecutor: executor,
    now,
    cacheTtlMs: 500,
    timeoutMs: 10_000
  });

describe('GhAppTokenProvider', () => {
  it('does not invoke gh for a non-GitHub request host', async () => {
    const executor = new FakeProcessExecutor();
    const provider = makeProvider(executor);

    await expect(provider.getToken('example.com', target('owner', 'repo'))).resolves.toBeUndefined();
    expect(executor.calls).toHaveLength(0);
  });

  it('requires repository context for a GitHub request', async () => {
    const provider = makeProvider(new FakeProcessExecutor());

    await expect(provider.getToken('api.github.com')).rejects.toMatchObject({
      code: 'GH_APP_AUTH_REPOSITORY_CONTEXT_MISSING'
    });
  });

  it('invokes gh with exact argv, repository context, isolated config, and timeout', async () => {
    const executor = new FakeProcessExecutor();
    const provider = makeProvider(executor);

    await expect(provider.getToken('raw.githubusercontent.com', target('owner', 'repo'))).resolves.toBe('installation-token');

    expect(executor.calls).toEqual([{
      file: 'gh',
      args: ['app-auth', 'token', '--app-id', '123', '--repo', 'github.com/owner/repo'],
      options: {
        env: { GH_APP_AUTH_CONFIG: '/tmp/isolated-gh-app-auth.yml' },
        timeoutMs: 10_000
      }
    }]);
  });

  it('includes an optional installation id in the argv', async () => {
    const executor = new FakeProcessExecutor();
    const provider = new GhAppTokenProvider({
      clientId: 'Iv1.client',
      configPath: '/tmp/config.yml',
      installationId: 456,
      processExecutor: executor
    });

    await provider.getToken('github.com', target('owner', 'repo'));

    expect(executor.calls[0]?.args).toEqual([
      'app-auth', 'token', '--client-id', 'Iv1.client',
      '--repo', 'github.com/owner/repo', '--installation-id', '456'
    ]);
  });

  it('caches per exact repository and refreshes after the safety ttl', async () => {
    let now = 1000;
    const executor = new FakeProcessExecutor();
    executor.outputs = ['token-one', 'token-two', 'token-three'];
    const provider = makeProvider(executor, () => now);

    await expect(provider.getToken('api.github.com', target('owner', 'one'))).resolves.toBe('token-one');
    now = 1499;
    await expect(provider.getToken('api.github.com', target('owner', 'one'))).resolves.toBe('token-one');
    await expect(provider.getToken('api.github.com', target('owner', 'two'))).resolves.toBe('token-two');
    now = 1500;
    await expect(provider.getToken('api.github.com', target('owner', 'one'))).resolves.toBe('token-three');

    expect(executor.calls).toHaveLength(3);
  });

  it('single-flights concurrent requests for the same repository', async () => {
    let release!: (result: ProcessResult) => void;
    const pending = new Promise<ProcessResult>((resolve) => {
      release = resolve;
    });
    const executor = new FakeProcessExecutor();
    executor.pending = pending;
    const provider = makeProvider(executor);

    const first = provider.getToken('api.github.com', target('owner', 'repo'));
    const second = provider.getToken('raw.githubusercontent.com', target('owner', 'repo'));
    expect(executor.calls).toHaveLength(1);

    release({ stdout: 'shared-token\n', stderr: '' });
    await expect(Promise.all([first, second])).resolves.toEqual(['shared-token', 'shared-token']);
  });

  it.each([
    ['', 'GH_APP_AUTH_OUTPUT_INVALID'],
    ['   \n', 'GH_APP_AUTH_OUTPUT_INVALID'],
    ['one\ntwo\n', 'GH_APP_AUTH_OUTPUT_INVALID'],
    ['one\r\n', 'GH_APP_AUTH_OUTPUT_INVALID'],
    ['one\u0000two\n', 'GH_APP_AUTH_OUTPUT_INVALID']
  ])('rejects unsafe stdout %j with %s', async (stdout, code) => {
    const executor = new FakeProcessExecutor();
    executor.outputs = [stdout];
    const provider = makeProvider(executor);

    await expect(provider.getToken('github.com', target('owner', 'repo'))).rejects.toMatchObject({ code });
  });

  it('rejects invalid selector and config combinations before spawning', () => {
    expect(() => new GhAppTokenProvider({
      appId: '123',
      clientId: 'client',
      configPath: '/tmp/config.yml',
      processExecutor: new FakeProcessExecutor()
    })).toThrowError(GhAppAuthError);
    expect(() => new GhAppTokenProvider({
      appId: '123',
      processExecutor: new FakeProcessExecutor()
    })).toThrowError(GhAppAuthError);
  });

  it.each([
    [{ code: 'ENOENT' }, 'GH_APP_AUTH_CLI_UNAVAILABLE'],
    [{ message: 'configured route does not cover repository' }, 'GH_APP_AUTH_ROUTE_MISMATCH'],
    [{ message: 'no installation found for organization' }, 'GH_APP_AUTH_INSTALLATION_MISSING'],
    [{ code: 'ETIMEDOUT' }, 'GH_APP_AUTH_TIMEOUT'],
    [{ message: 'GitHub rejected the request' }, 'GH_APP_AUTH_MINT_FAILED']
  ])('maps process failure %j to %s', async (failure, code) => {
    const executor: ProcessExecutor = {
      execFile: () => Promise.reject(Object.assign(new Error('gh failed'), failure))
    };
    const provider = new GhAppTokenProvider({
      appId: '123',
      configPath: '/tmp/config.yml',
      processExecutor: executor
    });

    await expect(provider.getToken('github.com', target('owner', 'repo'))).rejects.toMatchObject({ code });
  });

  it('rejects an invalid repository target without invoking gh', async () => {
    const executor = new FakeProcessExecutor();
    const provider = makeProvider(executor);

    await expect(provider.getToken('github.com', {
      host: 'github.com',
      owner: 'owner/name',
      repository: 'repo'
    })).rejects.toMatchObject({ code: 'GH_APP_AUTH_REPOSITORY_INVALID' });
    expect(executor.calls).toHaveLength(0);
  });
});
