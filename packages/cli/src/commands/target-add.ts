/**
 * `target add`.
 *
 * Wires the persist side: parse + validate input, then
 * delegate to `addTarget()` from the infra/stores/target-store module.
 * The command writes to the nearest project config (cargo upward
 * walk), creating one in `cwd` when none exists.
 *
 * Per-type fields are kept minimal at this point: `--scope`, `--path`,
 * `--allowed-kinds <a,b,c>`. The Target tagged-union admits more
 * fields in future iterations as target writers grow.
 */
import * as path from 'node:path';
import type {
  Target,
  TargetType,
} from '@prompt-registry/core';
import {
  TARGET_TYPES,
} from '@prompt-registry/core';
import {
  addTarget,
} from '@prompt-registry/infra';
import {
  Command,
  Context,
  failWith,
  formatOutput,
  getCommandContext,
  Option,
  type OutputFormat,
  RegistryError,
} from '../framework';

/**
 * Target add command options.
 */
interface TargetAddOptions {
  output?: OutputFormat;
  /** Target name (required). */
  name: string;
  /** Target type (required). */
  type: string;
  /** Optional scope override ('user' or 'repository'). */
  scope?: string;
  /** Optional path override. */
  path?: string;
  /** Optional workspace root for repository scope. */
  workspaceRoot?: string;
  /** Optional comma-separated allowed kinds. */
  allowedKinds?: string;
}

/** Known target types. */
const KNOWN_TYPES: ReadonlySet<string> = new Set(TARGET_TYPES);

/**
 * Validate target name.
 * @param name Target name.
 * @returns Registry error if invalid, null otherwise.
 */
function validateTargetName(name: string): RegistryError | null {
  if (name.length === 0) {
    return new RegistryError({
      code: 'USAGE.MISSING_FLAG',
      message: 'target add: missing target name',
      hint: 'Usage: `prompt-registry target add <name> --type <kind>`'
    });
  }
  return null;
}

/**
 * Validate target type.
 * @param type Target type.
 * @returns Registry error if invalid, null otherwise.
 */
function validateTargetType(type: string): RegistryError | null {
  if (!KNOWN_TYPES.has(type)) {
    return new RegistryError({
      code: 'USAGE.MISSING_FLAG',
      message: `target add: unknown --type "${type}"`,
      hint: `Known types: ${[...KNOWN_TYPES].toSorted((a, b) => a.localeCompare(b)).join(', ')}`,
      context: { type }
    });
  }
  return null;
}

/**
 * Normalize target path.
 * @param targetPath Target path.
 * @param cwd Current working directory.
 * @returns Normalized absolute path.
 */
function normalizeTargetPath(targetPath: string | undefined, cwd: string): string | undefined {
  if (targetPath !== undefined && targetPath.length > 0 && !path.isAbsolute(targetPath)) {
    return path.resolve(cwd, targetPath);
  }
  return targetPath;
}

/**
 * Ensure target directory exists.
 * @param fs File system interface.
 * @param targetPath Target path.
 */
async function ensureTargetDirectory(fs: Context['fs'], targetPath: string | undefined): Promise<void> {
  if (targetPath !== undefined && targetPath.length > 0) {
    try {
      await fs.mkdir(targetPath, { recursive: true });
    } catch {
      // Permission/ENOSPC etc. — non-fatal at this point;
      // activation will surface a clearer error later.
    }
  }
}

/**
 * Emit error in appropriate format.
 * @param ctx CLI context.
 * @param output Output format.
 * @param err Registry error.
 */

/**
 * Target add command class.
 * Accepts positional arguments for name and type.
 */
export class TargetAddCommand extends Command {
  public static readonly paths = [['target', 'add']];

  public static readonly usage = Command.Usage({
    description: 'Register a new install target.',
    category: 'Install & Manage',
    details: `
      Usage: prompt-registry target add <name> --type <kind> [options]

      Options:
        --type <type>              Target type (required): vscode, vscode-insiders, copilot-cli, kiro, windsurf, claude-code
        --scope <scope>            Installation scope: user (default) or repository
        --path <path>              Custom installation path
        --workspace-root <dir>     Workspace root for repository scope
        --allowed-kinds <kinds>    Comma-separated allowed primitive kinds
        -o, --output <format>     Output format (text, json, yaml, ndjson)

      Examples:
        prompt-registry target add my-copilot --type copilot-cli
        prompt-registry target add workspace-prompts --type vscode --scope repository --path .prompts
    `
  });

  public name = Option.String();
  public type = Option.String('--type');
  public scope = Option.String('--scope');
  public targetPath = Option.String('--path');
  public workspaceRoot = Option.String('--workspace-root');
  public allowedKinds = Option.String('--allowed-kinds');
  public output = Option.String('-o,--output');

