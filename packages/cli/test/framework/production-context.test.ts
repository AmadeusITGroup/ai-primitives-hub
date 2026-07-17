/**
 * Tests for `framework/production-context.ts`.
 *
 * `createProductionContext` wires real Node primitives. We avoid calling
 * `ctx.exit()` (which would terminate the process) and verify the other
 * seams are correctly connected.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  createProductionContext,
} from '../../src/framework';

describe('createProductionContext', () => {
  it('wires a real NodeFileSystem and SystemClock', () => {
    const ctx = createProductionContext({ cwd: '/tmp' });
    expect(typeof ctx.fs.readFile).toBe('function');
    expect(typeof ctx.clock.now).toBe('function');
    expect(ctx.cwd()).toBe('/tmp');
  });

  it('defaults cwd to process.cwd() when not overridden', () => {
    const ctx = createProductionContext();
    expect(ctx.cwd()).toBe(process.cwd());
  });

  it('freezes env from process.env', () => {
    const ctx = createProductionContext();
    expect(Object.isFrozen(ctx.env)).toBe(true);
  });

  it('exposes stdout/stderr write methods', () => {
    const ctx = createProductionContext();
    expect(typeof ctx.stdout.write).toBe('function');
    expect(typeof ctx.stderr.write).toBe('function');
  });

  it('reads stdin via the read method', () => {
    const ctx = createProductionContext();
    expect(typeof ctx.stdin.read).toBe('function');
    expect(ctx.stdin.read()).toBe('');
  });

  it('exposes a net.fetch that calls globalThis.fetch', async () => {
    const ctx = createProductionContext();
    const original = globalThis.fetch;
    const response = {
      status: 200,
      headers: new Headers(),
      text: (): Promise<string> => Promise.resolve('ok'),
      json: (): Promise<unknown> => Promise.resolve({ ok: true }),
      arrayBuffer: (): Promise<ArrayBuffer> => Promise.resolve(new ArrayBuffer(0))
    };
    globalThis.fetch = (): Promise<Response> => Promise.resolve(response as unknown as Response);
    try {
      const result = await ctx.net.fetch('https://example.com');
      expect(result.status).toBe(200);
      expect(await result.text()).toBe('ok');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('sets colorDepth to 0 when NO_COLOR is set', () => {
    const original = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    try {
      const ctx = createProductionContext();
      expect(ctx.colorDepth).toBe(0);
    } finally {
      if (original === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = original;
      }
    }
  });
});
