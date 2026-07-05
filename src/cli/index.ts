import {
  type CliContext,
  createCliContext,
  parseCliArguments,
  renderCliHelp,
} from './cli';

export interface CliStreams {
  stderr: { write(chunk: string): boolean | void };
  stdout: { write(chunk: string): boolean | void };
}

/**
 * Execute the top-level CLI entrypoint.
 * @param argv
 * @param streams
 */
export function main(
  argv: string[] = process.argv.slice(2),
  streams: CliStreams = createCliContext()
): Promise<number> {
  const context: CliContext = createCliContext(streams);

  try {
    const parsed = parseCliArguments(argv);

    if (parsed.command === 'help' || parsed.options.help) {
      context.stdout.write(`${renderCliHelp()}\n`);
      return Promise.resolve(0);
    }

    context.stderr.write(`Command "${parsed.command}" is not implemented yet.\n`);
    return Promise.resolve(1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.stderr.write(`${message}\n`);
    return Promise.resolve(1);
  }
}

void main().then((exitCode) => {
  process.exitCode = exitCode;
});
