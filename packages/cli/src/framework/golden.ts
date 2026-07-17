/**
 * Golden-test runner.
 *
 * `runCommand(argv, opts)` is a thin convenience wrapper around
 * `runCli` + `createTestContext`. It builds an ephemeral test
 * Context, runs the dispatcher, and returns `{ exitCode, stdout, stderr }`
 * — exactly the three values almost every end-to-end test needs.
 *
 * Why a separate helper?
 *   1. Golden-style tests routinely need all three captured streams plus
 *      the exit code; doing the createTestContext/runCli/captured triple
 *      by hand for every assertion is repetitive.
 *   2. Centralizing the test entry point gives the command
 *      extractions a single place to evolve (e.g., adding a `clock`
 *      override or pre-seeding fs/env without touching every test).
 *
 * What this is NOT:
 *   - A snapshot harness. Snapshot diffing belongs in tests proper
 *     (mocha + a JSON.stringify diff is sufficient for now).
 *   - A clipanion runner. The framework adapter (`runCli`) handles all
 *      dispatch; this helper only composes.
 * @module framework/golden
 */
import type {
  CommandClass,
} from 'clipanion';
import type {
  CommandDefinition,
} from './cli';
import {
  runCli,
} from './cli';
import type {
  TestContextOptions,
} from './test-context';
import {
  createTestContext,
} from './test-context';

export interface RunCommandOptions {
  /** Commands available for dispatch (passed to `runCli`). */
  commands?: CommandDefinition[];
  /** Native clipanion command classes registered directly. */
  commandClasses?: CommandClass[];
  /** Binary name reported in usage / version output. Default: `ai-primitives-hub`. */
  name?: string;
  /** Binary version reported by --version. Default: `0.0.0-test`. */
  version?: string;
  /** Test-Context overrides (env, cwd, etc.). */
  context?: TestContextOptions;
}

export interface RunCommandResult {
  /** Exit code returned by the dispatcher. */
  exitCode: number;
  /** Captured stdout content. */
  stdout: string;
  /** Captured stderr content. */
  stderr: string;
}

/**
 * Run a command end-to-end through the framework adapter.
 * @param argv Argument vector to dispatch (`['hello']`, `['index', 'search']`, etc.).
 * @param opts Commands to register (either CommandDefinition or CommandClass), optional binary metadata, and optional Context overrides.
 * @returns `{ exitCode, stdout, stderr }` — captured outcome.
 */
export const runCommand = async (
  argv: string[],
  opts: RunCommandOptions
): Promise<RunCommandResult> => {
  const ctx = createTestContext(opts.context);
  const exitCode = await runCli(argv, {
    ctx,
    name: opts.name ?? 'ai-primitives-hub',
    version: opts.version ?? '0.0.0-test',
    commands: opts.commands ?? [],
    commandClasses: opts.commandClasses
  });
  return {
    exitCode,
    stdout: ctx.stdout.captured(),
    stderr: ctx.stderr.captured()
  };
};
