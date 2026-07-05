export const SUPPORTED_CLI_COMMANDS = [
  'list',
  'validate',
  'install',
  'update',
  'uninstall',
  'inspect',
  'completion',
  'scaffold'
] as const;

export type CliCommand = typeof SUPPORTED_CLI_COMMANDS[number];
export type CliOutputFormat = 'json' | 'text';

export interface CliCommandDefinition {
  description: string;
  name: CliCommand;
  usage: string;
}

export interface CliWritable {
  write(chunk: string): boolean | void;
}

export interface CliContext {
  cwd: string;
  stderr: CliWritable;
  stdout: CliWritable;
}

const CLI_COMMAND_DEFINITIONS: Record<CliCommand, CliCommandDefinition> = {
  list: {
    name: 'list',
    description: 'List available or installed bundles',
    usage: 'prompt-registry list [options]'
  },
  validate: {
    name: 'validate',
    description: 'Validate a local bundle',
    usage: 'prompt-registry validate <bundle> [options]'
  },
  install: {
    name: 'install',
    description: 'Install a bundle',
    usage: 'prompt-registry install <bundle> [options]'
  },
  update: {
    name: 'update',
    description: 'Update an installed bundle',
    usage: 'prompt-registry update <bundle> [options]'
  },
  uninstall: {
    name: 'uninstall',
    description: 'Remove an installed bundle',
    usage: 'prompt-registry uninstall <bundle> [options]'
  },
  inspect: {
    name: 'inspect',
    description: 'Show bundle details',
    usage: 'prompt-registry inspect <bundle> [options]'
  },
  completion: {
    name: 'completion',
    description: 'Generate shell completion script for bash or zsh',
    usage: 'prompt-registry completion <shell> [options]'
  },
  scaffold: {
    name: 'scaffold',
    description: 'Scaffold a new collection or primitive',
    usage: 'prompt-registry scaffold <type> [options]'
  }
};

export interface ParsedCliArguments {
  command: CliCommand | 'help';
  options: {
    help: boolean;
    output: CliOutputFormat;
  };
  positionals: string[];
}

/**
 * Create the shared execution context used by CLI commands.
 * @param input
 */
export function createCliContext(input: Partial<CliContext> = {}): CliContext {
  return {
    cwd: input.cwd ?? process.cwd(),
    stdout: input.stdout ?? process.stdout,
    stderr: input.stderr ?? process.stderr
  };
}

/**
 * Retrieve the shared metadata for a supported CLI command.
 * @param command
 */
export function getCliCommandDefinition(command: CliCommand): CliCommandDefinition {
  return CLI_COMMAND_DEFINITIONS[command];
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
    ...SUPPORTED_CLI_COMMANDS.map((command) => {
      const definition = getCliCommandDefinition(command);
      return `  ${definition.name.padEnd(10)} ${definition.description}`;
    }),
    '',
    'Options:',
    '  --help, -h           Show command help',
    '  --output <format>    Select text or json output',
    '',
    'Shell Completion:',
    '  completion bash       Generate bash completion script',
    '  completion zsh        Generate zsh completion script'
  ].join('\n');
}

function isCliCommand(value: string): value is CliCommand {
  return SUPPORTED_CLI_COMMANDS.includes(value as CliCommand);
}
