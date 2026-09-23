/**
 * Argv-safe process-execution port for external CLI integrations.
 *
 * Unlike `ProcessRunner`, this port never accepts a shell command string.
 * Callers provide the executable and arguments separately so values such as
 * repository names cannot be interpreted as shell syntax.
 * @module ports/process-executor
 */
import type {
  ProcessResult,
  ProcessRunOptions,
} from './process-runner';

export interface ProcessExecutor {
  execFile(
    file: string,
    args: readonly string[],
    options?: ProcessRunOptions
  ): Promise<ProcessResult>;
}
