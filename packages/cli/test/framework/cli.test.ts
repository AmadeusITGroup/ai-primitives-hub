/**
 * Tests for `framework/cli.ts`.
 *
 * `runCli` is the clipanion wrapper: it should dispatch argv, inject the
 * Context into command classes, handle --help/--version, return the right
 * exit codes for usage vs internal errors, and apply `defaultOutput`.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  Command,
  type Context,
  createTestContext,
  defineCommand,
  Option,
  runCli,
} from '../../src/framework';

class EchoCommand extends Command {
  public static readonly paths = [['echo']];

  public static readonly usage = Command.Usage({
    description: 'Echo a value',
    category: 'Test'
  });

  public message = Option.String();
  public commandContext!: { ctx: Context };

  public execute(): Promise<number | void> {
    const { ctx } = this.commandContext;
    ctx.stdout.write(`echo:${this.message}`);
    return Promise.resolve(0);
  }
}

class FailCommand extends Command {
  public static readonly paths = [['fail']];

  public static readonly usage = Command.Usage({
    description: 'Fail with a command-specific exit code',
    category: 'Test'
  });

  public code = Option.String('-c,--code');
  public commandContext!: { ctx: Context };

  public execute(): Promise<number | void> {
    return Promise.resolve(Number(this.code ?? 1));
  }
}

class BoomCommand extends Command {
  public static readonly paths = [['boom']];

  public static readonly usage = Command.Usage({
    description: 'Throw an error',
    category: 'Test'
  });

  public commandContext!: { ctx: Context };

  public execute(): Promise<number | void> {
    throw new Error('boom');
  }
}

class OutputCommand extends Command {
  public static readonly paths = [['out']];

  public static readonly usage = Command.Usage({
    description: 'Use default output',
    category: 'Test'
  });

  public output = Option.String('-o,--output');
  public commandContext!: { ctx: Context };

  public execute(): Promise<number | void> {
    const { ctx } = this.commandContext;
    ctx.stdout.write(`out=${this.output}`);
    return Promise.resolve(0);
  }
}

describe('defineCommand', () => {
  it('freezes and returns the command definition', () => {
    const def = defineCommand({
      path: ['ping'],
      description: 'ping',
      run: ({ ctx }): number => {
        ctx.stdout.write('pong');
        return 0;
      }
    });
    expect(Object.isFrozen(def)).toBe(true);
    expect(def.path).toEqual(['ping']);
  });
});

describe('runCli', () => {
  it('runs a native command class and returns its exit code', async () => {
    const ctx = createTestContext();
    const exitCode = await runCli(['echo', 'hello'], {
      ctx,
      name: 'test-cli',
      version: '0.0.0-test',
      commands: [],
      commandClasses: [EchoCommand]
    });
    expect(exitCode).toBe(0);
    expect(ctx.stdout.captured()).toBe('echo:hello');
  });

  it('runs a declarative command definition', async () => {
    const ctx = createTestContext();
    const exitCode = await runCli(['ping'], {
      ctx,
      name: 'test-cli',
      version: '0.0.0-test',
      commands: [defineCommand({
        path: ['ping'],
        description: 'ping',
        run: ({ ctx: cmdCtx }: { ctx: Context }): number => {
          cmdCtx.stdout.write('pong');
          return 0;
        }
      })]
    });
    expect(exitCode).toBe(0);
    expect(ctx.stdout.captured()).toBe('pong');
  });

  it('returns 0 for bare invocation and renders global help', async () => {
    const ctx = createTestContext();
    const exitCode = await runCli([], {
      ctx,
      name: 'test-cli',
      version: '0.0.0-test',
      commands: [],
      commandClasses: [EchoCommand]
    });
    expect(exitCode).toBe(0);
    expect(ctx.stdout.captured()).toContain('Quick Start');
  });

  it('returns 0 for --help and renders global help', async () => {
    const ctx = createTestContext();
    const exitCode = await runCli(['--help'], {
      ctx,
      name: 'test-cli',
      version: '0.0.0-test',
      commands: [],
      commandClasses: [EchoCommand]
    });
    expect(exitCode).toBe(0);
    expect(ctx.stdout.captured()).toContain('Quick Start');
  });

  it('returns 0 for --version and prints the binary version', async () => {
    const ctx = createTestContext();
    const exitCode = await runCli(['--version'], {
      ctx,
      name: 'test-cli',
      version: '1.2.3',
      commands: [],
      commandClasses: [EchoCommand]
    });
    expect(exitCode).toBe(0);
    expect(ctx.stdout.captured()).toContain('test-cli 1.2.3');
  });

  it('returns 64 for an unknown command and prints a suggestion', async () => {
    const ctx = createTestContext();
    const exitCode = await runCli(['echoo', 'hello'], {
      ctx,
      name: 'test-cli',
      version: '0.0.0-test',
      commands: [],
      commandClasses: [EchoCommand]
    });
    expect(exitCode).toBe(64);
    expect(ctx.stderr.captured()).toContain('echoo');
    expect(ctx.stderr.captured()).toContain('Did you mean');
  });

  it('returns 64 for a missing required positional argument', async () => {
    const ctx = createTestContext();
    const exitCode = await runCli(['echo'], {
      ctx,
      name: 'test-cli',
      version: '0.0.0-test',
      commands: [],
      commandClasses: [EchoCommand]
    });
    expect(exitCode).toBe(64);
    expect(ctx.stderr.captured().length).toBeGreaterThan(0);
  });

  it('returns the command-declared exit code', async () => {
    const ctx = createTestContext();
    const exitCode = await runCli(['fail', '--code', '42'], {
      ctx,
      name: 'test-cli',
      version: '0.0.0-test',
      commands: [],
      commandClasses: [FailCommand]
    });
    expect(exitCode).toBe(42);
  });

  it('returns 70 when a command throws a non-UsageError', async () => {
    const ctx = createTestContext();
    const exitCode = await runCli(['boom'], {
      ctx,
      name: 'test-cli',
      version: '0.0.0-test',
      commands: [],
      commandClasses: [BoomCommand]
    });
    expect(exitCode).toBe(70);
    expect(ctx.stderr.captured()).toContain('boom');
  });

  it('returns 0 and prints per-command help for `command -h`', async () => {
    const ctx = createTestContext();
    const exitCode = await runCli(['echo', '-h'], {
      ctx,
      name: 'test-cli',
      version: '0.0.0-test',
      commands: [],
      commandClasses: [EchoCommand]
    });
    expect(exitCode).toBe(0);
    expect(ctx.stdout.captured()).toContain('Echo a value');
  });

  it('applies defaultOutput when no explicit output flag is passed', async () => {
    const ctx = createTestContext();
    const exitCode = await runCli(['out'], {
      ctx,
      name: 'test-cli',
      version: '0.0.0-test',
      commands: [],
      commandClasses: [OutputCommand],
      defaultOutput: 'json'
    });
    expect(exitCode).toBe(0);
    expect(ctx.stdout.captured()).toBe('out=json');
  });
});
