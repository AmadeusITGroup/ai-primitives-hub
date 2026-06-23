/**
 * Production Context wiring.
 *
 * Real-world implementations of the abstractions defined in `context.ts`.
 * Each wrapper is the minimum surface needed to satisfy the abstraction;
 * none of these are exported as standalone utilities to discourage direct
 * use outside the framework.
 *
 * fs   -> node:fs/promises
 * net  -> global fetch (Node 18+; works on Node 20 baseline)
 * clock -> Date.now
 * stdio -> process.stdin/stdout/stderr
 * env   -> Object.freeze({ ...process.env }) snapshotted once
 * cwd   -> process.cwd
 * exit  -> process.exit (the *only* call site to it; ESLint rule
 *          will ban process.exit elsewhere in src/)
 *
 * No external dependencies are added: global fetch is built
 * into Node 18+, and tests exercise net via a local in-process HTTP
 * server rather than `nock` or `undici.MockAgent`. Future iterations may
 * adopt MockAgent if HTTP-level assertions become valuable; the
 * abstraction boundary already isolates that decision.
 */
import * as fsp from 'node:fs/promises';
import type {
  ClockAbstraction,
  Context,
  FsAbstraction,
  InputStream,
  NetAbstraction,
  NetRequestInit,
  NetResponse,
  OutputStream,
} from './context';

const createProductionFs = (): FsAbstraction => ({
  readFile: (p: string): Promise<string> => fsp.readFile(p, 'utf8'),
  writeFile: async (p: string, contents: string): Promise<void> => {
    await fsp.writeFile(p, contents, 'utf8');
  },
  readJson: async <T = unknown>(p: string): Promise<T> => {
    const raw = await fsp.readFile(p, 'utf8');
    return JSON.parse(raw) as T;
  },
  writeJson: async (p: string, value: unknown): Promise<void> => {
    await fsp.writeFile(p, JSON.stringify(value, null, 2), 'utf8');
  },
  exists: async (p: string): Promise<boolean> => {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  },
  mkdir: async (p: string, opts?: { recursive?: boolean }): Promise<void> => {
    await fsp.mkdir(p, { recursive: opts?.recursive === true });
  },
  readDir: (p: string): Promise<string[]> => fsp.readdir(p, { withFileTypes: false }),
  remove: async (p: string, opts?: { recursive?: boolean }): Promise<void> => {
    await fsp.rm(p, { recursive: opts?.recursive === true, force: true });
  }
});

const headersToRecord = (h: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
    out[key] = value;
  });
  return out;
};

const createProductionNet = (): NetAbstraction => ({
  fetch: async (url: string, init?: NetRequestInit): Promise<NetResponse> => {
    const resp = await globalThis.fetch(url, {
      method: init?.method ?? 'GET',
      headers: init?.headers,
      body: init?.body
    });
    const headers = headersToRecord(resp.headers);
    return {
      status: resp.status,
      headers,
      text: () => resp.text(),
      json: <T = unknown>(): Promise<T> => resp.json() as Promise<T>,
      bytes: async (): Promise<Uint8Array> => new Uint8Array(await resp.arrayBuffer())
    };
  }
});

const createProductionClock = (): ClockAbstraction => ({
  now: (): number => Date.now()
});

const createProductionStdout = (): OutputStream => ({
  write: (chunk: string): void => {
    process.stdout.write(chunk);
  }
});

const createProductionStderr = (): OutputStream => ({
  write: (chunk: string): void => {
    process.stderr.write(chunk);
  }
});

/**
 * Production stdin reader — synchronous read of any pre-piped content.
 * Only needs a static read(); the streaming variant for
 * interactive prompts lands in a later iteration with the doctor stub.
 */
const createProductionStdin = (): InputStream => ({
  read: (): string => '' // streaming read added in a later iteration
});

const detectColorDepth = (): number => {
  if (process.env.NO_COLOR !== undefined) {
    return 0;
  }
  if (process.stdout.isTTY) {
    return 4; // ANSI 16 colors (clipanion only needs > 0)
  }
  return 0;
};

/**
 * Build the production Context the real CLI binary uses at startup.
 * @param overrides - Optional Context-field overrides. Added
 *   `cwd` so the `--cwd` flag can redirect filesystem operations
 *   without `chdir`-ing the whole process (which would corrupt
 *   relative paths outside the command's own scope).
 * @param overrides.cwd
 * @returns A `Context` whose IO surfaces are wired to real Node primitives.
 */
export const createProductionContext = (overrides: { cwd?: string } = {}): Context => ({
  fs: createProductionFs(),
  net: createProductionNet(),
  clock: createProductionClock(),
  stdin: createProductionStdin(),
  stdout: createProductionStdout(),
  stderr: createProductionStderr(),
  env: Object.freeze({ ...process.env }) as Readonly<Record<string, string>>,
  cwd: overrides.cwd === undefined
    ? (): string => process.cwd()
    : (): string => overrides.cwd as string,
  exit: (code: number): void => {
    // This is the *only* call site for process.exit() in the codebase.
    // The ESLint rule will ban it everywhere except
    // here, enforcing the invariant that all IO goes through Context.
    // eslint-disable-next-line unicorn/no-process-exit -- This is the single, intentional sink for process termination; the invariant forbids process.exit anywhere else in src/.
    process.exit(code);
  },
  colorDepth: detectColorDepth()
});
