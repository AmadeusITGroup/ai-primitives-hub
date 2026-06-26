/**
 * RegistryError + renderError + failWith.
 *
 * `RegistryError`, `isRegistryError`, and related types are defined in
 * `../../domain/errors` and re-exported here for backward compatibility.
 * Only `renderError` and `failWith` live here, because they depend on
 * `Context` and `formatOutput` (CLI concepts) for stderr and structured output.
 */
import {
  isRegistryError,
  RegistryError,
} from '@prompt-registry/core';
import type {
  Context,
} from './context';
import {
  formatOutput,
} from './output';
import type {
  OutputFormat,
} from './output';

export type {
  RegistryErrorNamespace,
  RegistryErrorOptions,
} from '@prompt-registry/core';

export {
  isRegistryError,
  RegistryError,
} from '@prompt-registry/core';

/**
 * Render an error to `ctx.stderr` for human consumption. The output
 * shape is:
 *
 *   error[CODE]: <message>
 *     hint: <hint>
 *     docs: <docsUrl>
 *
 * where the hint and docs lines are omitted when absent.
 *
 * Non-RegistryError values are wrapped as `INTERNAL.UNEXPECTED` so the
 * renderer is total — callers do not need to type-narrow before
 * delegating to it.
 * @param err Anything thrown — RegistryError or otherwise.
 * @param ctx Context whose stderr will receive the rendering.
 */
export const renderError = (err: unknown, ctx: Context): void => {
  const re = isRegistryError(err) ? err : asInternalError(err);
  const lines: string[] = [`error[${re.code}]: ${re.message}`];
  if (re.hint !== undefined) {
    lines.push(`  hint: ${re.hint}`);
  }
  if (re.docsUrl !== undefined) {
    lines.push(`  docs: ${re.docsUrl}`);
  }
  ctx.stderr.write(`${lines.join('\n')}\n`);
};

const asInternalError = (err: unknown): RegistryError => {
  const message = err instanceof Error ? err.message : String(err);
  return new RegistryError({
    code: 'INTERNAL.UNEXPECTED',
    message,
    cause: err
  });
};

/**
 * Shared error formatter for CLI commands.
 *
 * Outputs structured error data for json/yaml/ndjson formats, or renders
 * human-readable error to stderr for text format. Returns exit code 1.
 * @param ctx CLI context.
 * @param output Output format (json, yaml, ndjson, text).
 * @param command Command name for structured output (e.g., 'index.build').
 * @param err RegistryError to format.
 * @returns Exit code 1.
 */
export const failWith = (
  ctx: Context,
  output: OutputFormat,
  command: string,
  err: RegistryError
): number => {
  if (output === 'json' || output === 'yaml' || output === 'ndjson') {
    formatOutput({
      ctx,
      command,
      output,
      status: 'error',
      data: null,
      errors: [err.toJSON()]
    });
  } else {
    renderError(err, ctx);
  }
  return 1;
};

/**
 * Generate a hint message for when no target is specified but multiple are configured.
 * @param configuredTargets Array of configured targets with name property.
 * @returns Hint message string.
 */
export const generateTargetHint = (configuredTargets: { name: string }[]): string => {
  return configuredTargets.length > 1
    ? `Multiple targets configured: ${configuredTargets.map((t) => t.name).join(', ')}. Specify with --target <name>.`
    : 'Configure a target with `prompt-registry target add <name> --type <kind>` first.';
};

/**
 * Safely read targets with fallback to empty array on error.
 * @param readFn Function that reads targets.
 * @returns Array of targets or empty array on error.
 */
export const readTargetsSafely = async <T>(readFn: Promise<T[]>): Promise<T[]> => {
  return readFn.catch(() => []);
};

/**
 * Throw a RegistryError when a target is not found.
 * @param commandName Command name for error message (e.g., 'install', 'uninstall').
 * @param targetName Name of the target that was not found.
 * @param targets Array of configured targets.
 * @param hintGenerator Optional function to generate hint message. Defaults to ternary hint.
 * @throws {RegistryError} Always throws with USAGE.MISSING_FLAG code.
 */
export const throwTargetNotFoundError = (
  commandName: string,
  targetName: string,
  targets: { name: string }[],
  hintGenerator?: (targets: { name: string }[]) => string
): never => {
  const defaultHint = targets.length === 0
    ? 'Run `prompt-registry target add <name> --type <kind>` to add one.'
    : `Configured targets: ${targets.map((t) => t.name).join(', ')}.`;
  const hint = hintGenerator ? hintGenerator(targets) : defaultHint;

  throw new RegistryError({
    code: 'USAGE.MISSING_FLAG',
    message: `${commandName}: target "${targetName}" is not configured`,
    hint,
    context: { target: targetName }
  });
};

/**
 * Resolve target name from options or fallback to last used target.
 * @param targetName Target name from options (may be undefined or empty).
 * @param commandName Command name for error message (e.g., 'install', 'uninstall').
 * @param ctx CLI context.
 * @param readTargetsFn Function to read configured targets.
 * @returns Resolved target name.
 * @throws {RegistryError} When target is not provided and no last used target exists.
 */
