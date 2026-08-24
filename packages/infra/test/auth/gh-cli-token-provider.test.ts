import {
  describe,
  expect,
  it,
} from 'vitest';
import type {
  AuthEvent,
} from '../../src/auth/auth-event';
import {
  GhCliTokenProvider,
} from '../../src/auth/gh-cli-token-provider';

describe('GhCliTokenProvider', () => {
  it('returns the trimmed stdout when gh auth token succeeds', async () => {
    const provider = new GhCliTokenProvider(async () => ({ stdout: '  gho_abc123\n' }));
    await expect(provider.getToken('github.com')).resolves.toBe('gho_abc123');
  });

  it('returns undefined when gh auth token exits non-zero (not installed or not authenticated)', async () => {
    const provider = new GhCliTokenProvider(() => Promise.reject(new Error('command not found: gh')));
    await expect(provider.getToken('github.com')).resolves.toBeUndefined();
  });

  it('returns undefined when gh auth token succeeds but prints nothing', async () => {
    const provider = new GhCliTokenProvider(async () => ({ stdout: '   \n' }));
    await expect(provider.getToken('github.com')).resolves.toBeUndefined();
  });

  it('invokes exactly the gh auth token command', async () => {
    const seenCommands: string[] = [];
    const provider = new GhCliTokenProvider((command) => {
      seenCommands.push(command);
      return Promise.resolve({ stdout: 'token' });
    });
    await provider.getToken('github.com');
    expect(seenCommands).toEqual(['gh auth token']);
  });

  it('accepts any GitHub-owned host (api, raw content) without changing behavior', async () => {
    const provider = new GhCliTokenProvider(async () => ({ stdout: 'gho_abc123' }));
    await expect(provider.getToken('api.github.com')).resolves.toBe('gho_abc123');
    await expect(provider.getToken('raw.githubusercontent.com')).resolves.toBe('gho_abc123');
  });

  it('returns undefined without shelling out for a non-GitHub host', async () => {
    const seenCommands: string[] = [];
    const provider = new GhCliTokenProvider((command) => {
      seenCommands.push(command);
      return Promise.resolve({ stdout: 'gho_abc123' });
    });
    await expect(provider.getToken('example.com')).resolves.toBeUndefined();
    expect(seenCommands).toEqual([]);
  });
});

describe('GhCliTokenProvider auth events', () => {
  const capture = (): { events: AuthEvent[]; handler: (event: AuthEvent) => void } => {
    const events: AuthEvent[] = [];
    return { events, handler: (event) => events.push(event) };
  };

  it('declares the gh-cli origin', () => {
    expect(new GhCliTokenProvider().origin).toBe('gh-cli');
  });

  it('reports an attempt then a resolution carrying the token type', async () => {
    const { events, handler } = capture();
    const provider = new GhCliTokenProvider(async () => ({ stdout: 'gho_abc123\n' }), handler);

    await provider.getToken('api.github.com');

    expect(events.map((event) => event.kind)).toEqual(['attempt', 'resolved']);
    expect(events[1]).toMatchObject({ kind: 'resolved', origin: 'gh-cli', tokenType: 'gho_' });
  });

  it('distinguishes gh not being installed', async () => {
    const { events, handler } = capture();
    const failure = Object.assign(new Error('/bin/sh: gh: command not found'), { code: 127 });
    const provider = new GhCliTokenProvider(() => Promise.reject(failure), handler);

    await expect(provider.getToken('github.com')).resolves.toBeUndefined();
    expect(events.at(-1)).toMatchObject({ kind: 'failed', reason: 'gh-not-installed' });
  });

  it('distinguishes gh being installed but logged out', async () => {
    const { events, handler } = capture();
    const failure = Object.assign(new Error('gh: To get started with GitHub CLI, please run: gh auth login'), { code: 1 });
    const provider = new GhCliTokenProvider(() => Promise.reject(failure), handler);

    await expect(provider.getToken('github.com')).resolves.toBeUndefined();
    expect(events.at(-1)).toMatchObject({ kind: 'failed', reason: 'gh-not-authenticated' });
  });

  it('distinguishes a gh timeout', async () => {
    const { events, handler } = capture();
    const failure = Object.assign(new Error('Command failed: gh auth token'), { killed: true, signal: 'SIGTERM' });
    const provider = new GhCliTokenProvider(() => Promise.reject(failure), handler);

    await expect(provider.getToken('github.com')).resolves.toBeUndefined();
    expect(events.at(-1)).toMatchObject({ kind: 'failed', reason: 'gh-timeout' });
  });

  it('distinguishes gh succeeding but printing nothing', async () => {
    const { events, handler } = capture();
    const provider = new GhCliTokenProvider(async () => ({ stdout: '  \n' }), handler);

    await expect(provider.getToken('github.com')).resolves.toBeUndefined();
    expect(events.at(-1)).toMatchObject({ kind: 'skipped', reason: 'gh-empty-output' });
  });

  it('reports non-github-host without shelling out or reporting an attempt', async () => {
    const { events, handler } = capture();
    const provider = new GhCliTokenProvider(async () => ({ stdout: 'gho_abc123' }), handler);

    await provider.getToken('example.com');

    expect(events.map((event) => event.kind)).toEqual(['skipped']);
    expect(events[0]).toMatchObject({ reason: 'non-github-host' });
  });

  it('never places token material in an event', async () => {
    const { events, handler } = capture();
    const provider = new GhCliTokenProvider(async () => ({ stdout: 'gho_SuperSecretMaterial' }), handler);

    await provider.getToken('github.com');

    expect(JSON.stringify(events)).not.toContain('SuperSecretMaterial');
  });
});
