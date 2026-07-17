/**
 * Uninstall command for removing bundles from targets.
 *
 * Symmetric to install: supports three modes:
 *   ai-primitives-hub uninstall <bundle-id>        (by bundle ID)
 *   ai-primitives-hub uninstall --lockfile <path>  (from lockfile)
 *   ai-primitives-hub uninstall --all              (all bundles for target)
 *
 * Repository-scope targets delegate to `UninstallPipeline`
 * (`@ai-primitives-hub/app`), which already encapsulates the
 * commit/local-only two-file split (see its module doc). User/workspace
 * scope has no such split — there is a single, non-split
 * `resolveUserConfigPaths(env).userLockfile` — so those targets are
 * handled inline here with the same `readLockfile`/`removeBundleEntry`/
 * `writeLockfile` primitives `install.ts` uses to write it.
 */
import * as path from 'node:path';
import {
  cleanupOrphanedSource,
  FileTreeTargetWriter,
  type LockfileBundleEntry,
  readLockfile,
  removeBundleEntry,
  type TargetWriter,
  TransformerRegistry,
  UninstallPipeline,
  type UninstallResult,
  writeLockfile,
} from '@ai-primitives-hub/app';
import type {
  Target,
} from '@ai-primitives-hub/core';
import {
  FileSystemLayoutConfigLoader,
  readTargets,
  type RepositoryCommitMode,
  RepositoryScopeWriter,
  RepositoryScopeWriterAdapter,
  resolveUserConfigDir,
  TargetStateStore,
} from '@ai-primitives-hub/infra';
import {
  Command,
  failWith,
  findProjectLockfile,
  loadTargets,
  lockfilePathForTarget,
  Option,
} from '../framework';
import {
  type CommandDefinition,
  type Context,
  defineCommand,
  formatOutput,
  type OutputFormat,
  readTargetsSafely,
  RegistryError,
  resolveTarget,
  resolveTargetName,
  validateInputs,
} from '../framework';

/**
 * Uninstall command options.
 */
export interface UninstallOptions {
  output?: OutputFormat;
  /** Bundle id to uninstall (imperative mode). */
  bundle?: string;
  /** Lockfile path (declarative mode). */
  lockfile?: string;
  /** Target name (resolved against `targets[]` in config). */
  target?: string;
  /** Uninstall all bundles for target. */
  all?: boolean;
  /** Dry-run: preview removal without deleting files. */
  dryRun?: boolean;
  /**
   * Installation scope (user or repository).
   * Overrides target's scope if specified.
   */
  scope?: 'user' | 'repository';
  /**
   * Commit mode for repository scope.
   * Only applies when scope=repository.
   */
  commitMode?: RepositoryCommitMode;
}

/**
 * Detect uninstall context from the project environment (symmetric with install).
 * Fills in `opts.lockfile` and `opts.target` when they can be inferred.
 * @param opts Uninstall options (mutated in-place).
 * @param ctx CLI context.
 */
async function detectUninstallContext(opts: UninstallOptions, ctx: Context): Promise<void> {
  if (!opts.bundle && !opts.lockfile && !opts.all) {
    const foundLock = await findProjectLockfile(ctx);
    if (foundLock !== null) {
      opts.lockfile = foundLock;
    }
  }

  if (!opts.target || opts.target.length === 0) {
    const targets = await readTargetsSafely(
      loadTargets(ctx)
    );
    if (targets.length === 1) {
      opts.target = targets[0].name;
    }
  }
}

/**
 * Command context for the uninstall command.
 */
interface CommandContext {
  ctx: Context;
}

/**
 * Base class for the uninstall command.
 */
abstract class BaseUninstallCommand extends Command {
  public commandContext: CommandContext = { ctx: null as unknown as Context };
  public output?: OutputFormat;
}

/**
 * Native clipanion class command for uninstall.
 */
export class UninstallCommand extends BaseUninstallCommand {
  public static readonly paths = [['uninstall']];

