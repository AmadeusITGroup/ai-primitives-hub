/**
 * Coverage tests for infra/github/events.ts.
 *
 * Tests ClientEvent types and NOOP_EVENT_HANDLER.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  type ClientEvent,
  type ClientEventHandler,
  type ClientEventKind,
  NOOP_EVENT_HANDLER,
} from '../../src/github/events';

describe('NOOP_EVENT_HANDLER', () => {
  it('is a function', () => {
    expect(typeof NOOP_EVENT_HANDLER).toBe('function');
  });

  it('returns undefined when called', () => {
    // eslint-disable-next-line new-cap -- NOOP_EVENT_HANDLER is a constant, not a constructor
    const result = NOOP_EVENT_HANDLER({} as ClientEvent);
    expect(result).toBeUndefined();
  });

  it('accepts any ClientEvent without error', () => {
    const ev: ClientEvent = {
      kind: 'request',
      url: 'https://api.github.com',
      attempt: 1
    };
    // eslint-disable-next-line new-cap -- NOOP_EVENT_HANDLER is a constant, not a constructor
    expect(() => NOOP_EVENT_HANDLER(ev)).not.toThrow();
  });
});

describe('ClientEvent type', () => {
  it('accepts request event', () => {
    const event: ClientEvent = {
      kind: 'request',
      url: 'https://api.github.com/repos/owner/repo',
      attempt: 1
    };
    expect(event.kind).toBe('request');
  });

  it('accepts success event with status', () => {
    const event: ClientEvent = {
      kind: 'success',
      url: 'https://api.github.com/repos/owner/repo',
      attempt: 1,
      status: 200
    };
    expect(event.status).toBe(200);
  });

  it('accepts cache-hit event with source', () => {
    const event: ClientEvent = {
      kind: 'cache-hit',
      url: 'https://api.github.com/repos/owner/repo',
      attempt: 1,
      source: 'etag'
    };
    expect(event.source).toBe('etag');
  });

  it('accepts not-modified event with source', () => {
    const event: ClientEvent = {
      kind: 'not-modified',
      url: 'https://api.github.com/repos/owner/repo',
      attempt: 1,
      source: 'blob-cache'
    };
    expect(event.source).toBe('blob-cache');
  });

  it('accepts retry event with sleepMs and reason', () => {
    const event: ClientEvent = {
      kind: 'retry',
      url: 'https://api.github.com/repos/owner/repo',
      attempt: 2,
      sleepMs: 1000,
      reason: '5xx error'
    };
    expect(event.sleepMs).toBe(1000);
    expect(event.reason).toBe('5xx error');
  });

  it('accepts rate-limit event with sleepMs', () => {
    const event: ClientEvent = {
      kind: 'rate-limit',
      url: 'https://api.github.com/repos/owner/repo',
      attempt: 1,
      sleepMs: 5000,
      reason: 'rate limit exceeded'
    };
    expect(event.sleepMs).toBe(5000);
  });

  it('accepts give-up event with reason', () => {
    const event: ClientEvent = {
      kind: 'give-up',
      url: 'https://api.github.com/repos/owner/repo',
      attempt: 3,
      reason: 'max retries exceeded'
    };
    expect(event.reason).toBe('max retries exceeded');
  });

  it('accepts inline source', () => {
    const event: ClientEvent = {
      kind: 'cache-hit',
      url: 'https://api.github.com/repos/owner/repo',
      attempt: 1,
      source: 'inline'
    };
    expect(event.source).toBe('inline');
  });
});

describe('ClientEventKind type', () => {
  it('includes all expected kinds', () => {
    const expectedKinds: ClientEventKind[] = [
      'request',
      'success',
      'cache-hit',
      'not-modified',
      'retry',
      'rate-limit',
      'give-up'
    ];
    expect(expectedKinds).toHaveLength(7);
  });
});

describe('ClientEventHandler type', () => {
  it('accepts a function that takes ClientEvent', () => {
    const handler: ClientEventHandler = (ev: ClientEvent) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Type check only
      const _ = ev.kind;
    };
    expect(typeof handler).toBe('function');
  });

  it('can be called with a ClientEvent', () => {
    const handler: ClientEventHandler = (ev: ClientEvent) => {
      return ev.kind;
    };
    const event: ClientEvent = {
      kind: 'request',
      url: 'https://api.github.com',
      attempt: 1
    };
    expect(handler(event)).toBe('request');
  });
});
