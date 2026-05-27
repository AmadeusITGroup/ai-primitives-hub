/**
 * Standard bench cases for the GitHub middleware.
 *
 * Each case constructs a fresh `GitHubClient` or `AssetFetcher`
 * with a deterministic fake fetch, so timings reflect *only* the
 * middleware overhead — not network, kernel TCP, or DNS.
 * @module github/bench/cases
 */
import {
  AssetFetcher,
} from '../asset-fetcher';
import {
  type FetchLike,
  GitHubClient,
} from '../client';
import {
  staticTokenProvider,
} from '../token';
import {
  type BenchCase,
} from './harness';

/**
 * Fake fetch that returns a fixed response, optionally per call.
 * @param status
 * @param body
 * @param headers
 */
const fixedFetch = (
  status: number,
  body: string | Uint8Array,
  headers: Record<string, string> = {}
): FetchLike => {
  return (): Promise<Response> =>
    Promise.resolve(new Response(
      // 304 / 204 / 205 mustn't carry a body.
      [304, 204, 205].includes(status) ? null : body,
      { status, headers: new Headers(headers) }
    ));
};

const sequenceFetch = (steps: { status: number; body?: string | Uint8Array; headers?: Record<string, string> }[]): FetchLike => {
  let i = 0;
  return (): Promise<Response> => {
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    const nullBody = step.status === 304 || step.status === 204 || step.status === 205;
    return Promise.resolve(new Response(
      nullBody ? null : (step.body ?? ''),
      { status: step.status, headers: new Headers(step.headers ?? {}) }
    ));
  };
};

/** Build all five standard cases. Test thresholds are encoded here. */
export const standardBenchCases = (): BenchCase[] => [
  {
    id: 'cold',
    description: 'cold getJson against fresh client',
    thresholdMs: 5,
    run: async (): Promise<void> => {
      const client = new GitHubClient({
        tokens: staticTokenProvider('tok'),
        fetch: fixedFetch(200, '{"ok":1}'),
        sleep: () => Promise.resolve(),
        backoffBaseMs: 1,
        jitterMs: 0
      });
      await client.getJson('/repos/foo/bar');
    }
  },
  {
    id: 'warm-etag-304',
    description: 'conditional GET with cached etag, server returns 304',
    thresholdMs: 1, // generous over 100µs target
    run: async (): Promise<void> => {
      const client = new GitHubClient({
        tokens: staticTokenProvider('tok'),
        fetch: fixedFetch(304, ''),
        sleep: () => Promise.resolve(),
        backoffBaseMs: 1,
        jitterMs: 0
      });
      const r = await client.getJsonWithEtag('/repos/foo/bar', '"abc"');
      if (r.status !== 'notModified') {
        throw new Error('warm-etag-304 expected notModified');
      }
    }
  },
  {
    id: 'blob-cache-hit',
    description: 'AssetFetcher fetchBytes with inline-bytes shortcut',
    thresholdMs: 1, // generous over 50µs target
    run: async (): Promise<void> => {
      const fetcher = new AssetFetcher({
        tokens: staticTokenProvider('tok'),
        fetch: fixedFetch(500, ''), // never called
        sleep: () => Promise.resolve()
      });
      const r = await fetcher.fetchBytes('', { inlineBytes: new Uint8Array([1, 2, 3]) });
      if (r.bytes.length !== 3) {
        throw new Error('blob-cache-hit unexpected size');
      }
    }
  },
  {
    id: 'transient-5xx',
    description: 'getJson with one 503 retry then 200',
    thresholdMs: 5,
    run: async (): Promise<void> => {
      const client = new GitHubClient({
        tokens: staticTokenProvider('tok'),
        fetch: sequenceFetch([
          { status: 503, body: 'down' },
          { status: 200, body: '{"ok":1}' }
        ]),
        sleep: () => Promise.resolve(),
        backoffBaseMs: 1,
        jitterMs: 0,
        random: () => 0
      });
      await client.getJson('/x');
    }
  },
  {
    id: 'rate-limit',
    description: 'getJson observes 403 rate-limit then succeeds',
    thresholdMs: 5,
    run: async (): Promise<void> => {
      const reset = String(Math.floor(Date.now() / 1000) + 1);
      const client = new GitHubClient({
        tokens: staticTokenProvider('tok'),
        fetch: sequenceFetch([
          {
            status: 403,
            body: 'rate limit',
            headers: {
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': reset
            }
          },
          { status: 200, body: '{"ok":1}' }
        ]),
        sleep: () => Promise.resolve(),
        backoffBaseMs: 1,
        jitterMs: 0,
        maxSleepMs: 1
      });
      await client.getJson('/x');
    }
  }
];