export const resolveTargetName = async <T extends { name: string }>(
  targetName: string | undefined,
  commandName: string,
  ctx: Context,
  readTargetsFn: () => Promise<T[]>
): Promise<string> => {
  if (targetName === undefined || targetName.length === 0) {
    const { TargetStateStore } = await import('@prompt-registry/infra');
    const path = await import('node:path');
    const stateStore = new TargetStateStore({
      fs: ctx.fs,
      statePath: path.default.join(ctx.cwd(), '.prompt-registry', 'target-state.json')
    });
    const lastUsed = await stateStore.getLastUsedTarget();
    if (lastUsed !== null) {
      return lastUsed;
    }
    const configuredTargets = await readTargetsSafely(readTargetsFn());
    const hint = generateTargetHint(configuredTargets);
    throw new RegistryError({
      code: 'USAGE.MISSING_FLAG',
      message: `${commandName}: --target <name> is required`,
      hint
    });
  }
  return targetName;
};

/**
 * Validate command inputs based on configured flags.
 * @param options Object containing optional string values to validate.
 * @param config Configuration of which flags to check.
 * @param config.flags
 * @returns Object with boolean flags indicating which inputs are missing.
 */
export const validateInputs = (
  options: object,
  config: { flags: string[] }
): Record<string, boolean> => {
  const result: Record<string, boolean> = {};
  const opts = options as Record<string, unknown>;
  for (const flag of config.flags) {
    const value = opts[flag];
    if (typeof value === 'string') {
      result[flag] = value === undefined || value.length === 0;
    } else if (typeof value === 'boolean') {
      result[flag] = value !== true;
    } else {
      result[flag] = true;
    }
  }
  return result;
};

/**
 * Resolve target by name.
 * @param targetName Target name.
 * @param commandName Command name for error message (e.g., 'install', 'uninstall').
 * @param _ctx CLI context (unused, kept for API compatibility).
 * @param readTargetsFn Function to read configured targets.
 * @returns Target configuration.
 * @throws {RegistryError} When target is not found.
 */
export const resolveTarget = async <T extends { name: string }>(
  targetName: string,
  commandName: string,
  _ctx: Context,
  readTargetsFn: () => Promise<T[]>
): Promise<T> => {
  const targets = await readTargetsFn();
  const target = targets.find((t) => t.name === targetName);
  if (target === undefined) {
    throwTargetNotFoundError(commandName, targetName, targets);
  }
  return target!;
};

/**
 * Get CommandContext from a command class.
 *
 * This helper extracts the Context from the commandContext property
 * and throws a consistent error if not available. Use this in CLI
 * commands to reduce duplication of the context extraction pattern.
 * @param command Command class instance with optional commandContext property.
 * @returns Context from commandContext.
 * @throws {Error} When commandContext or ctx is not available.
 */
export const getCommandContext = (command: unknown): Context => {
  const ctx = (command as { commandContext?: { ctx: Context } }).commandContext?.ctx;
  if (!ctx) {
    throw new Error('CommandContext not available');
  }
  return ctx;
};

/**
 * Validate that the active hub matches the expected hub ID.
 * @param mgr HubManager instance.
 * @param mgr.getActiveHub
 * @param hubId Expected hub ID.
 * @param commandName Command name for error message.
 * @returns Active hub configuration.
 * @throws {RegistryError} When hub is not active or not found.
 */
export const requireActiveHub = async <T>(
  mgr: { getActiveHub: () => Promise<{ id: string; config: T } | null> },
  hubId: string,
  commandName: string
): Promise<{ id: string; config: T }> => {
  const active = await mgr.getActiveHub();
  if (!active) {
    throw new RegistryError({
      code: 'HUB.NOT_FOUND',
      message: `${commandName}: no active hub`,
      hint: 'Run `prompt-registry hub add` to import a hub, then `hub use <id>` to activate it.'
    });
  }
  if (active.id !== hubId) {
    throw new RegistryError({
      code: 'HUB.NOT_FOUND',
      message: `${commandName}: hub "${hubId}" is not active`,
      hint: `Run \`prompt-registry hub use ${hubId}\` first.`
    });
  }
  return active;
};

/**
 * Validate that the active hub matches the expected hub ID and return failWith result.
 * Use this in command execute methods that return exit codes.
 * @param mgr HubManager instance.
 * @param mgr.getActiveHub
 * @param hubId Expected hub ID.
 * @param commandName Command name for error message.
 * @param ctx CLI context.
 * @param fmt Output format.
 * @returns Active hub configuration or failWith result.
 */
export const requireActiveHubOrFail = async <T>(
  mgr: { getActiveHub: () => Promise<{ id: string; config: T } | null> },
  hubId: string,
  commandName: string,
  ctx: Context,
  fmt: OutputFormat
): Promise<{ id: string; config: T } | number> => {
  const active = await mgr.getActiveHub();
  if (!active) {
    return failWith(ctx, fmt, commandName, new RegistryError({
      code: 'HUB.NOT_FOUND',
      message: `${commandName}: no active hub`,
      hint: 'Run `prompt-registry hub add` to import a hub, then `hub use <id>` to activate it.'
    }));
  }
  if (active.id !== hubId) {
    return failWith(ctx, fmt, commandName, new RegistryError({
      code: 'HUB.NOT_FOUND',
      message: `${commandName}: hub "${hubId}" is not active`,
      hint: `Run \`prompt-registry hub use ${hubId}\` first.`
    }));
  }
  return active;
};
