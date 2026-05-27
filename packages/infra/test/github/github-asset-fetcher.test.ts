import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  AssetFetcher,
} from '../../src/github/asset-fetcher';
import type {
  FetchLike,
} from '../../src/github/client';
import {
  staticTokenProvider,
} from '../../src/github/token';

interface Step {
  status: number;
  body?: Uint8Array;
  headers?: Record<string, string>;
}

const fakeFetch = (steps: Step[]): { fetch: FetchLike; calls: Request[] } => {
  const calls: Request[] = [];
  let i = 0;
  const fetch: FetchLike = (req: Request): Promise<Response> => {
    calls.push(req);
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    return Promise.resolve(new Response(step.body ?? new Uint8Array(), {
      status: step.status,
      headers: step.headers ?? {}
    }));
  };
  return { fetch, calls };
};

const newFetcher = (steps: Step[]): { fetcher: AssetFetcher; calls: Request[] } => {
  const { fetch, calls } = fakeFetch(steps);
  const fetcher = new AssetFetcher({
    tokens: staticTokenProvider('tok'),
    fetch,
    sleep: () => Promise.resolve(),
    backoffBaseMs: 1,
    jitterMs: 0
  });
  return { fetcher, calls };
};

describe('github/asset-fetcher AssetFetcher', () => {
  describe('Accept header switching (I-012)', () => {
    it('uses strict octet-stream for api.github.com release assets', async () => {
      const { fetcher, calls } = newFetcher([
        { status: 200, body: new Uint8Array([1, 2, 3]) }
      ]);
      await fetcher.fetchBytes('https://api.github.com/repos/a/b/releases/assets/123');
      expect(calls[0].headers.get('accept')).toBe('application/octet-stream');
    });

    it('uses permissive accept for other GitHub hosts', async () => {
      const { fetcher, calls } = newFetcher([
        { status: 200, body: new Uint8Array([1]) }
      ]);
      await fetcher.fetchBytes('https://raw.githubusercontent.com/a/b/main/x.md');
      const accept = calls[0].headers.get('accept') ?? '';
      expect(accept).toMatch(/\*\/\*/);
    });

    it('uses permissive accept for non-GitHub hosts', async () => {
      const { fetcher, calls } = newFetcher([
        { status: 200, body: new Uint8Array([1]) }
      ]);
      await fetcher.fetchBytes('https://example.com/asset.zip');
      const accept = calls[0].headers.get('accept') ?? '';
      expect(accept).toMatch(/\*\/\*/);
    });
  });

  describe('auth handling', () => {
    it('attaches Bearer token for GitHub hosts', async () => {
      const { fetcher, calls } = newFetcher([{ status: 200, body: new Uint8Array() }]);
      await fetcher.fetchBytes('https://api.github.com/repos/a/b/releases/assets/1');
      expect(calls[0].headers.get('authorization')).toBe('Bearer tok');
    });

    it('omits auth for non-GitHub hosts (token provider returns null)', async () => {
      const { fetcher, calls } = newFetcher([{ status: 200, body: new Uint8Array() }]);
      await fetcher.fetchBytes('https://example.com/x.zip');
      expect(calls[0].headers.get('authorization')).toBe(null);
    });
  });

  describe('happy path', () => {
    it('returns bytes + sha256', async () => {
      const data = new Uint8Array([0x01, 0x02, 0x03]);
      const { fetcher } = newFetcher([{ status: 200, body: data }]);
      const r = await fetcher.fetchBytes('https://example.com/x');
      expect(r.bytes.length).toBe(3);
      expect(r.sha256).toBe('039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81');
    });
  });

  describe('integrity', () => {
    it('verifies provided sha256-<hex> integrity', async () => {
      const data = new Uint8Array([0xFF]);
      const { fetcher } = newFetcher([{ status: 200, body: data }]);
      const r = await fetcher.fetchBytes('https://example.com/x', {
        integrity: 'sha256-a8100ae6aa1940d0b663bb31cd466142ebbdbd5187131b92d93818987832eb89'
      });
      expect(r.bytes.length).toBe(1);
    });

    it('throws on integrity mismatch', async () => {
      const { fetcher } = newFetcher([{ status: 200, body: new Uint8Array([1]) }]);
      await expect(
        fetcher.fetchBytes('https://example.com/x', { integrity: 'sha256-deadbeef' })
      ).rejects.toThrow(/integrity mismatch/);
    });
  });

  describe('retry on 5xx', () => {
    it('retries once on 502 then succeeds', async () => {
      const { fetcher, calls } = newFetcher([
        { status: 502 },
        { status: 200, body: new Uint8Array([1]) }
      ]);
      const r = await fetcher.fetchBytes('https://example.com/x');
      expect(r.bytes.length).toBe(1);
      expect(calls.length).toBe(2);
    });

    it('does not retry on 404', async () => {
      const { fetcher, calls } = newFetcher([
        { status: 404 },
        { status: 200, body: new Uint8Array([1]) }
      ]);
      await expect(fetcher.fetchBytes('https://example.com/x')).rejects.toThrow(/404/);
      expect(calls.length).toBe(1);
    });

    it('does not retry on 401', async () => {
      const { fetcher, calls } = newFetcher([
        { status: 401 },
        { status: 200, body: new Uint8Array([1]) }
      ]);
      await expect(fetcher.fetchBytes('https://example.com/x')).rejects.toThrow(/401/);
      expect(calls.length).toBe(1);
    });

    it('gives up after maxRetries', async () => {
      const { fetcher, calls } = newFetcher([{ status: 503 }]);
      await expect(fetcher.fetchBytes('https://example.com/x')).rejects.toThrow(/503/);
      expect(calls.length).toBe(4);
    });
  });

  describe('inline bytes shortcut', () => {
    it('returns inline bytes without calling fetch', async () => {
      const { fetcher, calls } = newFetcher([{ status: 200, body: new Uint8Array([99]) }]);
      const inline = new Uint8Array([1, 2, 3, 4]);
      const r = await fetcher.fetchBytes('', { inlineBytes: inline });
      expect(r.bytes.length).toBe(4);
      expect(calls.length).toBe(0);
    });

    it('verifies integrity on inline bytes too', async () => {
      const { fetcher } = newFetcher([{ status: 200, body: new Uint8Array() }]);
      const inline = new Uint8Array([1]);
      await expect(
        fetcher.fetchBytes('', { inlineBytes: inline, integrity: 'sha256-deadbeef' })
      ).rejects.toThrow(/integrity/);
    });
  });
});
