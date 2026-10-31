/**
 * Uninstall command for removing bundles from targets.
 *
 * Symmetric to install: supports three modes:
 *   ai-primitives-hub uninstall <bundle-id>        (by bundle ID)
 *   ai-primitives-hub uninstall --lockfile <path>  (from lockfile)
 *   ai-primitives-hub uninstall --all              (all bundles for target)
 *
 * Repository-scope `<bundle-id>` and `--all` uninstalls first use the 3.0.0
 * install record, keeping files another entry lists or that were edited since
 * the install; bundles not recorded there fall back to the old store.
 *
 * `uninstall --lockfile <ai-primitives-hub.*.lock.json>` removes only the
 * target tool's entries, and `uninstall <id>` without `--target` is refused
 * when the record lists the bundle for several tools.
 *
 * Repository-scope targets otherwise delegate to `UninstallPipeline`
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
  mapToolToTarget,
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
  type RepositoryCommitMode,
  RepositoryScopeWriter,
  RepositoryScopeWriterAdapter,
  resolveUserConfigDir,
  TargetStateStore,
} from '@ai-primitives-hub/infra';
import {
  Command,
  type CommandDefinition,
  type Context,
  defineCommand,
  failWith,
  findProjectLockfile,
  formatOutput,
  loadTargets,
  lockfilePathForTarget,
  Option,
  type OutputFormat,
  type PreparedRecordSelection,
  type PreparedRepositoryUninstall,
  prepareRecordSelection,
  prepareRepositoryUninstall,
  prepareUserUninstall,
  readTargetsSafely,
  recordOutputFields,
  type RecordOutputFields,
  recordRepositoryUninstall,
  RegistryError,
  renderRecordLine,
  resolveEffectiveTarget,
  resolveTarget,
  resolveTargetName,
  validateInputs,
  writerEnv,
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
 * Refuse `uninstall <id>` without `--target` when the record lists the bundle for several tools.
 * @param ctx CLI context.
 * @param bundleId Bundle to uninstall.
 * @param scope `--scope`, when given.
 * @throws {RegistryError} `USAGE.MISSING_FLAG` listing the tools; nothing was removed.
 * @throws {RegistryError} A `RECORD.*` error naming the file.
 */