  public static readonly usage = Command.Usage({
    description: 'Remove bundles from a configured target.',
    category: 'Install & Manage',
    details: `
      Usage: ai-primitives-hub uninstall [options]

      Options:
        --bundle <id>          Bundle id to uninstall
        --lockfile <path>      Path to a lockfile for declarative uninstallation
        --target <name>        Target name to uninstall from
        --all                  Remove all bundles for target
        --dry-run              Preview removal without deleting files
        --scope <scope>        Installation scope (user or repository)
        --commit-mode <mode>   Commit mode for repository scope
        -o, --output <format> Output format (text, json, yaml, ndjson)

      Examples:
        ai-primitives-hub uninstall --lockfile prompt-registry.lock.json --target my-vscode
        ai-primitives-hub uninstall --all --target my-vscode
        ai-primitives-hub uninstall --dry-run --target my-vscode
    `
  });

  public output = Option.String('-o', '--output') as OutputFormat | undefined;
  public bundle = Option.String('--bundle');
  public lockfile = Option.String('--lockfile');
  public target = Option.String('--target');
  public all = Option.Boolean('--all');
  public dryRun = Option.Boolean('--dry-run');
  public scope = Option.String('--scope');
  public commitMode = Option.String('--commit-mode');

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const fmt = (this.output ?? 'text');

    const opts: UninstallOptions = {
      output: fmt,
      bundle: this.bundle,
      lockfile: this.lockfile,
      target: this.target,
      all: this.all,
      dryRun: this.dryRun,
      scope: this.scope as 'user' | 'repository' | undefined,
      commitMode: this.commitMode as RepositoryCommitMode | undefined
    };

    await detectUninstallContext(opts, ctx);

    const { bundle: noBundle, lockfile: noLockfile, all: noAll } = validateInputs(opts, { flags: ['bundle', 'lockfile', 'all'] });
    if (noBundle && noLockfile && noAll) {
      return failWith(ctx, fmt, 'uninstall', new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'uninstall: provide <bundle-id>, --lockfile <path>, or --all',
        hint: 'Examples:\n'
          + '  ai-primitives-hub uninstall <bundle-id> --target my-vscode\n'
          + '  ai-primitives-hub uninstall --lockfile prompt-registry.lock.json\n'
          + '  ai-primitives-hub uninstall --all\n\n'
          + 'Note: Lockfile is auto-detected in current directory and parent directories.'
      }));
    }

    try {
      const targetName = await resolveTargetName(opts.target, 'uninstall', ctx, () => readTargets({ cwd: ctx.cwd(), fs: ctx.fs }));
      const target = await resolveTarget(targetName, 'uninstall', ctx, () => readTargets({ cwd: ctx.cwd(), fs: ctx.fs }));

      if (opts.all === true) {
        return await performAllUninstall(opts, target, ctx, fmt);
      }

      if (opts.lockfile !== undefined && opts.lockfile.length > 0) {
        return await performLockfileUninstall(opts, target, ctx, fmt);
      }

      return await performBundleUninstall(opts, target, ctx, fmt);
    } catch (err) {
      if (err instanceof RegistryError) {
        return failWith(ctx, fmt, 'uninstall', err);
      }
      throw err;
    }
  }
}

/**
 * Create a writer factory that routes to the appropriate writer based on target scope.
 * - user scope → FileTreeTargetWriter
 * - repository scope → RepositoryScopeWriter
 * @param ctx CLI context.
 * @param opts Uninstall options.
 * @returns Writer factory function.
 */
export const createWriterFactory = (
  ctx: Context,
  opts: UninstallOptions
): (target: Target) => TargetWriter => {
  // Create transformer registry with built-in transformers — must match
  // install.ts's factory so `writer.remove()` computes the same on-disk
  // path that `writer.write()` used (targets with a real, non-identity
  // transformer like Kiro would otherwise resolve the wrong path).
  const transformerRegistry = TransformerRegistry.withBuiltIns();
  const layoutLoader = new FileSystemLayoutConfigLoader({
    cwd: ctx.cwd(),
    fs: ctx.fs,
    userConfigDir: resolveUserConfigDir(ctx.env)
  });

  return (target: Target): TargetWriter => {
    // Use CLI flags to override target scope if specified
    const scope = opts.scope ?? target.scope;
    const commitMode = opts.commitMode ?? target.commitMode ?? 'commit';
    const workspaceRoot = target.rootPath ?? ctx.cwd();

    if (scope === 'repository') {
      const writer = new RepositoryScopeWriter({
        fs: ctx.fs,
        workspaceRoot,
        commitMode
      });
      return new RepositoryScopeWriterAdapter(writer);
    }
    // Default to FileTreeTargetWriter for user scope
    const transformer = transformerRegistry.getTransformer(target.type);
    return new FileTreeTargetWriter({
      fs: ctx.fs,
      env: ctx.env,
      transformer,
      layoutLoader
    });
  };
};

