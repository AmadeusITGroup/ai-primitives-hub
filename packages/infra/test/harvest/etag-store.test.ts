import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  EtagStore,
} from '../../src/harvest/etag-store';
import {
  createTempDir,
} from '../helpers/temp-dir';

let tmp: string;
let cleanup: () => void;
beforeEach(() => {
  [tmp, cleanup] = createTempDir('pi-etag-');
});
afterEach(() => {
  cleanup();
});

describe('etag-store', () => {
  it('round-trips values across open/close', async () => {
    const file = path.join(tmp, 'etags.json');
    const s1 = await EtagStore.open(file);
    expect(s1.get('https://api.github.com/repos/a/b/commits/main')).toBe(undefined);
    await s1.set('https://api.github.com/repos/a/b/commits/main', '"abc-1"');
    await s1.save();

    const s2 = await EtagStore.open(file);
    expect(
      s2.get('https://api.github.com/repos/a/b/commits/main')
    ).toBe('"abc-1"');
  });

  it('handles corrupt file by resetting to empty (resilience)', async () => {
    const file = path.join(tmp, 'etags.json');
    fs.writeFileSync(file, '{bogus', 'utf8');
    const s = await EtagStore.open(file);
    expect(s.get('any')).toBe(undefined);
    await s.set('any', 'tag');
    await s.save();
    const reopened = await EtagStore.open(file);
    expect(reopened.get('any')).toBe('tag');
  });

  it('delete + clear remove entries', async () => {
    const s = await EtagStore.open(path.join(tmp, 'e.json'));
    await s.set('a', 'x');
    await s.set('b', 'y');
    s.delete('a');
    expect(s.get('a')).toBe(undefined);
    expect(s.get('b')).toBe('y');
    s.clear();
    expect(s.get('b')).toBe(undefined);
  });
});
