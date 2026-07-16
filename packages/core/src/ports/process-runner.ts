/**
 * Process-execution port — shells out to external CLIs.
 *
 * Needed by adapters that delegate to a third-party command-line tool
 * rather than a plain HTTP API (the `apm` CLI for `ApmAdapter`, Phase 3a).
 * A narrower, purpose-built shell-out already exists for a single command
 * (`infra/auth/gh-cli-token-provider.ts`'s `ExecFn`, for `gh auth token`);
 * this is the general-purpose counterpart for adapters that need to run
 * more than one distinct command with `cwd`/`env`/timeout control.
 * @module ports/process-runner
 */

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

export interface ProcessRunOptions {
  /** Working directory for the spawned process; defaults to the current process's cwd. */
  cwd?: string;
  /** Additional/overriding environment variables, merged on top of the current process's environment. */
  env?: Record<string, string | undefined>;
  /** Kills the process and rejects if it hasn't exited within this many milliseconds. */
  timeoutMs?: number;
}

/**
 * Runs a shell command line and resolves with its output, or rejects if
 * the process exits non-zero, is killed, or times out.
 */
export interface ProcessRunner {
  exec(command: string, options?: ProcessRunOptions): Promise<ProcessResult>;
}
