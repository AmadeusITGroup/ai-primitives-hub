import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  BlobCache,
  computeGitBlobSha,
} from '../../src/harvest/blob-cache';
import {
  createTempDir,
} from '../helpers/temp-dir';

let tmp: string;
let cleanup: () => void;

beforeEach(() => {
  [tmp, cleanup] = createTempDir('pi-cache-');
});

afterEach(() => {
  cleanup();
});

describe('blob-cache', () => {
  it('computeGitBlobSha matches git plumbing sha1', () => {
    const bytes = Buffer.from('hello\n');
    expect(computeGitBlobSha(bytes)).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    expect(computeGitBlobSha(Buffer.from(''))).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });

  it('put then get round-trips bytes without a network call', async () => {
    const cache = new BlobCache(tmp);
    const bytes = Buffer.from('primitive content\n', 'utf8');
    const sha = computeGitBlobSha(bytes);
    await cache.put(sha, bytes);
    const out = await cache.get(sha);
    expect(out && out.equals(bytes)).toBe(true);
  });

  it('get returns undefined for unknown sha', async () => {
    const cache = new BlobCache(tmp);
    expect(await cache.get('0000000000000000000000000000000000000000')).toBe(undefined);
  });

  it('put rejects a sha that does not match the bytes (tamper guard)', async () => {
    const cache = new BlobCache(tmp);
    await expect(
      cache.put('deadbeef'.repeat(5), Buffer.from('anything'))
    ).rejects.toThrow(/sha mismatch/i);
  });

  it('getOrFetch returns cached bytes without invoking the fetcher', async () => {
    const cache = new BlobCache(tmp);
    const bytes = Buffer.from('cached', 'utf8');
    const sha = computeGitBlobSha(bytes);
    await cache.put(sha, bytes);
    let calls = 0;
    const out = await cache.getOrFetch(sha, async () => {
      calls += 1;
      return Buffer.from('should not be called');
    });
    expect(calls).toBe(0);
    expect(out.equals(bytes)).toBe(true);
  });

  it('getOrFetch populates the cache on first call', async () => {
    const cache = new BlobCache(tmp);
    const bytes = Buffer.from('fresh', 'utf8');
    const sha = computeGitBlobSha(bytes);
    const out1 = await cache.getOrFetch(sha, async () => bytes);
    expect(out1.equals(bytes)).toBe(true);
    const out2 = await cache.get(sha);
    expect(out2?.equals(bytes)).toBe(true);
  });

  it('stats() reports entry count and total size', async () => {
    const cache = new BlobCache(tmp);
    await cache.put(computeGitBlobSha(Buffer.from('a')), Buffer.from('a'));
    await cache.put(computeGitBlobSha(Buffer.from('bb')), Buffer.from('bb'));
    const s = await cache.stats();
    expect(s.entries).toBe(2);
    expect(s.bytes).toBe(3);
  });
});
