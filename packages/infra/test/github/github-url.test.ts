import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  buildApiUrl,
  buildRawContentUrl,
  buildReleaseAssetApiUrl,
  isGitHubHost,
  parseRepoSlug,
} from '../../src/github/url';

describe('github/url', () => {
  describe('buildApiUrl', () => {
    it('joins a path on the default api host', () => {
      expect(
        buildApiUrl('/repos/foo/bar/releases')
      ).toBe('https://api.github.com/repos/foo/bar/releases');
    });
    it('rejects a path missing leading slash', () => {
      expect(() => buildApiUrl('repos/foo')).toThrow(/leading slash/i);
    });
    it('rejects an absolute URL (caller passed wrong helper)', () => {
      expect(() => buildApiUrl('https://api.github.com/x')).toThrow(/absolute/i);
    });
    it('honours an explicit base override (GHE)', () => {
      expect(
        buildApiUrl('/repos/foo/bar', { base: 'https://ghe.example.com/api/v3' })
      ).toBe('https://ghe.example.com/api/v3/repos/foo/bar');
    });
  });

  describe('buildRawContentUrl', () => {
    it('builds a raw.githubusercontent URL', () => {
      expect(
        buildRawContentUrl({ owner: 'github', repo: 'awesome-copilot', ref: 'main', path: 'collections/foo.yml' })
      ).toBe('https://raw.githubusercontent.com/github/awesome-copilot/main/collections/foo.yml');
    });
    it('strips a leading slash from path', () => {
      expect(
        buildRawContentUrl({ owner: 'a', repo: 'b', ref: 'm', path: '/p/q.md' })
      ).toBe('https://raw.githubusercontent.com/a/b/m/p/q.md');
    });
    it('url-encodes ref containing slashes (e.g. release branch)', () => {
      expect(
        buildRawContentUrl({ owner: 'a', repo: 'b', ref: 'feature/x', path: 'p.md' })
      ).toBe('https://raw.githubusercontent.com/a/b/feature%2Fx/p.md');
    });
  });

  describe('buildReleaseAssetApiUrl', () => {
    it('returns the api.github.com asset URL', () => {
      expect(
        buildReleaseAssetApiUrl({ owner: 'a', repo: 'b', assetId: 12_345 })
      ).toBe('https://api.github.com/repos/a/b/releases/assets/12345');
    });
  });

  describe('isGitHubHost', () => {
    const cases: [string, boolean][] = [
      ['github.com', true],
      ['api.github.com', true],
      ['raw.githubusercontent.com', true],
      ['objects.githubusercontent.com', true],
      ['codeload.github.com', true],
      ['gist.github.com', true],
      ['ghe.example.com', false],
      ['evil.com', false],
      ['', false],
      ['githubusercontent.com', false],
      ['fakegithub.com', false]
    ];
    for (const [host, expected] of cases) {
      it(`${host} -> ${String(expected)}`, () => {
        expect(isGitHubHost(host)).toBe(expected);
      });
    }
  });

  describe('parseRepoSlug', () => {
    it('parses owner/repo', () => {
      expect(parseRepoSlug('github/awesome-copilot')).toStrictEqual({ owner: 'github', repo: 'awesome-copilot' });
    });
    it('strips https://github.com/ prefix', () => {
      expect(parseRepoSlug('https://github.com/foo/bar')).toStrictEqual({ owner: 'foo', repo: 'bar' });
    });
    it('strips trailing .git', () => {
      expect(parseRepoSlug('foo/bar.git')).toStrictEqual({ owner: 'foo', repo: 'bar' });
    });
    it('strips trailing slash', () => {
      expect(parseRepoSlug('foo/bar/')).toStrictEqual({ owner: 'foo', repo: 'bar' });
    });
    it('rejects malformed input', () => {
      expect(() => parseRepoSlug('not-a-slug')).toThrow(/malformed/i);
      expect(() => parseRepoSlug('')).toThrow(/malformed/i);
      expect(() => parseRepoSlug('foo')).toThrow(/malformed/i);
    });
  });
});
