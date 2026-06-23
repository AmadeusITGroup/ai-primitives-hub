/**
 * Framework adapter (clipanion wrapping).
 *
 * Invariant — only this folder is allowed to import
 * clipanion. Leaf command code uses `defineCommand` and `runCli` from
 * the public barrel; clipanion details never leak.
 *
 * Adapter contract
 *   defineCommand({ path, description, run }) — declarative definition
 *   runCli(argv, opts) — dispatch argv against registered commands and
 *                       return an exit code (never throws on usage errors)
 *
 * Exit-code policy
 *   command return value -> propagated as-is
 *   unknown command      -> 64 (EX_USAGE)
 *   thrown error         -> 70 (EX_SOFTWARE)
 *   --version / --help   -> 0
 */
import type {
  HttpClient,
  TokenProvider,
} from '@prompt-registry/core';
import {
  Builtins,
  Cli,
  Command,
  UsageError,
} from 'clipanion';
import type {
  CommandClass,
} from 'clipanion';
import type {
  Context,
} from './context';
import {
  renderGlobalHelp,
} from './help-renderer';
import {
  suggestCommand,
} from './suggest';

/**
 * Public command shape returned by `defineCommand`. Pure data plus a run
 * handler — no clipanion type leaks.
 */
export interface CommandDefinition {
  /** Noun-verb path tuple, e.g. `['index', 'search']`. */
  path: string[];
  /** One-line description shown in --help listings. */
  description: string;
  /** Handler invoked when the command is dispatched. */
  run: (args: { ctx: Context }) => number | Promise<number>;
  /** Category for grouping commands in help output. */
  category?: string;
}

/**
 * Options accepted by `runCli`.
 */
export interface RunCliOptions {
  /** Application Context (production or test). */
  ctx: Context;
  /** Registered commands (wrapped via DynamicCommand). */
  commands: CommandDefinition[];
  /** Native clipanion command classes registered directly. */
  commandClasses?: CommandClass[];
  /** Binary name used in usage output. */
  name: string;
  /** Binary version reported by --version. */
  version: string;
  /** Optional HTTP client for hub/profile commands. */
  http?: HttpClient;
  /** Optional token provider for hub/profile commands. */
  tokens?: TokenProvider;
  /** Default output format applied to commands that have no explicit -o flag. */
  defaultOutput?: string;
}

/**
 * Define a command declaratively.
 * @param def Command definition (path / description / run).
 * @returns The same definition object, frozen.
 */
export const defineCommand = (def: CommandDefinition): CommandDefinition =>
  Object.freeze({ ...def });

/**
 * Adapt an `OutputStream` to the duck-typed `Writable` shape clipanion
 * expects. Only `.write()` is invoked by clipanion's runtime for normal
 * paths; we forward to our captured sink. `.end()` and other Writable
 * methods are no-ops — clipanion does not require them for `cli.run`.
 * @param out
 * @param out.write
 */
const adaptWritable = (out: { write: (chunk: string) => void }): NodeJS.WriteStream => {
  const stream = {
    write: (chunk: string | Uint8Array): boolean => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      out.write(text);
      return true;
    },
    end: (): void => undefined
  };
  // Cast to clipanion's expected type. Clipanion's BaseContext narrows
  // the type but only calls .write/.end at runtime, so this duck-type
  // is sufficient.
  return stream as unknown as NodeJS.WriteStream;
};

const adaptReadable = (): NodeJS.ReadStream => {
  const stream = {
    read: (): null => null
  };
  return stream as unknown as NodeJS.ReadStream;
};

/**
 * Build a dynamic clipanion Command class that closes over our run
 * handler and our `Context`. `execute()` returns the exit code so
 * clipanion can propagate it unchanged.
 * @param def
 * @param ctx
 */
const toClipanionCommandClass = (
  def: CommandDefinition,
  ctx: Context
): CommandClass => {
  class DynamicCommand extends Command {
    public static readonly paths: string[][] = [def.path];
    // eslint-disable-next-line @typescript-eslint/explicit-member-accessibility -- clipanion's static factory uses PascalCase by convention; we mirror its API.
    static readonly usage = Command.Usage({ description: def.description, category: def.category });

    public async execute(): Promise<number> {
      return def.run({ ctx });
    }
  }
  return DynamicCommand;
};

/**
 * Dispatch an argv vector against the registered commands.
 * @param argv  Argument vector — typically `process.argv.slice(2)` in
 *              production, or a literal array in tests.
 * @param opts  ctx / commands / name / version.
 * @returns Exit code (0 success, 64 usage, 70 internal, or whatever
 *          the command handler returned).
 */
