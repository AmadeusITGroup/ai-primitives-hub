import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createApplicationUseCases,
} from '../services/application-use-cases';
import * as targetModel from '../types/target';
import {
  type CliContext,
  createCliContext,
  parseCliArguments,
  renderCliHelp,
} from './cli';
import {
  executeInstallCommand,
  loadLocalBundle,
} from './commands/install';

export interface CliStreams {
  stderr: { write(chunk: string): boolean | void };
  stdout: { write(chunk: string): boolean | void };
}

/**
 * Execute the top-level CLI entrypoint.
 * @param argv
 * @param streams
 */
export async function main(
  argv: string[] = process.argv.slice(2),
  streams: CliStreams = createCliContext()
): Promise<number> {
  const context: CliContext = createCliContext(streams);

  try {
    const parsed = parseCliArguments(argv);

    if (parsed.command === 'help' || parsed.options.help) {
      context.stdout.write(`${renderCliHelp()}\n`);
      return 0;
    }

    if (parsed.command === 'install') {
      return runInstallCommand(parsed.positionals, context);
    }

    context.stderr.write(`Command "${parsed.command}" is not implemented yet.\n`);
    return 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.stderr.write(`${message}\n`);
    return 1;
  }
}

async function runInstallCommand(positionals: string[], context: CliContext): Promise<number> {
  const bundleRef = positionals[0];
  const targetValue = readFlagValue(positionals, '--target');

  if (targetValue === undefined) {
    context.stderr.write('install: --target <type> is required\n');
    return 1;
  }

  if (!targetModel.isTargetType(targetValue)) {
    context.stderr.write(
      `install: unsupported target type "${targetValue}". Supported targets: ${targetModel.TARGET_TYPES.join(', ')}.\n`
    );
    return 1;
  }

  const scopeValue = readFlagValue(positionals, '--scope');
  const target: targetModel.Target = {
    type: targetValue,
    scope: scopeValue !== undefined && targetModel.isTargetScope(scopeValue) ? scopeValue : 'user'
  };
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-registry-cli-'));

  try {
    const result = await executeInstallCommand(
      {
        bundleRef,
        target
      },
      {
        loadBundle: loadLocalBundle,
        useCases: createApplicationUseCases({
          root: tempRoot,
          now: () => '2025-01-01T00:00:00.000Z'
        })
      }
    );

    if (!result.success) {
      for (const diagnostic of result.diagnostics) {
        context.stderr.write(formatDiagnostic(diagnostic));
      }
      return 1;
    }

    context.stdout.write(`Installed ${result.bundleId}@${result.version}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.stderr.write(`${message}\n`);
    return 1;
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

function readFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return args[index + 1];
}

function formatDiagnostic(diagnostic: {
  code: string;
  message: string;
  resourceId?: string;
}): string {
  const resource = diagnostic.resourceId === undefined ? '' : ` (${diagnostic.resourceId})`;
  return `${diagnostic.code}${resource}: ${diagnostic.message}\n`;
}

if (require.main === module) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
