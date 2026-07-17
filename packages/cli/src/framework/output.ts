/**
 * Output formatter.
 *
 * Single sink for all command output. Leaf commands compute `data` and
 * call `formatOutput()` once; this module handles serialization and
 * stdout routing for all four modes (text, json, yaml, ndjson). The
 * markdown and table modes are deferred to a later
 * iteration alongside their domain-specific renderers — they are not
 * universally meaningful and carrying empty stubs here would lie about
 * the supported surface.
 *
 * JSON envelope
 *   {
 *     schemaVersion: 1,
 *     command:       <dotted.path>,
 *     status:        "ok" | "error" | "warning",
 *     data:          <command-specific payload>,
 *     warnings:      [...string],
 *     errors:        [...{ code, message, ... }],
 *     meta:          { ... }
 *   }
 *
 * Routing rules
 *   text mode: warnings -> ctx.stderr (stdout stays a clean payload)
 *   json mode: warnings stay in the envelope; stderr untouched
 *   quiet=true: suppresses stdout in text mode only; JSON consumers
 *               always need the envelope
 * @module framework/output
 */
import {
  dump as toYaml,
} from 'js-yaml';
import type {
  Context,
} from './context';

export type OutputFormat = 'text' | 'json' | 'yaml' | 'ndjson';
export type OutputStatus = 'ok' | 'error' | 'warning';

/**
 * JSON-serializable error envelope item. RegistryError will
 * produce records of this shape via a `.toJSON()` method.
 */
export interface OutputError {
  code: string;
  message: string;
  hint?: string;
  docsUrl?: string;
  context?: Record<string, unknown>;
}

export interface FormatOutputOptions<T = unknown> {
  ctx: Context;
  /** Dotted command path used in the envelope (e.g. `index.search`). */
  command: string;
  output: OutputFormat;
  status: OutputStatus;
  data: T;
  warnings?: string[];
  errors?: OutputError[];
  meta?: Record<string, unknown>;
  /** Renderer used for `output=text`. Defaults to JSON.stringify. */
  textRenderer?: (data: T) => string;
  /** Suppress stdout in text mode. JSON output is unaffected. */
  quiet?: boolean;
}

/**
 * Format and emit a command result.
 * @param opts ctx / command / output / status / data / warnings / errors / meta / textRenderer / quiet.
 */
export const formatOutput = <T>(opts: FormatOutputOptions<T>): void => {
  const warnings = opts.warnings ?? [];
  const errors = opts.errors ?? [];
  const meta = opts.meta ?? {};

  switch (opts.output) {
    case 'json': {
      const envelope = {
        schemaVersion: 1,
        command: opts.command,
        status: opts.status,
        data: opts.data,
        warnings,
        errors,
        meta
      };
      opts.ctx.stdout.write(`${JSON.stringify(envelope)}\n`);
      return;
    }

    case 'yaml': {
      const envelope = {
        schemaVersion: 1,
        command: opts.command,
        status: opts.status,
        data: opts.data,
        warnings,
        errors,
        meta
      };
      opts.ctx.stdout.write(toYaml(envelope));
      return;
    }

    case 'ndjson': {
      // For arrays each element is its own JSON line — ideal for
      // `ai-primitives-hub bundle list -o ndjson | jq` pipelines that
      // process items as a stream rather than loading everything.
      // For non-array data we emit the value as a single JSON line so
      // ndjson is always one-line-per-record.
      if (Array.isArray(opts.data)) {
        for (const item of opts.data) {
          opts.ctx.stdout.write(`${JSON.stringify(item)}\n`);
        }
      } else {
        opts.ctx.stdout.write(`${JSON.stringify(opts.data)}\n`);
      }
      // Warnings/errors do not have a natural place in pure ndjson
      // output (which is item-only by convention). Push them to
      // stderr so they remain visible without polluting the stream.
      for (const w of warnings) {
        opts.ctx.stderr.write(`warning: ${w}\n`);
      }
      for (const e of errors) {
        opts.ctx.stderr.write(`error: ${e.code} — ${e.message}\n`);
      }
      return;
    }

    default: {
      // 'text' is the only remaining variant; the default branch covers
      // it and any future format gracefully degrades to text behavior.
      // Warnings to stderr so a piped `... | jq .field` keeps working
      // when textRenderer happens to emit JSON-shaped output.
      for (const w of warnings) {
        opts.ctx.stderr.write(`warning: ${w}\n`);
      }
      if (opts.quiet === true) {
        return;
      }
      const renderer = opts.textRenderer ?? defaultTextRenderer;
      opts.ctx.stdout.write(renderer(opts.data));
    }
  }
};

const defaultTextRenderer = <T>(data: T): string => {
  // Non-textRenderer-supplied case: fall back to a deterministic JSON
  // serialization so commands that haven't defined a `textRenderer`
  // still produce *some* meaningful output. Text mode is "best-effort
  // human"; commands wanting machine output should pass `-o json`.
  // A null/undefined payload means nothing to render.
  if (data === null || data === undefined) {
    return '';
  }
  return `${JSON.stringify(data, null, 2)}\n`;
};
