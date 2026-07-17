/**
 * Tests for `framework/output.ts`.
 *
 * `formatOutput` serializes the command payload into text, json, yaml, or
 * ndjson and writes to the Context streams. It also handles warnings and
 * `quiet` suppression.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  createTestContext,
  formatOutput,
} from '../../src/framework';

describe('formatOutput', () => {
  it('emits a JSON envelope by default for json output', () => {
    const ctx = createTestContext();
    formatOutput({
      ctx,
      command: 'test.cmd',
      output: 'json',
      status: 'ok',
      data: { id: 1 }
    });
    const envelope = JSON.parse(ctx.stdout.captured()) as { status: string; data: unknown };
    expect(envelope.status).toBe('ok');
    expect(envelope.data).toEqual({ id: 1 });
  });

  it('puts warnings and errors into the JSON envelope', () => {
    const ctx = createTestContext();
    formatOutput({
      ctx,
      command: 'test.cmd',
      output: 'json',
      status: 'warning',
      data: null,
      warnings: ['one'],
      errors: [{ code: 'X.Y', message: 'err' }]
    });
    const envelope = JSON.parse(ctx.stdout.captured()) as { warnings: string[]; errors: unknown[] };
    expect(envelope.warnings).toEqual(['one']);
    expect(envelope.errors).toHaveLength(1);
  });

  it('emits YAML for yaml output', () => {
    const ctx = createTestContext();
    formatOutput({
      ctx,
      command: 'test.cmd',
      output: 'yaml',
      status: 'ok',
      data: { id: 1 }
    });
    expect(ctx.stdout.captured()).toContain('command: test.cmd');
    expect(ctx.stdout.captured()).toContain('status: ok');
  });

  it('renders one JSON line per array item for ndjson output', () => {
    const ctx = createTestContext();
    formatOutput({
      ctx,
      command: 'test.cmd',
      output: 'ndjson',
      status: 'ok',
      data: [{ id: 1 }, { id: 2 }]
    });
    const lines = ctx.stdout.captured().trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ id: 1 });
    expect(JSON.parse(lines[1])).toEqual({ id: 2 });
  });

  it('emits non-array data as a single ndjson line', () => {
    const ctx = createTestContext();
    formatOutput({
      ctx,
      command: 'test.cmd',
      output: 'ndjson',
      status: 'ok',
      data: { id: 1 }
    });
    expect(JSON.parse(ctx.stdout.captured())).toEqual({ id: 1 });
  });

  it('writes ndjson warnings/errors to stderr', () => {
    const ctx = createTestContext();
    formatOutput({
      ctx,
      command: 'test.cmd',
      output: 'ndjson',
      status: 'warning',
      data: [],
      warnings: ['oops'],
      errors: [{ code: 'X.Y', message: 'bad' }]
    });
    expect(ctx.stderr.captured()).toContain('warning: oops');
    expect(ctx.stderr.captured()).toContain('error: X.Y');
  });

  it('uses the custom textRenderer in text mode', () => {
    const ctx = createTestContext();
    formatOutput({
      ctx,
      command: 'test.cmd',
      output: 'text',
      status: 'ok',
      data: { id: 1 },
      textRenderer: (d) => `id=${(d).id}\n`
    });
    expect(ctx.stdout.captured()).toBe('id=1\n');
  });

  it('falls back to pretty-printed JSON when no textRenderer is supplied', () => {
    const ctx = createTestContext();
    formatOutput({
      ctx,
      command: 'test.cmd',
      output: 'text',
      status: 'ok',
      data: { id: 1 }
    });
    expect(ctx.stdout.captured()).toBe('{\n  "id": 1\n}\n');
  });

  it('writes warnings to stderr in text mode', () => {
    const ctx = createTestContext();
    formatOutput({
      ctx,
      command: 'test.cmd',
      output: 'text',
      status: 'warning',
      data: null,
      warnings: ['look out']
    });
    expect(ctx.stderr.captured()).toContain('warning: look out');
    expect(ctx.stdout.captured()).toBe('');
  });

  it('suppresses stdout in text mode when quiet is true', () => {
    const ctx = createTestContext();
    formatOutput({
      ctx,
      command: 'test.cmd',
      output: 'text',
      status: 'ok',
      data: { id: 1 },
      quiet: true,
      textRenderer: (d) => `id=${(d).id}\n`
    });
    expect(ctx.stdout.captured()).toBe('');
  });

  it('does not suppress JSON output when quiet is true', () => {
    const ctx = createTestContext();
    formatOutput({
      ctx,
      command: 'test.cmd',
      output: 'json',
      status: 'ok',
      data: { id: 1 },
      quiet: true
    });
    expect(JSON.parse(ctx.stdout.captured()).data).toEqual({ id: 1 });
  });
});