/**
 * Remove a single bundle's files + lockfile entry directly against the
 * non-split user-scope lockfile. Mirrors `UninstallPipeline.run`'s
 * shape, minus the commit/local-only split that only applies to
 * repository scope.
 * @param bundleId Bundle id to remove.
 * @param lockPath Absolute path to the user-scope lockfile.
 * @param target Target being uninstalled from.
 * @param ctx CLI context.
 * @param writer Target writer.
 * @returns Uninstall result (matches `UninstallPipeline`'s shape).
 */
export async function runUserScopeUninstall(
  bundleId: string,
  lockPath: string,
  target: Target,
  ctx: Context,
  writer: TargetWriter
): Promise<UninstallResult> {
  const lock = await readLockfile(lockPath, ctx.fs);
  const entry = lock?.bundles[bundleId];
  if (lock === null || entry === undefined) {
    return { bundleId, removed: [], skipped: [] };
  }

  const removed: string[] = [];
  const skipped: string[] = [];
  for (const file of entry.files) {
    try {
      await writer.remove(target, file.path);
      removed.push(file.path);
    } catch {
      skipped.push(file.path);
    }
  }

  let next = removeBundleEntry(lock, bundleId);
  next = cleanupOrphanedSource(next, entry.sourceId);
  await writeLockfile(lockPath, next, ctx.fs);

  return { bundleId, removed, skipped };
}

/**
 * Remove every bundle tracked in the non-split user-scope lockfile.
 * Mirrors `UninstallPipeline.runAll`.
 * @param lockPath Absolute path to the user-scope lockfile.
 * @param target Target being uninstalled from.
 * @param ctx CLI context.
 * @param writer Target writer.
 * @returns Uninstall results, one per bundle removed.
 */
async function runAllUserScopeUninstall(
  lockPath: string,
  target: Target,
  ctx: Context,
  writer: TargetWriter
): Promise<UninstallResult[]> {
  const lock = await readLockfile(lockPath, ctx.fs);
  if (lock === null) {
    return [];
  }
  const results: UninstallResult[] = [];
  for (const bundleId of Object.keys(lock.bundles)) {
    results.push(await runUserScopeUninstall(bundleId, lockPath, target, ctx, writer));
  }
  return results;
}

/**
 * Look up a bundle entry for dry-run/preview purposes, from either the
 * repository-scope lockfile pair or the single user-scope lockfile.
 * @param bundleId Bundle id to look up.
 * @param target Target being uninstalled from.
 * @param opts Uninstall options.
 * @param ctx CLI context.
 * @returns The entry if found, else `null`.
 */
async function findBundleEntry(
  bundleId: string,
  target: Target,
  opts: UninstallOptions,
  ctx: Context
): Promise<LockfileBundleEntry | null> {
  const scope = opts.scope ?? target.scope;
  if (scope === 'repository') {
    const pipeline = new UninstallPipeline({
      fs: ctx.fs,
      target,
      repositoryPath: target.rootPath ?? ctx.cwd(),
      writerFactory: createWriterFactory(ctx, opts)
    });
    const plan = await pipeline.plan(bundleId);
    return plan.lockfileEntry;
  }
  const lockPath = lockfilePathForTarget(ctx, target);
  const lock = await readLockfile(lockPath, ctx.fs);
  return lock?.bundles[bundleId] ?? null;
}

/**
 * Load every bundle entry for dry-run/preview purposes.
 * @param target Target being uninstalled from.
 * @param opts Uninstall options.
 * @param ctx CLI context.
 * @returns Map of bundle id to lockfile entry.
 */
