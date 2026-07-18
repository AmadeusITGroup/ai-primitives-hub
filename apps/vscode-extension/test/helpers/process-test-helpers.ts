/**
 * Process Test Helpers
 *
 * Utilities for mocking child_process.spawn in tests.
 * Provides realistic event sequencing for process lifecycle simulation.
 */

import {
  EventEmitter,
} from 'node:events';
import * as sinon from 'sinon';

/**
 * Mock process that simulates child_process.ChildProcess behavior
 */
export interface MockProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: sinon.SinonStub;
  pid: number;
}

/**
 * Options for creating a mock process
 */
export interface MockProcessOptions {
  /** Exit code to emit on close (default: 0) */
  exitCode?: number;
  /** Stdout data to emit before close */
  stdoutData?: string;
  /** Stderr data to emit before close */
  stderrData?: string;
  /** Error to emit instead of close */
  error?: Error;
  /** Delay in ms before emitting events (default: 0) */
  delay?: number;
  /** Process ID (default: 12345) */
  pid?: number;
}

/**
 * Create a mock process that behaves like a real child process.
 *
 * Event sequence follows real process behavior:
 * 1. stdout.data (if provided)
 * 2. stderr.data (if provided)
 * 3. close OR error (mutually exclusive)
 * @param options
 * @example
 * ```typescript
 * const { process, emitEvents } = createMockProcess({ exitCode: 0, stdoutData: '10.2.3\n' });
 * sandbox.stub(childProcess, 'spawn').returns(process);
 *
 * const resultPromise = npmWrapper.getVersion();
 * emitEvents(); // Triggers stdout then close
 * const result = await resultPromise;
 * ```
 */
export function createMockProcess(options: MockProcessOptions = {}): {
  process: MockProcess;
  emitEvents: () => void;
} {
  const {
    exitCode = 0,
    stdoutData,
    stderrData,
    error,
    delay = 0,
    pid = 12_345
  } = options;

  // eslint-disable-next-line unicorn/prefer-event-target -- EventEmitter used for Node.js compatibility
  const process = new EventEmitter() as MockProcess;
  // eslint-disable-next-line unicorn/prefer-event-target -- EventEmitter used for Node.js compatibility
  process.stdout = new EventEmitter();
  // eslint-disable-next-line unicorn/prefer-event-target -- EventEmitter used for Node.js compatibility
  process.stderr = new EventEmitter();
  process.kill = sinon.stub();
  process.pid = pid;

  const emitEvents = (): void => {
    const doEmit = (): void => {
      // Emit stdout data first (if any)
      if (stdoutData) {
        process.stdout.emit('data', stdoutData);
      }

      // Emit stderr data (if any)
      if (stderrData) {
        process.stderr.emit('data', stderrData);
      }

      // Emit either error or close (not both)
      if (error) {
        process.emit('error', error);
      } else {
        process.emit('close', exitCode);
      }
    };

    if (delay > 0) {
      setTimeout(doEmit, delay);
    } else {
      // Use setImmediate to ensure async behavior
      setImmediate(doEmit);
    }
  };

  return { process, emitEvents };
}

/**
 * Create a mock process that succeeds with given output
 * @param stdout
 */
export function createSuccessProcess(stdout = ''): {
  process: MockProcess;
  emitEvents: () => void;
} {
  return createMockProcess({ exitCode: 0, stdoutData: stdout });
}

/**
 * Create a mock process that fails with given exit code and stderr
 * @param exitCode
 * @param stderr
 */
export function createFailureProcess(exitCode = 1, stderr = ''): {
  process: MockProcess;
  emitEvents: () => void;
} {
  return createMockProcess({ exitCode, stderrData: stderr });
}

/**
 * Create a mock process that emits an error (e.g., ENOENT)
 * @param error
 */
export function createErrorProcess(error: Error): {
  process: MockProcess;
  emitEvents: () => void;
} {
  return createMockProcess({ error });
}
