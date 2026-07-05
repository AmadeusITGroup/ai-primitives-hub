export const SUPPORTED_CLI_COMMANDS = [
  'list',
  'validate',
  'install',
  'update',
  'uninstall',
  'inspect'
] as const;

export type CliCommand = typeof SUPPORTED_CLI_COMMANDS[number];
export type CliOutputFormat = 'json' | 'text';

export interface ParsedCliArguments {
  command: CliCommand | 'help';
  options: {
    help: boolean;
    output: CliOutputFormat;
  };
  positionals: string[];
}

/**
 * Parse top-level CLI arguments into a command, flags, and positional values.
 * @param argv
 */
export function parseCliArguments(argv: string[]): ParsedCliArguments {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    return {
      command: 'help',
      options: {
        help: true,
        output: 'text'
      },
      positionals: []
    };
  }

  const [candidateCommand, ...rest] = argv;
  if (!isCliCommand(candidateCommand)) {
    throw new Error(`Unsupported CLI command: ${candidateCommand}`);
  }

  let output: CliOutputFormat = 'text';
  let help = false;
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];

    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }

    if (arg === '--output') {
      const value = rest[index + 1];
      if (value === 'json' || value === 'text') {
        output = value;
        index++;
        continue;
      }

      throw new Error('The --output flag requires either "text" or "json".');
    }

    positionals.push(arg);
  }

  return {
    command: candidateCommand,
    options: {
      help,
      output
    },
    positionals
  };
}

/**
 * Render the top-level CLI help text for supported commands.
 */
export function renderCliHelp(): string {
  return [
    'Usage: prompt-registry <command> [options]',
    '',
    'Commands:',
    '  list       List available or installed bundles',
    '  validate   Validate a local bundle',
    '  install    Install a bundle',
    '  update     Update an installed bundle',
    '  uninstall  Remove an installed bundle',
    '  inspect    Show bundle details',
    '',
    'Options:',
    '  --help, -h           Show command help',
    '  --output <format>    Select text or json output'
  ].join('\n');
}

function isCliCommand(value: string): value is CliCommand {
  return SUPPORTED_CLI_COMMANDS.includes(value as CliCommand);
}
