import type {
  ProcessResult,
  ProcessRunOptions,
} from './process-runner';

/** Argument-vector execution only. Implementations must never invoke a shell. */
export interface ArgvProcessRunner {
  execFile(file: string, args: readonly string[], options?: ProcessRunOptions): Promise<ProcessResult>;
}
