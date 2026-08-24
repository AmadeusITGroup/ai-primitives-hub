/**
 * Node `child_process.execFile` implementation of the argv-safe
 * `ProcessExecutor` port.
 * @module process/node-process-executor
 */
import {
  execFile,
} from 'node:child_process';
import {
  promisify,
} from 'node:util';
import type {
  ProcessExecutor,
  ProcessResult,
  ProcessRunOptions,
} from '@ai-primitives-hub/core';

const execFileAsync = promisify(execFile);

/** Environment variables never forwarded to a spawned process. */
const UNSAFE_ENV_VARS = ['LD_PRELOAD', 'DYLD_INSERT_LIBRARIES'];

export class NodeProcessExecutor implements ProcessExecutor {
  public async execFile(
    file: string,
    args: readonly string[],
    options: ProcessRunOptions = {}
  ): Promise<ProcessResult> {
    const env: Record<string, string | undefined> = { ...process.env, ...options.env };
    for (const unsafeVar of UNSAFE_ENV_VARS) {
      delete env[unsafeVar];
    }

    return execFileAsync(file, [...args], {
      cwd: options.cwd,
      env,
      timeout: options.timeoutMs
    });
  }
}
