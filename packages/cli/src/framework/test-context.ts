/**
 * In-memory Context factory for golden tests.
 *
 * `createTestContext()` builds a Context whose IO surfaces are entirely
 * in-memory:
 *   - stdout/stderr are captured into a string buffer for assertion;
 *   - exit() records the code without terminating the process;
 *   - clock is manually advanceable for cache-TTL/retry-backoff tests;
 *   - env defaults to {} so tests cannot accidentally leak ambient state;
 *   - cwd defaults to "/" so tests cannot depend on host filesystem layout.
 *
 * fs and net are intentionally stubbed initially (any call throws). Later
 * wires them to memfs (fs) and undici MockAgent (net). Keeping the initial
 * version free of those deps keeps the merge tight and avoids a long install step.
 *
 * Test ergonomics (golden-test runner) builds on this factory.
 *
 * Note on style: this module deliberately uses arrow-function factories
 * rather than ES classes. The repo eslint config prefers arrow-function
 * shapes over class methods (`prefer-arrow/prefer-arrow-functions`) and
 * requires explicit accessibility modifiers on every class member, which
 * adds noise to what is essentially a struct-of-closures.
 * @module framework/test-context
 */
import type {
  CapturedOutputStream,
  Context,
  FsAbstraction,
  InputStream,
  NetAbstraction,
  TestClock,
} from './context';

export interface TestContextOptions {
  /** Pre-seeded stdin content; defaults to ''. */
  stdin?: string;
  /** Initial epoch ms reported by ctx.clock.now(); defaults to 0. */
  now?: number;
  /** Frozen env map; defaults to {} (no ambient leak from process.env). */
  env?: Record<string, string>;
  /** Working directory reported by ctx.cwd(); defaults to '/'. */
  cwd?: string;
  /** Optional custom fs implementation; defaults to STUB_FS (rejects all calls). */
  fs?: FsAbstraction;
}

/**
 * Test-only Context type — exposes the captured output sinks and the
 * recorded exit code so assertions can pull them out without casting.
 */
export interface TestContext extends Context {
  stdout: CapturedOutputStream;
  stderr: CapturedOutputStream;
  exitCode(): number;
  clock: TestClock;
}

const createCapturingStream = (): CapturedOutputStream => {
  let buf = '';
  return {
    write: (chunk: string): void => {
      buf += chunk;
    },
    captured: (): string => buf
  };
};

const createStaticInput = (content: string): InputStream => ({
  read: (): string => content
});

const createManualClock = (initial: number): TestClock => {
  let current = initial;
  return {
    now: (): number => current,
    nowIso: (): string => new Date(current).toISOString(),
    advance: (ms: number): void => {
      current += ms;
    }
  };
};

const rejectFsCall = (): Promise<never> =>
  Promise.reject(new Error('fs not wired yet (lands in a later iteration)'));

/**
 * Initial stub fs — every call throws. Later replaces with memfs-backed
 * implementation. The throw is descriptive so test failures point at the
 * missing wiring rather than at a confusing undefined-property crash.
 */
const STUB_FS: FsAbstraction = {
  readFile: rejectFsCall,
  writeFile: rejectFsCall,
  readJson: rejectFsCall,
  writeJson: rejectFsCall,
  exists: rejectFsCall,
  mkdir: rejectFsCall,
  readDir: rejectFsCall,
  readDirEntries: rejectFsCall,
  stat: rejectFsCall,
  remove: rejectFsCall
};

/**
 * Initial stub net — every call throws. Later replaces with undici-backed
 * implementation gated by undici MockAgent in tests.
 */
const STUB_NET: NetAbstraction = {
  fetch: (): Promise<never> =>
    Promise.reject(new Error('net not wired yet (lands in a later iteration)'))
};

/**
 * Build an in-memory Context for unit / golden tests.
 *
 * Defaults are chosen to make tests hermetic by construction:
 *   - empty env (no ambient process.env leakage),
 *   - cwd '/' (no dependence on where the runner started),
 *   - clock at epoch 0 (deterministic timestamps in golden output),
 *   - exit() never terminates the process; first code wins (POSIX-like
 *     semantics where an early decision to fail can't be silently
 *     overwritten by later cleanup work).
 * @param options Optional overrides for stdin / clock / env / cwd.
 * @returns A `TestContext` that exposes captured stdout/stderr sinks and
 *          a recorded exit code accessor in addition to the standard
 *          `Context` shape.
 */
export const createTestContext = (options: TestContextOptions = {}): TestContext => {
  const stdout = createCapturingStream();
  const stderr = createCapturingStream();
  const stdin = createStaticInput(options.stdin ?? '');
  const clock = createManualClock(options.now ?? 0);
  const env: Readonly<Record<string, string>> = Object.freeze({ ...options.env });
  const cwdValue = options.cwd ?? '/';

  let recordedExit: number | null = null;
  const exit = (code: number): void => {
    recordedExit ??= code;
  };
  const exitCode = (): number => recordedExit ?? 0;

  return {
    fs: options.fs ?? STUB_FS,
    net: STUB_NET,
    clock,
    stdin,
    stdout,
    stderr,
    env,
    cwd: () => cwdValue,
    exit,
    exitCode,
    colorDepth: 0
  };
};

/**
 * Convenience type guard, mostly for documentation purposes — at runtime
 * production and test contexts share the `Context` shape, so the only
 * way to detect a test context is to check for the `exitCode()` accessor
 * which production never exposes.
 * @param ctx Any `Context` produced by either the production wiring or
 *            the test factory.
 * @returns `true` when `ctx` was produced by `createTestContext()`.
 */
export const isTestContext = (ctx: Context): ctx is TestContext =>
  typeof (ctx as TestContext).exitCode === 'function';
