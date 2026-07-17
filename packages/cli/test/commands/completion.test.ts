/**
 * Tests for `ai-primitives-hub completion`.
 *
 * Generates bash/zsh completion scripts and validates shell argument handling.
 * @module test/commands/completion
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  CompletionCommand,
} from '../../src/commands/completion';
import {
  runCommand,
} from '../../src/framework';

const run = (argv: string[]): ReturnType<typeof runCommand> =>
  runCommand(argv, { commandClasses: [CompletionCommand] });

describe('completion command', () => {
  it('generates a bash completion script', async () => {
    const result = await run(['completion', '--shell', 'bash']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('complete -F _ai_primitives_hub_completion ai-primitives-hub');
    expect(result.stdout).toContain('_ai_primitives_hub_completion()');
  });

  it('generates a zsh completion script', async () => {
    const result = await run(['completion', '--shell', 'zsh']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('#compdef ai-primitives-hub');
    expect(result.stdout).toContain('_ai_primitives_hub()');
  });

  it('fails when --shell is omitted', async () => {
    const result = await run(['completion']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--shell is required');
  });

  it('fails for an unsupported shell', async () => {
    const result = await run(['completion', '--shell', 'fish']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unsupported shell "fish"');
  });
});
