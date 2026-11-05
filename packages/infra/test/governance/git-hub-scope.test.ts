import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  parseHubScopeFile,
  readGitHubScope,
} from '../../src/governance/git-hub-scope';

const baseRef = 'a'.repeat(40);
const headRef = 'b'.repeat(40);
const mergeBase = 'c'.repeat(40);
describe('Git Hub scope boundary', () => {
  it('uses merge-base and explicit head blobs with safe argument vectors', async () => {
    const execFile = vi.fn((_file: string, args: readonly string[]) => {
      let stdout = args.at(-1)?.includes(':') ? 'blob' : 'commit';
      if (args.includes('merge-base')) {
        stdout = mergeBase;
      }
      if (args.includes('blob')) {
        stdout = 'sources: []\nprofiles: []\n';
      }
      return Promise.resolve({ stdout, stderr: '' });
    });
    const result = await readGitHubScope({ execFile }, '/repo', 'configs/hub.yml', baseRef, headRef);
    expect(result.mergeBase).toBe(mergeBase);
    expect(execFile.mock.calls.map((call) => call[1].at(-1))).toContain(`${headRef}:configs/hub.yml`);
    expect(execFile.mock.calls.map((call) => call[1].at(-1))).toContain(`${mergeBase}:configs/hub.yml`);
    expect(execFile.mock.calls.every(([file]) => file === 'git')).toBe(true);
  });
  it.each(['main', '-x', 'a'.repeat(39), 'a'.repeat(41), '$(touch bad)'])('rejects unsafe/non-exact ref %s before running git', async (ref) => {
    const execFile = vi.fn();
    await expect(readGitHubScope({ execFile }, '/repo', 'hub.yml', ref, headRef)).rejects.toThrow(/exact/);
    expect(execFile).not.toHaveBeenCalled();
  });
  it.each(['../hub.yml', '/hub.yml', 'a:b', 'a\\b', 'a/./b'])('rejects unsafe paths %s', async (file) => {
    await expect(readGitHubScope({ execFile: vi.fn() }, '/repo', file, baseRef, headRef)).rejects.toThrow(/relative/);
  });
  it('fails closed for missing history without reading checkout data', async () => {
    await expect(readGitHubScope({ execFile: vi.fn().mockRejectedValue(new Error('missing')) }, '/repo', 'hub.yml', baseRef, headRef)).rejects.toThrow(/no checkout fallback/);
  });
  it('accepts 64-hex object IDs and rejects multiple merge bases', async () => {
    const execFile = vi.fn(async (_file: string, args: readonly string[]) => ({ stdout: args.includes('merge-base') ? `${'c'.repeat(64)}\n${'d'.repeat(64)}` : 'commit', stderr: '' }));
    await expect(readGitHubScope({ execFile }, '/repo', 'hub.yml', 'a'.repeat(64), 'b'.repeat(64))).rejects.toThrow(/history/);
    expect(execFile).toHaveBeenCalledTimes(3);
  });
  it.each([
    '{}', 'null', '{"schemaVersion":2,"sourceIds":[],"profileIds":[]}',
    '{"schemaVersion":1,"sourceIds":["a","a"],"profileIds":[]}',
    '{"schemaVersion":1,"sourceIds":[],"profileIds":[],"sourceId":[]}'
  ])('rejects malformed scope file %s', (content) => expect(() => parseHubScopeFile(content)).toThrow());
});