export const runCli = async (argv: string[], opts: RunCliOptions): Promise<number> => {
  const cli = new Cli({
    binaryName: opts.name,
    binaryVersion: opts.version,
    enableColors: opts.ctx.colorDepth > 0
  });

  // Built-in --help and --version commands.
  cli.register(Builtins.HelpCommand);
  cli.register(Builtins.VersionCommand);

  for (const def of opts.commands) {
    cli.register(toClipanionCommandClass(def, opts.ctx));
  }

  for (const cls of opts.commandClasses ?? []) {
    cli.register(cls);
  }

  const clipanionCtx = {
    env: opts.ctx.env as Record<string, string | undefined>,
    stdin: adaptReadable(),
    stdout: adaptWritable(opts.ctx.stdout),
    stderr: adaptWritable(opts.ctx.stderr),
    colorDepth: opts.ctx.colorDepth
  };

  // Bare invocation or top-level --help: render custom landing page.
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    opts.ctx.stdout.write(renderGlobalHelp(cli, opts.name, opts.version));
    return 0;
  }

  // We bypass clipanion's `cli.run` because (a) it always returns 0/1,
  // collapsing the EX_USAGE / EX_SOFTWARE distinction we need,
  // and (b) it writes errors to stdout instead of stderr.
  // Instead we use `cli.process()` to parse argv into a Command, wire
  // up the bindings clipanion's run() would otherwise set, then call
  // validateAndExecute() ourselves with a try/catch around each phase.
  let command;
  try {
    command = cli.process({ input: argv, context: clipanionCtx });
  } catch (err) {
    // process() throws on unknown command, bad flags, missing arg, etc.
    // That's EX_USAGE = 64.
    const message = err instanceof Error ? err.message : String(err);
    opts.ctx.stderr.write(`${message}\n`);

    const suggestion = suggestCommand(argv, cli, opts.name);
    if (suggestion !== undefined) {
      opts.ctx.stderr.write(`Did you mean: ${suggestion}\n`);
    }

    return 64;
  }

  // Wire bindings the way clipanion's own cli.run() does — without
  // these, HelpCommand and VersionCommand crash because they read
  // `this.context` and `this.cli`. Mirroring the binding shape from
  // clipanion's lib/advanced/Cli.js#run().
  command.context = clipanionCtx;
  command.cli = {
    binaryLabel: opts.name,
    binaryName: opts.name,
    binaryVersion: opts.version,
    enableCapture: false,
    enableColors: opts.ctx.colorDepth > 0,
    definitions: () => cli.definitions(),
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- clipanion internal API accepts any
    definition: (c: any) => cli.definition(c),
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- clipanion internal API accepts any
    error: (e: any, o: any) => cli.error(e, o),
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- clipanion internal API accepts any
    format: (c: any) => cli.format(c),

    process: (input: any, subContext: any) => cli.process({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- clipanion process() accepts any input
      input,
      context: { ...clipanionCtx, ...(subContext as object) }
    }),
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- clipanion internal API accepts any
    run: (input: any, subContext: any) => cli.run(input, { ...clipanionCtx, ...subContext }),
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- clipanion internal API accepts any
    usage: (c: any, o: any) => cli.usage(c, o)
  };

  // Inject commandContext for all native clipanion command classes.
  // Simple commands only read .ctx; hub/profile/source commands also read .http/.tokens.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- dynamic property assignment on native clipanion command instance
  (command as any).commandContext = { ctx: opts.ctx, http: opts.http, tokens: opts.tokens };

  // Apply defaultOutput when the command declares an output field but the
  // user did not pass an explicit -o / --output flag.
  if (opts.defaultOutput !== undefined) {
    const cmd = command as any;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- nullish coalescing to set default output
    cmd.output ??= opts.defaultOutput;
  }

  // Per-command --help: clipanion sets `command.help = true` when -h/
  // --help follows a registered command path. Honour that by printing
  // the detailed usage and exiting 0 — same behavior cli.run provides.
  if ((command as { help?: boolean }).help === true) {
    opts.ctx.stdout.write(cli.usage(command, { detailed: true }));
    return 0;
  }

  try {
    const exitCode = await command.validateAndExecute();
    return exitCode ?? 0;
  } catch (err) {
    if (err instanceof UsageError) {
      opts.ctx.stderr.write(`${(err as Error).message}\n`);
      return 64;
    }
    // Any other thrown error is an internal bug — EX_SOFTWARE = 70.
    const message = err instanceof Error ? err.message : String(err);
    opts.ctx.stderr.write(`${message}\n`);
    return 70;
  }
};
