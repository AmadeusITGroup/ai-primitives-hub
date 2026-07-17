/**
 * Context interface skeleton.
 *
 * The `Context` object is the single seam through which every
 * ai-primitives-hub subcommand performs IO. This is called
 * "Context-only IO" and is ESLint-enforced (rule lands in a later
 * iteration).
 *
 * `FileSystem` and `Clock` are defined in `@ai-primitives-hub/core`'s
 * `ports/` and re-exported here as backward-compatible type aliases
 * (`FsAbstraction`, `ClockAbstraction`). Feature layers (`app`, `infra`)
 * import directly from `@ai-primitives-hub/core`; CLI-layer code may
 * continue to import from this file via the framework barrel.
 * @module framework/context
 */
import type {
  Clock,
  FileSystem,
} from '@ai-primitives-hub/core';

/**
 * Filesystem abstraction — backward-compatible alias for {@link FileSystem}.
 * New code should import `FileSystem` from `@ai-primitives-hub/core` directly.
 */
export type FsAbstraction = FileSystem;

/**
 * Network abstraction — single fetch-like call returning a streaming body.
 * Later wraps undici; tests use undici's MockAgent (same library in prod
 * and test, no global mutation, no nock).
 */
export interface NetAbstraction {
  fetch(url: string, init?: NetRequestInit): Promise<NetResponse>;
}

export interface NetRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

export interface NetResponse {
  status: number;
  headers: Record<string, string>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  bytes(): Promise<Uint8Array>;
}

/**
 * Clock abstraction — backward-compatible alias for {@link Clock}.
 * New code should import `Clock` from `@ai-primitives-hub/core` directly.
 */
export type ClockAbstraction = Clock;

export type {
  TestClock,
} from '@ai-primitives-hub/core';

/**
 * Output stream abstraction — `write()` is the only sink, mirroring the
 * `Writable.write()` shape so production wiring (process.stdout) and the
 * test capture sink can share a contract. `captured()` is exposed only
 * by the test sink; production streams expose `flush()` instead (added in
 * a later iteration alongside the formatter).
 */
export interface OutputStream {
  write(chunk: string): void;
}

export interface CapturedOutputStream extends OutputStream {
  captured(): string;
}

/**
 * Input stream abstraction — only needs static `read()` for
 * non-interactive command tests (e.g. piped JSON). Streaming stdin
 * (interactive prompts) is added in a later iteration when the doctor stub lands.
 */
export interface InputStream {
  read(): string;
}

/**
 * Context — the single object passed to every command. Carries every IO
 * surface the command might need plus environment/cwd/exit hooks.
 */
export interface Context {
  fs: FileSystem;
  net: NetAbstraction;
  clock: ClockAbstraction;
  stdin: InputStream;
  stdout: OutputStream;
  stderr: OutputStream;
  env: Readonly<Record<string, string>>;
  cwd(): string;
  exit(code: number): void;
  /**
   * Terminal color depth (0 = monochrome, 1 = basic, 4 = ANSI, 8 = 256-color, 24 = truecolor).
   * Used by the CLI framework to decide whether to emit ANSI color codes.
   */
  colorDepth: number;
}
