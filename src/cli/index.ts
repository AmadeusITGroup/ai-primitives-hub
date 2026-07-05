import {
  parseCliArguments,
  renderCliHelp,
} from './cli';

export interface CliStreams {
  stderr: Pick<NodeJS.WriteStream, 'write'>;
  stdout: Pick<NodeJS.WriteStream, 'write'>;
}

const defaultCliStreams: CliStreams = {
  stdout: process.stdout,
  stderr: process.stderr
};

/**
 * Execute the top-level CLI entrypoint.
 * @param argv
 * @param streams
 */
export function main(
  argv: string[] = process.argv.slice(2),
  streams: CliStreams = defaultCliStreams
): Promise<number> {
  try {
    const parsed = parseCliArguments(argv);

    if (parsed.command === 'help' || parsed.options.help) {
      streams.stdout.write(`${renderCliHelp()}\n`);
      return Promise.resolve(0);
    }

    streams.stderr.write(`Command "${parsed.command}" is not implemented yet.\n`);
    return Promise.resolve(1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    streams.stderr.write(`${message}\n`);
    return Promise.resolve(1);
  }
}

void main().then((exitCode) => {
  process.exitCode = exitCode;
});
