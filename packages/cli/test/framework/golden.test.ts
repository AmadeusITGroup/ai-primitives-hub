/**
 * Tests for `framework/golden.ts`.
 *
 * `runCommand` is the thin wrapper used by the command test suites. It
 * should wire `createTestContext` and `runCli` together and return the
 * captured output plus exit code.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  Command,
  type Context,
  Option,
  runCommand,
} from '../../src/framework';

class HelloCommand extends Command {
  public static readonly paths = [['hello']];

  public static readonly usage = Command.Usage({
    description: 'Say hello',
    category: 'Test'
  });

  public name = Option.String();
  public commandContext!: { ctx: Context };

  public execute(): Promise<number | void> {
    const { ctx } = this.commandContext;
    ctx.stdout.write(`hello ${this.name}`);
    return Promise.resolve(0);
  }
}

describe('runCommand', () => {
  it('runs a native command class and returns the captured result', async () => {
    const result = await runCommand(['hello', 'world'], {
      commandClasses: [HelloCommand]
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello world');
    expect(result.stderr).toBe('');
  });

  it('passes context overrides through to createTestContext', async () => {
    const result = await runCommand(['hello', 'world'], {
      commandClasses: [HelloCommand],
      context: {
        env: { GREETING: 'hi' },
        cwd: '/tmp'
      }
    });
    expect(result.exitCode).toBe(0);
  });

  it('can run declarative command definitions', async () => {
    const result = await runCommand(['greet'], {
      commands: [{
        path: ['greet'],
        description: 'Greet the test runner',
        category: 'Test',
        run: ({ ctx }): number => {
          ctx.stdout.write('greetings');
          return 0;
        }
      }]
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('greetings');
  });

  it('uses the provided binary name and version in --version output', async () => {
    const result = await runCommand(['--version'], {
      commandClasses: [HelloCommand],
      name: 'test-bin',
      version: '1.2.3'
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('test-bin 1.2.3');
  });
});
