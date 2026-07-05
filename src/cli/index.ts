import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createApplicationUseCases,
} from '../services/application-use-cases';
import * as targetModel from '../types/target';
import {
  type CliContext,
  type CliOutputFormat,
  createCliContext,
  parseCliArguments,
} from './cli';
import {
  executeInspectCommand,
} from './commands/inspect';
import {
  executeInstallCommand,
  loadLocalBundle,
} from './commands/install';
import {
  executeListCommand,
} from './commands/list';
import {
  executeScaffoldCommand,
} from './commands/scaffold';
import {
  executeUninstallCommand,
} from './commands/uninstall';
import {
  executeValidateCommand,
} from './commands/validate';
import {
  generateCompletion,
} from './completion';
import {
  formatDiagnostic,
  formatError,
} from './errors';
import {
  renderGlobalHelp,
} from './help-renderer';
import {
  type CliTextInspectData,
  type CliTextInstallData,
  type CliTextListEntry,
  type CliTextUninstallData,
  type CliTextValidateData,
  renderInspectText,
  renderInstallText,
  renderJsonOutput,
  renderListText,
  renderUninstallText,
  renderValidateText,
} from './output';

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
      context.stdout.write(`${renderGlobalHelp()}`);
      return 0;
    }

    const output = parsed.options.output;

    switch (parsed.command) {
      case 'install': {
        return runInstallCommand(parsed.positionals, context, output);
      }
      case 'uninstall': {
        return runUninstallCommand(parsed.positionals, context, output);
      }
      case 'validate': {
        return runValidateCommand(parsed.positionals, context, output);
      }
      case 'list': {
        return runListCommand(parsed.positionals, context, output);
      }
      case 'inspect': {
        return runInspectCommand(parsed.positionals, context, output);
      }
      case 'completion': {
        return runCompletionCommand(parsed.positionals, context);
      }
      case 'scaffold': {
        return runScaffoldCommand(parsed.positionals, context);
      }
      default: {
        context.stderr.write(`Command "${parsed.command}" is not implemented yet.\n`);
        return 1;
      }
    }
  } catch (error) {
    context.stderr.write(formatError(error));
    return 1;
  }
}