async function findAllBundleEntries(
  target: Target,
  opts: UninstallOptions,
  ctx: Context
): Promise<Record<string, LockfileBundleEntry>> {
  const scope = opts.scope ?? target.scope;
  if (scope === 'repository') {
    const pipeline = new UninstallPipeline({
      fs: ctx.fs,
      target,
      repositoryPath: target.rootPath ?? ctx.cwd(),
      writerFactory: createWriterFactory(ctx, opts)
    });
    const plans = await pipeline.planAll();
    const out: Record<string, LockfileBundleEntry> = {};
    for (const plan of plans) {
      if (plan.lockfileEntry !== null) {
        out[plan.bundleId] = plan.lockfileEntry;
      }
    }
    return out;
  }
  const lockPath = lockfilePathForTarget(ctx, target);
  const lock = await readLockfile(lockPath, ctx.fs);
  return lock?.bundles ?? {};
}

/**
 * Perform uninstall by bundle ID.
 * @param opts Uninstall options.
 * @param target Target configuration.
 * @param ctx CLI context.
 * @param fmt Output format.
 * @returns Exit code.
 */
async function performBundleUninstall(
  opts: UninstallOptions,
  target: Target,
  ctx: Context,
  fmt: OutputFormat
): Promise<number> {
  const bundleId = opts.bundle as string;
  const entry = await findBundleEntry(bundleId, target, opts, ctx);

  if (entry === null) {
    formatOutput({
      ctx,
      command: 'uninstall',
      output: fmt,
      status: 'warning',
      data: {
        target: target.name,
        bundle: bundleId,
        reason: 'not found in lockfile'
      },
      textRenderer: (d) => `Bundle "${d.bundle}" is not installed in target "${d.target}". Nothing to uninstall.\n`
    });
    return 0;
  }

  // Dry-run: show what would be removed without deleting
  if (opts.dryRun === true) {
    formatOutput({
      ctx,
      command: 'uninstall',
      output: fmt,
      status: 'ok',
      data: {
        dryRun: true,
        target: target.name,
        bundle: bundleId,
        files: entry.files.map((f) => f.path)
      },
      textRenderer: (d) => `[dry-run] Would uninstall bundle "${d.bundle}" from target "${d.target}":\n`
        + `  Files: ${d.files.join(', ')}\n`
        + 'Run without --dry-run to apply.\n'
    });
    return 0;
  }

  const scope = opts.scope ?? target.scope;
  const writerFactory = createWriterFactory(ctx, opts);
  let result: UninstallResult;
  let lockPath: string;
  if (scope === 'repository') {
    const commitMode = entry.commitMode ?? opts.commitMode ?? target.commitMode ?? 'commit';
    lockPath = lockfilePathForTarget(ctx, target, commitMode);
    const pipeline = new UninstallPipeline({
      fs: ctx.fs,
      target,
      repositoryPath: target.rootPath ?? ctx.cwd(),
      writerFactory
    });
    result = await pipeline.run(bundleId);
  } else {
    lockPath = lockfilePathForTarget(ctx, target);
    result = await runUserScopeUninstall(bundleId, lockPath, target, ctx, writerFactory(target));
  }

  // Update target state
  await updateTargetState(ctx, target.name, bundleId);

  formatOutput({
    ctx,
    command: 'uninstall',
    output: fmt,
    status: 'ok',
    data: {
      target: target.name,
      bundle: bundleId,
      removed: result.removed,
      lockfile: lockPath
    },
    textRenderer: (d) => `Uninstalled ${d.bundle} from target "${d.target}" `
      + `(${d.removed.length} file${d.removed.length === 1 ? '' : 's'} removed). `
      + `Updated ${d.lockfile}.\n`
  });
  return 0;
}

/**
 * Perform uninstall from lockfile.
 * @param opts Uninstall options.
 * @param target Target configuration.
 * @param ctx CLI context.
 * @param fmt Output format.
 * @returns Exit code.
 */
