import {
  describe,
  expect,
  it,
} from 'vitest';
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