  public async execute(): Promise<number> {
    const ctx = getCommandContext(this);

    const fmt = (this.output ?? 'text') as OutputFormat;

    // Build opts object from class properties
    const opts: TargetAddOptions = {
      name: this.name ?? '',
      type: this.type ?? '',
      scope: this.scope,
      path: this.targetPath,
      workspaceRoot: this.workspaceRoot,
      allowedKinds: this.allowedKinds,
      output: (this.output as OutputFormat) ?? 'text'
    };

    const validationError = validateTargetInputs(opts);
    if (validationError) {
      return failWith(ctx, fmt, 'target.add', validationError);
    }
    const cwd = ctx.cwd();
    opts.path = normalizeTargetPath(opts.path, cwd);
    const target = buildTarget(opts);
    try {
      const result = await addTarget(
        { cwd, fs: ctx.fs },
        target
      );
      await ensureTargetDirectory(ctx.fs, target.path);
      formatOutput({
        ctx,
        command: 'target.add',
        output: fmt,
        status: 'ok',
        data: { target, file: result.file, created: result.created },
        textRenderer: (d) => d.created
          ? `Created ${d.file} with target "${d.target.name}" (${d.target.type}).\n`
          : `Added target "${d.target.name}" (${d.target.type}) to ${d.file}.\n`
      });
      return 0;
    } catch (cause) {
      const error = buildTargetAddError(cause, opts);
      return failWith(ctx, fmt, 'target.add', error);
    }
  }
}

/**
 * Validate target inputs.
 * @param opts Target add options.
 * @returns Registry error if invalid, null otherwise.
 */
function validateTargetInputs(opts: TargetAddOptions): RegistryError | null {
  const nameError = validateTargetName(opts.name);
  if (nameError) {
    return nameError;
  }
  const typeError = validateTargetType(opts.type);
  if (typeError) {
    return typeError;
  }
  return null;
}

/**
 * Build target add error from cause.
 * @param cause Error cause.
 * @param opts Target add options.
 * @returns Registry error.
 */
function buildTargetAddError(cause: unknown, opts: TargetAddOptions): RegistryError {
  const message = cause instanceof Error ? cause.message : String(cause);
  const isDup = message.includes('already exists');
  return new RegistryError({
    code: isDup ? 'USAGE.MISSING_FLAG' : 'INTERNAL.UNEXPECTED',
    message: `target add: ${message}`,
    hint: isDup
      ? `Pick a different name, or run \`prompt-registry target remove ${opts.name}\` first.`
      : 'See `prompt-registry doctor` for environment diagnostics.',
    context: { name: opts.name, type: opts.type },
    cause: cause instanceof Error ? cause : undefined
  });
}

/**
 * Build target from options.
 * @param opts Target add options.
 * @returns Target configuration.
 */
const buildTarget = (opts: TargetAddOptions): Target => {
  const type = opts.type as TargetType;
  const allowedKinds = parseAllowedKinds(opts.allowedKinds);
  const scope = (opts.scope === 'repository' ? 'repository' : 'user');
  if (type === 'copilot-cli') {
    return buildCopilotCliTarget(opts, type, allowedKinds);
  }
  return buildStandardTarget(opts, type, scope, allowedKinds);
};

/**
 * Parse allowed kinds string.
 * @param allowedKinds Comma-separated kinds.
 * @returns Array of kinds.
 */
function parseAllowedKinds(allowedKinds: string | undefined): string[] | undefined {
  if (allowedKinds === undefined || allowedKinds.length === 0) {
    return undefined;
  }
  return allowedKinds.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Build Copilot CLI target.
 * @param opts Target add options.
 * @param type Target type.
 * @param allowedKinds Allowed kinds.
 * @returns Target configuration.
 */
function buildCopilotCliTarget(opts: TargetAddOptions, type: TargetType, allowedKinds: string[] | undefined): Target {
  return {
    name: opts.name,
    type,
    scope: 'user',
    ...(opts.path === undefined ? {} : { path: opts.path }),
    ...(opts.workspaceRoot === undefined ? {} : { workspaceRoot: opts.workspaceRoot }),
    ...(allowedKinds === undefined ? {} : { allowedKinds })
  };
}

/**
 * Build standard target.
 * @param opts Target add options.
 * @param type Target type.
 * @param scope Target scope.
 * @param allowedKinds Allowed kinds.
 * @returns Target configuration.
 */
function buildStandardTarget(opts: TargetAddOptions, type: TargetType, scope: string, allowedKinds: string[] | undefined): Target {
  return {
    name: opts.name,
    type,
    scope,
    ...(opts.path === undefined ? {} : { path: opts.path }),
    ...(opts.workspaceRoot === undefined ? {} : { workspaceRoot: opts.workspaceRoot }),
    ...(allowedKinds === undefined ? {} : { allowedKinds })
  } as Target;
}
