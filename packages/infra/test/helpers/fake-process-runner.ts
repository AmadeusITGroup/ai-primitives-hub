/**
 * Hand-written `ProcessRunner` test double, dispatching by exact command
 * string to a registered handler.
 *
 * Handlers can perform arbitrary side effects (e.g. writing into an
 * `InMemoryFileSystem` at `options.cwd`) to simulate what a real CLI
 * invocation would have done on disk - see `apm-adapter.test.ts`'s
 * `downloadBundle` tests.
 */
import type {
  ProcessResult,
  ProcessRunner,
  ProcessRunOptions,
} from '@ai-primitives-hub/core';

export type ProcessRunnerHandler = (command: string, options: ProcessRunOptions) => Promise<ProcessResult>;

export interface RecordedProcessCall {
  command: string;
  options: ProcessRunOptions;
}

export class FakeProcessRunner implements ProcessRunner {
  private readonly handlers = new Map<string, ProcessRunnerHandler>();
  public readonly calls: RecordedProcessCall[] = [];

  /**
   * Registers a handler for an exact command string.
   * @param command - Exact command line to match.
   * @param handler - Invoked when `exec` is called with a matching command; defaults to a handler resolving with empty output.
   */
  public on(command: string, handler: ProcessRunnerHandler = async () => ({ stdout: '', stderr: '' })): this {
    this.handlers.set(command, handler);
    return this;
  }

  public async exec(command: string, options: ProcessRunOptions = {}): Promise<ProcessResult> {
    this.calls.push({ command, options });
    const handler = this.handlers.get(command);
    if (!handler) {
      throw new Error(`FakeProcessRunner: no handler registered for command: ${command}`);
    }
    return handler(command, options);
  }
}