async function performLockfileUninstall(
  opts: UninstallOptions,
  target: Target,
  ctx: Context,
  fmt: OutputFormat
): Promise<number> {
  const lockfile = opts.lockfile as string;
  const lockPath = path.isAbsolute(lockfile)
    ? lockfile
    : path.join(ctx.cwd(), lockfile);
  const lock = await readLockfile(lockPath, ctx.fs);

  if (lock === null) {
    formatOutput({
      ctx,
      command: 'uninstall',
      output: fmt,
      status: 'ok',
      data: { lockfile: lockPath, target: target.name, uninstalled: 0 },
      textRenderer: (d) => `No lockfile found at ${d.lockfile}. Nothing to uninstall.\n`
    });
    return 0;
  }

  const bundleIds = Object.keys(lock.bundles);

  // Dry-run: show what would be removed without deleting
  if (opts.dryRun === true) {
    const allFiles = bundleIds.flatMap((id) => lock.bundles[id].files.map((f) => f.path));
    formatOutput({
      ctx,
      command: 'uninstall',
      output: fmt,
      status: 'ok',
      data: {
        dryRun: true,
        lockfile: lockPath,
        target: target.name,
        bundles: bundleIds,
        files: allFiles
      },
      textRenderer: (d) => `[dry-run] Would uninstall ${d.bundles.length} bundle${d.bundles.length === 1 ? '' : 's'} from target "${d.target}" (from ${d.lockfile}):\n`
        + `  Bundles: ${d.bundles.join(', ')}\n`
        + `  Files: ${d.files.length} total\n`
        + 'Run without --dry-run to apply.\n'
    });
    return 0;
  }

  const writerFactory = createWriterFactory(ctx, opts);
  let results: UninstallResult[];
  const scope = opts.scope ?? target.scope;
  if (scope === 'repository') {
    const pipeline = new UninstallPipeline({
      fs: ctx.fs,
      target,
      repositoryPath: path.dirname(lockPath),
      writerFactory
    });
    results = await pipeline.runFromLockfile();
  } else {
    results = await runAllUserScopeUninstall(lockPath, target, ctx, writerFactory(target));
  }

  if (results.length === 0) {
    formatOutput({
      ctx,
      command: 'uninstall',
      output: fmt,
      status: 'ok',
      data: {
        lockfile: lockPath,
        target: target.name,
        uninstalled: 0
      },
      textRenderer: (d) => `No bundles found to uninstall from target "${d.target}".\n`
    });
    return 0;
  }

  formatOutput({
    ctx,
    command: 'uninstall',
    output: fmt,
    status: 'ok',
    data: {
      lockfile: lockPath,
      target: target.name,
      uninstalled: results.length,
      bundles: results.map((r) => ({ id: r.bundleId, removed: r.removed.length }))
    },
    textRenderer: (d) => `Uninstalled ${d.uninstalled} bundle${d.uninstalled === 1 ? '' : 's'} `
      + `from target "${d.target}" (from ${d.lockfile}).\n`
  });
  return 0;
}

/**
 * Perform uninstall of all bundles for target.
 * @param opts Uninstall options.
 * @param target Target configuration.
 * @param ctx CLI context.
 * @param fmt Output format.
 * @returns Exit code.
 */
async function performAllUninstall(
  opts: UninstallOptions,
  target: Target,
  ctx: Context,
  fmt: OutputFormat
): Promise<number> {
  const entries = await findAllBundleEntries(target, opts, ctx);
  const bundleIds = Object.keys(entries);

  // Dry-run: show what would be removed without deleting
  if (opts.dryRun === true) {
    const allFiles = bundleIds.flatMap((id) => entries[id].files.map((f) => f.path));
    formatOutput({
      ctx,
      command: 'uninstall',
      output: fmt,
      status: 'ok',
      data: {
        dryRun: true,
        target: target.name,
        bundles: bundleIds,
        files: allFiles
      },
      textRenderer: (d) => `[dry-run] Would uninstall all bundles from target "${d.target}":\n`
        + `  Bundles: ${d.bundles.join(', ')}\n`
        + `  Files: ${d.files.length} total\n`
        + 'Run without --dry-run to apply.\n'
    });
    return 0;
  }

  const writerFactory = createWriterFactory(ctx, opts);
  const scope = opts.scope ?? target.scope;
  let results: UninstallResult[];
  if (scope === 'repository') {
    const pipeline = new UninstallPipeline({
      fs: ctx.fs,
      target,
      repositoryPath: target.rootPath ?? ctx.cwd(),
      writerFactory
    });
    results = await pipeline.runAll();
  } else {
    const lockPath = lockfilePathForTarget(ctx, target);
    results = await runAllUserScopeUninstall(lockPath, target, ctx, writerFactory(target));
  }

  if (results.length === 0) {
    formatOutput({
      ctx,
      command: 'uninstall',
      output: fmt,
      status: 'ok',
      data: {
        target: target.name,
        uninstalled: 0
      },
      textRenderer: (d) => `No bundles installed in target "${d.target}". Nothing to uninstall.\n`
    });
    return 0;
  }

  // Update target state (clear all bundles)
  const stateStore = new TargetStateStore({
    fs: ctx.fs,
    statePath: path.join(ctx.cwd(), '.ai-primitives-hub', 'target-state.json')
  });
  await stateStore.save({
    targetName: target.name,
    lastInstalledBundles: [],
    lastUsedAt: new Date().toISOString()
  });

  formatOutput({
    ctx,
    command: 'uninstall',
    output: fmt,
    status: 'ok',
    data: {
      target: target.name,
      uninstalled: results.length,
      bundles: results.map((r) => ({ id: r.bundleId, removed: r.removed.length }))
    },
    textRenderer: (d) => `Uninstalled ${d.uninstalled} bundle${d.uninstalled === 1 ? '' : 's'} `
      + `from target "${d.target}".\n`
  });
  return 0;
}