async function refuseMultiToolUninstall(ctx: Context, bundleId: string, scope?: UninstallOptions['scope']): Promise<void> {
  const { selection, service } = await prepareRecordSelection(ctx, { command: 'uninstall', scope });
  if (selection.level !== 'repository' && (selection.level !== 'user' || selection.locations.length === 0)) {
    return;
  }
  const tools = [...new Set((await service.listEntries(selection.locations))
    .filter((row) => row.bundleId === bundleId)
    .map((row) => row.tool))];
  if (tools.length > 1) {
    throw new RegistryError({
      code: 'USAGE.MISSING_FLAG',
      message: `uninstall: bundle "${bundleId}" is installed for several tools (${tools.join(', ')}); pass --target to choose one`,
      hint: `Example: ai-primitives-hub uninstall --bundle ${bundleId} --target <name of a ${tools[0]} target>`,
      context: { bundle: bundleId, tools }
    });
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

    const typedTarget = opts.target !== undefined && opts.target.length > 0;
    try {
      // Checked before the target is inferred, so one configured target never picks one of several recorded tools.
      if (!typedTarget && opts.bundle !== undefined && opts.bundle.length > 0 && opts.all !== true
        && (opts.lockfile === undefined || opts.lockfile.length === 0)) {
        await refuseMultiToolUninstall(ctx, opts.bundle, opts.scope);
      }
    } catch (err) {
      if (err instanceof RegistryError) {
        return failWith(ctx, fmt, 'uninstall', err);
      }
      throw err;
    }

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
      const targetName = await resolveTargetName(opts.target, 'uninstall', ctx, () => loadTargets(ctx));
      const configuredTarget = await resolveTarget(targetName, 'uninstall', ctx, () => loadTargets(ctx));
      const target = resolveEffectiveTarget(ctx, configuredTarget, opts);

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
    const effectiveTarget = resolveEffectiveTarget(ctx, target, opts);
    const scope = effectiveTarget.scope;
    const commitMode = effectiveTarget.commitMode ?? 'commit';
    const workspaceRoot = effectiveTarget.rootPath ?? ctx.cwd();

    const copilotLikeTargets = new Set<string>(['vscode', 'vscode-insiders', 'copilot-cli']);
    if (scope === 'repository' && copilotLikeTargets.has(effectiveTarget.type)) {
      const writer = new RepositoryScopeWriter({
        fs: ctx.fs,
        workspaceRoot,
        commitMode
      });
      return new RepositoryScopeWriterAdapter(writer);
    }
    // Default to FileTreeTargetWriter for user scope
    const transformer = transformerRegistry.getTransformer(effectiveTarget.type);
    return new FileTreeTargetWriter({
      fs: ctx.fs,
      env: writerEnv(ctx.env, scope),
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
      // Manifest-driven installs record where each file landed.
      await (file.installedPath === undefined
        ? writer.remove(target, file.path)
        : writer.remove(target, file.path, file.installedPath));
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
 * @param exclude Bundle ids already uninstalled from the user record, left alone here.
 * @returns Uninstall results, one per bundle removed.
 */
async function runAllUserScopeUninstall(
  lockPath: string,
  target: Target,
  ctx: Context,
  writer: TargetWriter,
  exclude: ReadonlySet<string> = new Set()
): Promise<UninstallResult[]> {
  const lock = await readLockfile(lockPath, ctx.fs);
  if (lock === null) {
    return [];
  }
  const results: UninstallResult[] = [];
  for (const bundleId of Object.keys(lock.bundles).filter((id) => !exclude.has(id))) {
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
  if (target.scope === 'repository') {
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
  if (target.scope === 'repository') {
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
 * Print the dry run of a one-bundle uninstall.
 * @param ctx CLI context.
 * @param fmt Output format.
 * @param target Target the bundle is uninstalled from.
 * @param bundleId Bundle id.
 * @param files Paths that would be removed.
 * @returns Exit code.
 */
function renderBundleDryRun(ctx: Context, fmt: OutputFormat, target: Target, bundleId: string, files: readonly string[]): number {
  formatOutput({
    ctx,
    command: 'uninstall',
    output: fmt,
    status: 'ok',
    data: { dryRun: true, target: target.name, bundle: bundleId, files: [...files] },
    textRenderer: (d) => `[dry-run] Would uninstall bundle "${d.bundle}" from target "${d.target}":\n`
      + `  Files: ${d.files.join(', ')}\n`
      + 'Run without --dry-run to apply.\n'
  });
  return 0;
}

/** What a one-bundle uninstall removed, for {@link renderBundleUninstalled}. */
interface BundleUninstalled {
  bundleId: string;
  /** Paths removed. */
  removed: readonly string[];
  /** Lockfile or install record updated. */
  lockfile: string;
  /** Non-fatal problems to report; none for the old lockfile path. */
  warnings?: readonly string[];
  /** The record's `level` / `records` fields; none for the old lockfile path. */
  record?: RecordOutputFields;
}

/**
 * Print the outcome of a one-bundle uninstall.
 * @param ctx CLI context.
 * @param fmt Output format.
 * @param target Target the bundle was uninstalled from.
 * @param outcome Bundle, removed files, updated file and warnings.
 * @returns Exit code.
 */
function renderBundleUninstalled(ctx: Context, fmt: OutputFormat, target: Target, outcome: BundleUninstalled): number {
  formatOutput({
    ctx,
    command: 'uninstall',
    output: fmt,
    status: 'ok',
    data: {
      ...(outcome.record === undefined ? {} : { level: outcome.record.level, records: [...outcome.record.records] }),
      target: target.name,
      bundle: outcome.bundleId,
      removed: [...outcome.removed],
      lockfile: outcome.lockfile
    },
    warnings: outcome.warnings !== undefined && outcome.warnings.length > 0 ? [...outcome.warnings] : undefined,
    textRenderer: (d) => `Uninstalled ${d.bundle} from target "${d.target}" `
      + `(${d.removed.length} file${d.removed.length === 1 ? '' : 's'} removed). `
      + `Updated ${d.lockfile}.\n`
      + (outcome.record === undefined ? '' : renderRecordLine(outcome.record))
  });
  return 0;
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
  if (target.scope === 'repository' || target.scope === 'user') {
    // A RECORD.* error stops here with nothing removed; unrecorded bundles fall back to the old store.
    const prepared = target.scope === 'repository'
      ? await prepareRepositoryUninstall(ctx, target)
      : await prepareUserUninstall(ctx, target);
    const recordedFiles = prepared.entries.get(bundleId);
    if (recordedFiles !== undefined) {
      return await performRecordBundleUninstall({ opts, target, ctx, fmt }, prepared, bundleId, recordedFiles);
    }
  }
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
    return renderBundleDryRun(ctx, fmt, target, bundleId, entry.files.map((f) => f.path));
  }

  const writerFactory = createWriterFactory(ctx, opts);
  let result: UninstallResult;
  let lockPath: string;
  if (target.scope === 'repository') {
    const commitMode = entry.commitMode ?? target.commitMode ?? 'commit';
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

  return renderBundleUninstalled(ctx, fmt, target, { bundleId, removed: result.removed, lockfile: lockPath });
}

/** Arguments every uninstall mode shares. */
interface UninstallRun {
  opts: UninstallOptions;
  target: Target;
  ctx: Context;
  fmt: OutputFormat;
}

/**
 * Uninstall one bundle recorded in the repository install record for the target's type.
 * @param run Options, target, context and output format.
 * @param prepared Both record files, loaded and checked.
 * @param bundleId Bundle to uninstall.
 * @param recordedFiles Its recorded root-relative paths, for the dry run.
 * @returns Exit code.
 */
async function performRecordBundleUninstall(
  run: UninstallRun,
  prepared: PreparedRepositoryUninstall,
  bundleId: string,
  recordedFiles: string[]
): Promise<number> {
  const { opts, target, ctx, fmt } = run;
  if (opts.dryRun === true) {
    return renderBundleDryRun(ctx, fmt, target, bundleId, recordedFiles);
  }

  const recorded = await recordRepositoryUninstall(prepared, bundleId);
  await updateTargetState(ctx, target.name, bundleId);

  return renderBundleUninstalled(ctx, fmt, target, {
    bundleId,
    removed: recorded.removed,
    lockfile: recorded.lockfile,
    warnings: recorded.warnings,
    record: { level: prepared.location.level, records: [recorded.lockfile] }
  });
}

/**
 * `uninstall --lockfile <record file>`: remove only the target tool's entries, keeping files another entry lists or that were edited since the install.
 * @param run Options, target, context and output format.
 * @param prepared The selected record file, loaded and checked.
 * @returns Exit code.
 * @throws {RegistryError} A `RECORD.*` error naming the file; `USAGE.INVALID_FLAG` when the target does not write to the record.
 */
async function performRecordLockfileUninstall(run: UninstallRun, prepared: PreparedRecordSelection): Promise<number> {
  const { target, ctx, fmt, opts } = run;
  const { selection, fs } = prepared;
  const mapping = await mapToolToTarget({ fs, tool: target.type, level: selection.level, gitRoot: selection.root, targets: [], explicit: target, cwd: ctx.cwd() });
  if ('skip' in mapping) {
    throw new RegistryError({
      code: 'USAGE.INVALID_FLAG',
      message: `uninstall: ${mapping.skip}`,
      hint: 'Pass a --target whose scope and repository match the record.'
    });
  }
  // Use the selected file's git root info/exclude, as the install did.
  const uninstall = await prepareRepositoryUninstall(ctx, target, { locations: selection.locations });
  const { location, entries } = uninstall;
  const fields = await recordOutputFields(selection, fs);
  const bundleIds = [...entries.keys()];

  if (opts.dryRun === true) {
    formatOutput({
      ctx,
      command: 'uninstall',
      output: fmt,
      status: 'ok',
      data: { dryRun: true, ...fields, lockfile: location.path, target: target.name, bundles: bundleIds, files: [...entries.values()].flat() },
      textRenderer: (d) => `[dry-run] Would uninstall ${d.bundles.length} bundle${d.bundles.length === 1 ? '' : 's'} from target "${d.target}" (from ${d.lockfile}):\n`
        + `  Bundles: ${d.bundles.join(', ')}\n`
        + `  Files: ${d.files.length} total\n`
        + 'Run without --dry-run to apply.\n'
        + renderRecordLine({ level: d.level, records: d.records })
    });
    return 0;
  }

  const results: { id: string; removed: number }[] = [];
  const warnings: string[] = [];
  for (const bundleId of bundleIds) {
    const recorded = await recordRepositoryUninstall(uninstall, bundleId);
    results.push({ id: bundleId, removed: recorded.removed.length });
    warnings.push(...recorded.warnings);
    await updateTargetState(ctx, target.name, bundleId);
  }

  formatOutput({
    ctx,
    command: 'uninstall',
    output: fmt,
    status: 'ok',
    data: { ...fields, lockfile: location.path, target: target.name, uninstalled: results.length, bundles: results },
    warnings: warnings.length > 0 ? warnings : undefined,
    textRenderer: (d) => (d.uninstalled === 0
      ? `No bundles found to uninstall from target "${d.target}".\n`
      : `Uninstalled ${d.uninstalled} bundle${d.uninstalled === 1 ? '' : 's'} from target "${d.target}" (from ${d.lockfile}).\n`)
    + renderRecordLine({ level: d.level, records: d.records })
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
  // A record file is loaded and checked first; any other file keeps the old path.
  const selected = await prepareRecordSelection(ctx, { command: 'uninstall', lockfile }, target);
  if (selected.selection.locations.length > 0) {
    return performRecordLockfileUninstall({ opts, target, ctx, fmt }, selected);
  }
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
  if (target.scope === 'repository') {
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
  // A RECORD.* error stops here with nothing removed; the old store is handled afterwards.
  let prepared: PreparedRepositoryUninstall | undefined;
  if (target.scope === 'repository') {
    prepared = await prepareRepositoryUninstall(ctx, target);
  } else if (target.scope === 'user') {
    prepared = await prepareUserUninstall(ctx, target);
  }
  const recordedIds = prepared === undefined ? [] : [...prepared.entries.keys()];
  // Each id is handled and reported once, even when both stores list it.
  const recordedSet = new Set(recordedIds);
  const entries = Object.fromEntries(
    Object.entries(await findAllBundleEntries(target, opts, ctx)).filter(([id]) => !recordedSet.has(id))
  );
  const bundleIds = [...recordedIds, ...Object.keys(entries)];

  // Dry-run: show what would be removed without deleting
  if (opts.dryRun === true) {
    const allFiles = [
      ...recordedIds.flatMap((id) => prepared?.entries.get(id) ?? []),
      ...Object.values(entries).flatMap((entry) => entry.files.map((f) => f.path))
    ];
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
  const results: UninstallResult[] = [];
  const warnings: string[] = [];
  for (const bundleId of recordedIds) {
    const recorded = await recordRepositoryUninstall(prepared as PreparedRepositoryUninstall, bundleId);
    results.push({ bundleId, removed: recorded.removed, skipped: [] });
    warnings.push(...recorded.warnings);
  }
  if (target.scope === 'repository') {
    const pipeline = new UninstallPipeline({
      fs: ctx.fs,
      target,
      repositoryPath: target.rootPath ?? ctx.cwd(),
      writerFactory
    });
    results.push(...await pipeline.runAll({ exclude: recordedSet }));
  } else {
    // Old user lockfile: bundles not uninstalled from the user record above.
    const lockPath = lockfilePathForTarget(ctx, target);
    results.push(...await runAllUserScopeUninstall(lockPath, target, ctx, writerFactory(target), recordedSet));
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
    warnings: warnings.length > 0 ? warnings : undefined,
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
        const targetName = await resolveTargetName(opts.target, 'uninstall', ctx, () => loadTargets(ctx));
        const configuredTarget = await resolveTarget(targetName, 'uninstall', ctx, () => loadTargets(ctx));
        const target = resolveEffectiveTarget(ctx, configuredTarget, opts);

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