async function runInstallCommand(positionals: string[], context: CliContext, output: CliOutputFormat): Promise<number> {
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

    context.stdout.write(formatInstallOutput(result, output));
    return 0;
  } catch (error) {
    context.stderr.write(formatError(error));
    return 1;
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function runUninstallCommand(positionals: string[], context: CliContext, output: CliOutputFormat): Promise<number> {
  const bundleId = positionals[0];
  const target = parseTarget(positionals, context);
  if (target === undefined) {
    return 1;
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-registry-cli-'));
  try {
    const result = await executeUninstallCommand(
      { bundleId, target },
      { useCases: createApplicationUseCases({ root: tempRoot, now: () => '2025-01-01T00:00:00.000Z' }) }
    );

    if (!result.success) {
      for (const diagnostic of result.diagnostics) {
        context.stderr.write(formatDiagnostic(diagnostic));
      }
      return 1;
    }

    context.stdout.write(formatUninstallOutput(result, output));
    return 0;
  } catch (error) {
    context.stderr.write(formatError(error));
    return 1;
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function runValidateCommand(positionals: string[], context: CliContext, output: CliOutputFormat): Promise<number> {
  const bundleRef = positionals[0];
  const target = parseTarget(positionals, context);
  if (target === undefined) {
    return 1;
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-registry-cli-'));
  try {
    const result = await executeValidateCommand(
      { bundleRef, target },
      { loadBundle: loadLocalBundle, useCases: createApplicationUseCases({ root: tempRoot, now: () => '2025-01-01T00:00:00.000Z' }) }
    );

    if (!result.valid) {
      for (const diagnostic of result.diagnostics) {
        context.stderr.write(formatDiagnostic(diagnostic));
      }
      return 1;
    }

    context.stdout.write(formatValidateOutput(result, output));
    return 0;
  } catch (error) {
    context.stderr.write(formatError(error));
    return 1;
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function runListCommand(positionals: string[], context: CliContext, output: CliOutputFormat): Promise<number> {
  const targetValue = readFlagValue(positionals, '--target');
  let target: targetModel.Target | undefined;
  if (targetValue !== undefined) {
    if (!targetModel.isTargetType(targetValue)) {
      context.stderr.write(
        `list: unsupported target type "${targetValue}". Supported targets: ${targetModel.TARGET_TYPES.join(', ')}.\n`
      );
      return 1;
    }
    const scopeValue = readFlagValue(positionals, '--scope');
    target = {
      type: targetValue,
      scope: scopeValue !== undefined && targetModel.isTargetScope(scopeValue) ? scopeValue : 'user'
    };
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-registry-cli-'));
  try {
    const result = await executeListCommand(
      { target },
      { useCases: createApplicationUseCases({ root: tempRoot, now: () => '2025-01-01T00:00:00.000Z' }) }
    );

    context.stdout.write(formatListOutput(result.bundles, output));
    return 0;
  } catch (error) {
    context.stderr.write(formatError(error));
    return 1;
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function runInspectCommand(positionals: string[], context: CliContext, output: CliOutputFormat): Promise<number> {
  const bundleRef = positionals[0];
  const target = parseTarget(positionals, context);
  if (target === undefined) {
    return 1;
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-registry-cli-'));
  try {
    const result = await executeInspectCommand(
      { bundleRef, target },
      { loadBundle: loadLocalBundle, useCases: createApplicationUseCases({ root: tempRoot, now: () => '2025-01-01T00:00:00.000Z' }) }
    );

    context.stdout.write(formatInspectOutput(result, output));
    return 0;
  } catch (error) {
    context.stderr.write(formatError(error));
    return 1;
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

function parseTarget(positionals: string[], context: CliContext): targetModel.Target | undefined {
  const targetValue = readFlagValue(positionals, '--target');
  if (targetValue === undefined) {
    context.stderr.write('--target <type> is required\n');
    return undefined;
  }

  if (!targetModel.isTargetType(targetValue)) {
    context.stderr.write(
      `unsupported target type "${targetValue}". Supported targets: ${targetModel.TARGET_TYPES.join(', ')}.\n`
    );
    return undefined;
  }

  const scopeValue = readFlagValue(positionals, '--scope');
  return {
    type: targetValue,
    scope: scopeValue !== undefined && targetModel.isTargetScope(scopeValue) ? scopeValue : 'user'
  };
}

function readFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return args[index + 1];
}

function formatInstallOutput(result: CliTextInstallData, output: CliOutputFormat): string {
  if (output === 'json') {
    return renderJsonOutput({ command: 'install', data: result }) + '\n';
  }
  return renderInstallText(result);
}

function formatUninstallOutput(result: CliTextUninstallData, output: CliOutputFormat): string {
  if (output === 'json') {
    return renderJsonOutput({ command: 'list', data: result }) + '\n';
  }
  return renderUninstallText(result);
}

function formatValidateOutput(result: CliTextValidateData, output: CliOutputFormat): string {
  if (output === 'json') {
    return renderJsonOutput({ command: 'validate', data: result }) + '\n';
  }
  return renderValidateText(result);
}

function formatListOutput(bundles: CliTextListEntry[], output: CliOutputFormat): string {
  if (output === 'json') {
    return renderJsonOutput({ command: 'list', data: bundles }) + '\n';
  }
  return renderListText(bundles);
}

function formatInspectOutput(result: CliTextInspectData, output: CliOutputFormat): string {
  if (output === 'json') {
    return renderJsonOutput({ command: 'inspect', data: result }) + '\n';
  }
  return renderInspectText(result);
}

function runCompletionCommand(positionals: string[], context: CliContext): number {
  const shell = positionals[0];

  if (!shell) {
    context.stderr.write('completion: shell argument is required. Use "bash" or "zsh".\n');
    return 1;
  }

  if (shell !== 'bash' && shell !== 'zsh') {
    context.stderr.write(`completion: unsupported shell "${shell}". Use "bash" or "zsh".\n`);
    return 1;
  }

  context.stdout.write(generateCompletion(shell));
  return 0;
}

async function runScaffoldCommand(positionals: string[], context: CliContext): Promise<number> {
  const scaffoldType = positionals[0];

  if (!scaffoldType) {
    context.stderr.write('scaffold: type argument is required. Use "collection", "prompt", "instruction", "agent", "skill", "plugin", or "hook".\n');
    return 1;
  }

  const name = readFlagValue(positionals, '--name');
  if (!name) {
    context.stderr.write('scaffold: --name <value> is required\n');
    return 1;
  }

  const description = readFlagValue(positionals, '--description') ?? '';
  const author = readFlagValue(positionals, '--author') ?? '';
  const outputPath = readFlagValue(positionals, '--path') ?? readFlagValue(positionals, '--output');
  const tagsValue = readFlagValue(positionals, '--tags');
  const tags = tagsValue ? tagsValue.split(',').map((t) => t.trim()).filter(Boolean) : [];

  const result = await executeScaffoldCommand({
    name,
    description,
    author,
    tags: tags.length > 0 ? tags : undefined,
    path: outputPath
  });

  if (!result.success) {
    context.stderr.write(`scaffold: ${result.error ?? 'unknown error'}\n`);
    return 1;
  }

  for (const file of result.createdFiles) {
    context.stdout.write(`Created: ${file}\n`);
  }
  return 0;
}

if (require.main === module) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
