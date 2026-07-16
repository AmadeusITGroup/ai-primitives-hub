/**
 * Node `child_process`-backed implementation of the `ProcessRunner` port.
 *
 * Consolidates the "spawn a command, merge a safe environment" logic that
 * was duplicated across `src/services/apm-cli-wrapper.ts`'s
 * `getSafeEnvironment` and `src/services/apm-runtime-manager.ts`'s
 * near-identical copy into one place. Both env-stripping rules
 * (`LD_PRELOAD`/`DYLD_INSERT_LIBRARIES`) are applied unconditionally, for
 * every command, rather than only for install operations - a stricter
 * default that every future caller of this port benefits from.
 * @module process/node-process-runner
 */
import {
  exec,
} from 'node:child_process';
import {
  promisify,
} from 'node:util';
import type {
  ProcessResult,
  ProcessRunner,
  ProcessRunOptions,
} from '@ai-primitives-hub/core';

const execAsync = promisify(exec);

/** Environment variables never forwarded to a spawned process, regardless of caller-supplied overrides. */
const UNSAFE_ENV_VARS = ['LD_PRELOAD', 'DYLD_INSERT_LIBRARIES'];

export class NodeProcessRunner implements ProcessRunner {
  public async exec(command: string, options: ProcessRunOptions = {}): Promise<ProcessResult> {
    const env: Record<string, string | undefined> = { ...process.env, ...options.env };
    for (const unsafeVar of UNSAFE_ENV_VARS) {
      delete env[unsafeVar];
    }

    return execAsync(command, {
      cwd: options.cwd,
      env,
      timeout: options.timeoutMs
    });
  }
}
