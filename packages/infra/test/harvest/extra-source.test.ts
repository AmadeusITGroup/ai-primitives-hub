import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  parseExtraSource,
} from '../../src/harvest/extra-source';

describe('extra-source', () => {
  it('parses a minimal awesome-copilot-plugin source spec with defaults', () => {
    const s = parseExtraSource('id=upstream,type=awesome-copilot-plugin,url=https://github.com/github/awesome-copilot');
    expect(s.id).toBe('upstream');
    expect(s.name).toBe('upstream');
    expect(s.type).toBe('awesome-copilot-plugin');
    expect(s.owner).toBe('github');
    expect(s.repo).toBe('awesome-copilot');
    expect(s.branch).toBe('main');
    expect(s.pluginsPath).toBe('plugins');
  });

  it('honours explicit branch + name + pluginsPath overrides', () => {
    const s = parseExtraSource([
      'id=ac-dev',
      'name=Awesome Copilot (dev)',
      'type=awesome-copilot-plugin',
      'url=https://github.com/github/awesome-copilot',
      'branch=develop',
      'pluginsPath=experimental/plugins'
    ].join(','));
    expect(s.name).toBe('Awesome Copilot (dev)');
    expect(s.branch).toBe('develop');
    expect(s.pluginsPath).toBe('experimental/plugins');
  });

  it('supports github source type too (no pluginsPath default)', () => {
    const s = parseExtraSource('id=my-repo,type=github,url=https://github.com/o/r');
    expect(s.type).toBe('github');
    expect(s.pluginsPath).toBe(undefined);
  });

  it('rejects missing required fields (id, type, url) with a useful message', () => {
    expect(() => parseExtraSource('type=github,url=https://github.com/o/r')).toThrow(/missing field/iu);
    expect(() => parseExtraSource('id=a,url=https://github.com/o/r')).toThrow(/missing field/iu);
    expect(() => parseExtraSource('id=a,type=github')).toThrow(/missing field/iu);
  });

  it('rejects unsupported source types', () => {
    expect(
      () => parseExtraSource('id=a,type=bogus,url=https://github.com/o/r')
    ).toThrow(/unsupported source type/iu);
  });

  it('rejects non-GitHub URLs', () => {
    expect(
      () => parseExtraSource('id=a,type=github,url=https://gitlab.com/o/r')
    ).toThrow(/not a github url/iu);
  });
});