/**
 * Update target state by removing bundle.
 * @param ctx CLI context.
 * @param targetName Target name.
 * @param bundleId Bundle ID to remove.
 */
async function updateTargetState(ctx: Context, targetName: string, bundleId: string): Promise<void> {
  const stateStore = new TargetStateStore({
    fs: ctx.fs,
    statePath: path.join(ctx.cwd(), '.ai-primitives-hub', 'target-state.json')
  });
  const existingState = await stateStore.load(targetName);
  const newBundles = existingState?.lastInstalledBundles ?? [];
  const bundleIndex = newBundles.findIndex((b) => b.bundleId === bundleId);
  if (bundleIndex !== -1) {
    newBundles.splice(bundleIndex, 1);
  }
  await stateStore.save({
    targetName,
    lastInstalledBundles: newBundles,
    lastUsedAt: new Date().toISOString()
  });
}

/**
 * Build the `uninstall` command.
 * @param opts - Command options.
 * @returns CommandDefinition wired to the framework adapter.
 */
export const createUninstallCommand = (
  opts: UninstallOptions = {}
): CommandDefinition =>
  defineCommand({
    path: ['uninstall'],
    description: 'Remove bundles from a configured target.',
    category: 'Install & Manage',
    run: async ({ ctx }: { ctx: Context }): Promise<number> => {
      const fmt = opts.output ?? 'text';
      const { bundle: noBundle, lockfile: noLockfile, all: noAll } = validateInputs(opts, { flags: ['bundle', 'lockfile', 'all'] });
      if (noBundle && noLockfile && noAll) {
        return failWith(ctx, fmt, 'uninstall', new RegistryError({
          code: 'USAGE.MISSING_FLAG',
          message: 'uninstall: provide <bundle-id>, --lockfile <path>, or --all',
          hint: 'Examples:\n'
            + '  ai-primitives-hub uninstall <bundle-id> --target my-vscode\n'
            + '  ai-primitives-hub uninstall --lockfile prompt-registry.lock.json\n'
            + '  ai-primitives-hub uninstall --all --target my-vscode'
        }));
      }

      try {
        const targetName = await resolveTargetName(opts.target, 'uninstall', ctx, () => readTargets({ cwd: ctx.cwd(), fs: ctx.fs }));
        const target = await resolveTarget(targetName, 'uninstall', ctx, () => readTargets({ cwd: ctx.cwd(), fs: ctx.fs }));

        if (opts.all === true) {
          return await performAllUninstall(opts, target, ctx, fmt);
        }

        if (opts.lockfile !== undefined && opts.lockfile.length > 0) {
          return await performLockfileUninstall(opts, target, ctx, fmt);
        }

        return await performBundleUninstall(opts, target, ctx, fmt);
      } catch (err) {
        if (err instanceof RegistryError) {
          return failWith(ctx, fmt, 'uninstall', err);
        }
        throw err;
      }
    }
  });
