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
  ALL_COMMAND_CLASSES,
} from '../../src/commands/registry';
import {
  defineCommand,
  runCommand,
} from '../../src/framework';

const run = (argv: string[]): ReturnType<typeof runCommand> =>
  runCommand(argv, { commandClasses: [CompletionCommand] });

const runFullRegistry = (argv: string[]): ReturnType<typeof runCommand> =>
  runCommand(argv, { commandClasses: ALL_COMMAND_CLASSES });

describe('completion command', () => {
  it('documents the required shell option', async () => {
    const result = await run(['completion', '--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: ai-primitives-hub completion --shell <shell>');
    expect(result.stdout).toContain('ai-primitives-hub completion --shell bash');
    expect(result.stdout).not.toContain('ai-primitives-hub completion bash');
  });

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

  it('derives bash completions for every registered command and subcommand', async () => {
    const result = await runFullRegistry(['completion', '--shell', 'bash']);
    expect(result.exitCode).toBe(0);
    // Representative registered top-level command paths.
    expect(result.stdout).toContain("'agent create'");
    expect(result.stdout).toContain("'prompt create'");
    expect(result.stdout).toContain("'instruction create'");
    expect(result.stdout).toContain("'hook create'");
    expect(result.stdout).toContain("'plugin create'");
    expect(result.stdout).toContain("'search'");
    // Representative registered subcommand path.
    expect(result.stdout).toContain("'hub validate'");
    // Representative registered three-level command paths.
    expect(result.stdout).toContain("'index shortlist new'");
    expect(result.stdout).toContain("'index shortlist add'");
    // Representative registered command paths without deeper subcommands.
    expect(result.stdout).toContain("'bundle build'");
    expect(result.stdout).toContain("'bundle manifest'");
    expect(result.stdout).toContain("'version compute'");
    expect(result.stdout).toContain("'doctor diagnostics'");
  });

  it('includes every registered command path in bash completions', async () => {
    const result = await runFullRegistry(['completion', '--shell', 'bash']);
    expect(result.exitCode).toBe(0);

    for (const path of ALL_COMMAND_CLASSES.flatMap((commandClass) => commandClass.paths ?? [])) {
      expect(result.stdout).toContain(`'${path.join(' ')}'`);
    }
  });

  it('derives zsh completions for every registered command and subcommand', async () => {
    const result = await runFullRegistry(['completion', '--shell', 'zsh']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("'hub validate'");
    expect(result.stdout).toContain("'index shortlist new'");
    expect(result.stdout).toContain("'bundle manifest'");
    expect(result.stdout).toContain("'agent create'");
  });

  it('includes every registered command path in zsh completions', async () => {
    const result = await runFullRegistry(['completion', '--shell', 'zsh']);
    expect(result.exitCode).toBe(0);

    for (const path of ALL_COMMAND_CLASSES.flatMap((commandClass) => commandClass.paths ?? [])) {
      expect(result.stdout).toContain(`'${path.join(' ')}'`);
    }
  });

  it('declares zsh loop variables outside the path loop', async () => {
    const result = await runFullRegistry(['completion', '--shell', 'zsh']);
    expect(result.exitCode).toBe(0);
    const loopStart = result.stdout.indexOf('for __aiph_path_str');
    const loopBody = result.stdout.slice(loopStart);

    expect(result.stdout).toContain('  local __aiph_i\n');
    expect(result.stdout).toContain('  local __aiph_cand\n');
    expect(loopBody).not.toContain('local __aiph_i');
    expect(loopBody).not.toContain('local __aiph_cand=');
  });

  it('includes declarative CommandDefinition paths (opts.commands) alongside command classes', async () => {
    const legacyStatus = defineCommand({
      path: ['legacy-status'],
      description: 'A declaratively-registered command.',
      run: () => 0
    });

    const result = await runCommand(['completion', '--shell', 'bash'], {
      commandClasses: [CompletionCommand],
      commands: [legacyStatus]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("'legacy-status'");
  });

  it('single-quote-escapes a path segment containing a single quote', async () => {
    const maliciousCommand = defineCommand({
      path: [String.raw`weird'; printf hacked; echo '`],
      description: 'A path segment attempting to break out of its shell literal.',
      run: () => 0
    });

    const result = await runCommand(['completion', '--shell', 'bash'], {
      commandClasses: [CompletionCommand],
      commands: [maliciousCommand]
    });

    expect(result.exitCode).toBe(0);
    // The single quote is escaped (closed, escaped, reopened) rather than
    // left to terminate the literal early.
    expect(result.stdout).toContain(String.raw`'weird'\''; printf hacked; echo '\'''`);
    expect(result.stdout).not.toContain('printf hacked;\n');
  });
});
