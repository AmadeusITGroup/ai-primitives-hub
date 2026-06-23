/**
 * `update` command — checks installed bundles for newer versions and upgrades them.
 */
import * as path from 'node:path';
import {
  FileTreeTargetWriter,
  resolveUserConfigPaths,
} from '@prompt-registry/app';
import {
  validateManifest,
} from '@prompt-registry/core';
import type {
  HttpClient,
  Installable,
  RegistrySource,
  Target,
  TokenProvider,
} from '@prompt-registry/core';
import {
  ActiveHubStore,
  checksumFiles,
  defaultTokenProvider,
  HttpsBundleDownloader,
  NodeHttpClient,
  SourceDispatcher,
  TargetStateStore,
  YauzlBundleExtractor,
} from '@prompt-registry/infra';
import {
  type LockfileEntry,
  type LockfileSource,
  readLockfile,
  upsertEntry,
  upsertSource,
  writeLockfile,
} from '@prompt-registry/infra';
import inquirer from 'inquirer';
import {
  Command,
  type Context,
  createHubManager,
  findProjectLockfile,
  formatOutput,
  loadTargets,
  Option,
  type OutputFormat,
  RegistryError,
  renderError,
  throwTargetNotFoundError,
} from '../framework';

/**
 * Return true when `candidate` is a strictly higher semver than `installed`.
 * Strips leading `v` from either value before comparing.
 * @param candidate Resolved latest version.
 * @param installed Currently installed version.
 */
export const isNewerVersion = (candidate: string, installed: string): boolean => {
  const parse = (v: string): number[] =>
    v.replace(/^v/, '').split('.').map((p) => Number.parseInt(p.split('-')[0], 10) || 0);
  const c = parse(candidate);
  const i = parse(installed);
  for (let idx = 0; idx < Math.max(c.length, i.length); idx++) {
    const cv = c[idx] ?? 0;
    const iv = i[idx] ?? 0;
    if (cv > iv) {
      return true;
    }
    if (cv < iv) {
      return false;
    }
  }
  return false;
};

interface UpdateCandidate {
  entry: LockfileEntry;
  source: LockfileSource;
  from: string;
  to: string;
  installable: Installable;
}

interface UpdateContext {
  ctx: Context;
  http?: HttpClient;
  tokens?: TokenProvider;
}

abstract class BaseUpdateCommand extends Command {
  public commandContext: UpdateContext = { ctx: null as unknown as Context };
}

type UpdateEntry = { bundleId: string; target: string; from: string; to: string };

function renderDryRunOutput(d: { checked: number; updates: UpdateEntry[] }): string {
  if (d.updates.length === 0) {
    return `All bundles are up to date. (checked ${String(d.checked)})
`;
  }
  const lines = [`Available updates (${String(d.updates.length)}):`];
  for (const u of d.updates) {
    lines.push(`  ${u.bundleId} [${u.target}]: ${u.from} → ${u.to}`);
  }
  lines.push('\nRe-run without --dry-run to apply.');
  return lines.join('\n') + '\n';
}

function renderUpdateOutput(d: { updated: number; checked: number; updates: UpdateEntry[] }): string {
  if (d.updated === 0) {
    return `All bundles are up to date. (checked ${String(d.checked)})
`;
  }
  const lines = [`Updated ${String(d.updated)} bundle${d.updated === 1 ? '' : 's'}:`];
  for (const u of d.updates) {
    lines.push(`  ${u.bundleId} [${u.target}]: ${u.from} → ${u.to}`);
  }
  return lines.join('\n') + '\n';
}

export class UpdateCommand extends BaseUpdateCommand {
  public static readonly paths = [['update']];

  public static readonly usage = Command.Usage({
    description: 'Check for newer versions of installed bundles and upgrade them.',
    category: 'Install & Manage',
    details: `
      Usage: prompt-registry update [options]

      Reads the lockfile, checks each remote bundle against its upstream source,
      and installs available upgrades.

      Options:
        --lockfile <path>       Path to a lockfile
        --target <name>         Target name to update
        --dry-run               Check for updates without applying
        --interactive           Interactive mode: select which updates to apply
        --no-hub-sync           Skip syncing hub before checking updates
        -o, --output <format>  Output format (text, json, yaml, ndjson)

      Examples:
        prompt-registry update
        prompt-registry update --target my-vscode
        prompt-registry update --dry-run
        prompt-registry update --interactive
    `
  });

  public output = Option.String('-o', '--output') as OutputFormat | undefined;
  public lockfile = Option.String('--lockfile');
  public target = Option.String('--target');
  public dryRun = Option.Boolean('--dry-run', false);
  public interactive = Option.Boolean('--interactive', false);
  public noHubSync = Option.Boolean('--no-hub-sync', false);

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const http = this.commandContext.http ?? new NodeHttpClient();
    const tokens = this.commandContext.tokens ?? defaultTokenProvider(ctx.env);
    const fmt = this.output ?? 'text';

    const lockPath = await resolveLockfilePath(ctx, this.lockfile);
    if (lockPath === null) {
      return failWith(ctx, fmt, new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'update: no lockfile found',
        hint: 'Run `prompt-registry install` first, or pass --lockfile <path>.'
      }));
    }

    const lock = await readLockfile(lockPath, ctx.fs);

    if (!this.noHubSync) {
      await syncActiveHub(ctx, http, tokens);
    }

    const { scopedEntries, entries } = filterUpdateEntries(lock.entries, lock.sources ?? {}, this.target);
    const { candidates, skipped } = await findUpdateCandidates(entries, lock.sources ?? {}, ctx, http, tokens);

    if (this.dryRun) {
      return renderDryRun(ctx, fmt, lockPath, scopedEntries.length, skipped.length, candidates);
    }

    const toInstall = await selectUpdatesInteractively(this.interactive, candidates);
    if (toInstall.length === 0) {
      return renderNoUpdates(ctx, fmt, scopedEntries.length, skipped.length);
    }

    const { updatedCount, updateResults } = await applyUpdates(toInstall, lockPath, ctx, http, tokens);

    formatOutput({
      ctx, command: 'update', output: fmt, status: 'ok',
      data: { lockfile: lockPath, checked: scopedEntries.length, updated: updatedCount, skipped: skipped.length, updates: updateResults },
      textRenderer: renderUpdateOutput
    });
    return 0;
  }
}

async function resolveLockfilePath(ctx: Context, lockfileFlag: string | undefined): Promise<string | null> {
  if (lockfileFlag !== undefined && lockfileFlag.length > 0) {
    return path.isAbsolute(lockfileFlag) ? lockfileFlag : path.join(ctx.cwd(), lockfileFlag);
  }
  return await findProjectLockfile(ctx);
}

function filterUpdateEntries(entries: LockfileEntry[], sources: Record<string, LockfileSource>, targetFlag: string | undefined): { scopedEntries: LockfileEntry[]; entries: LockfileEntry[] } {
  const scopedEntries = entries.filter((e) => {
    if (targetFlag !== undefined && targetFlag.length > 0 && e.target !== targetFlag) {
      return false;
    }
    return true;
  });
  const filteredEntries = scopedEntries.filter((e) => {
    const src = sources?.[e.sourceId];
    return src !== undefined && isRemoteSource(src.type);
  });
  return { scopedEntries, entries: filteredEntries };
}

async function findUpdateCandidates(
  entries: LockfileEntry[],
  sources: Record<string, LockfileSource>,
  ctx: Context,
  http: HttpClient,
  tokens: TokenProvider
): Promise<{ candidates: UpdateCandidate[]; skipped: string[] }> {
  const candidates: UpdateCandidate[] = [];
  const skipped: string[] = [];
  const dispatcher = new SourceDispatcher({ http, tokens, fs: ctx.fs });

  for (const entry of entries) {
    const src = sources[entry.sourceId];
    try {
      const sourceAsRegistrySource = { ...src, id: entry.sourceId } as unknown as RegistrySource;
      const resolver = dispatcher.resolverFor(sourceAsRegistrySource);
      if (resolver === null) {
        skipped.push(entry.bundleId);
        continue;
      }
      const installable = await resolver.resolve({ bundleId: entry.bundleId, bundleVersion: 'latest' });
      if (installable === null) {
        skipped.push(entry.bundleId);
        continue;
      }
      const latestVersion = installable.ref.bundleVersion;
      if (isNewerVersion(latestVersion, entry.bundleVersion)) {
        candidates.push({ entry, source: src, from: entry.bundleVersion, to: latestVersion, installable });
      }
    } catch {
      skipped.push(entry.bundleId);
    }
  }

  return { candidates, skipped };
}

function renderDryRun(
  ctx: Context,
  fmt: string,
  lockPath: string,
  checked: number,
  skippedCount: number,
  candidates: UpdateCandidate[]
): number {
  formatOutput({
    ctx, command: 'update', output: fmt as OutputFormat, status: 'ok',
    data: {
      dryRun: true, lockfile: lockPath,
      checked, updated: 0, skipped: skippedCount,
      updates: candidates.map((c) => ({ bundleId: c.entry.bundleId, target: c.entry.target, from: c.from, to: c.to }))
    },
    textRenderer: renderDryRunOutput
  });
  return 0;
}

async function selectUpdatesInteractively(interactive: boolean, candidates: UpdateCandidate[]): Promise<UpdateCandidate[]> {
  if (!interactive || candidates.length === 0) {
    return candidates;
  }
  const answers = await (inquirer.prompt as (q: unknown) => Promise<{ selected: UpdateCandidate[] }>)([{
    type: 'checkbox',
    name: 'selected',
    message: 'Select bundles to update:',
    choices: candidates.map((c) => ({
      name: `${c.entry.bundleId} [${c.entry.target}]: ${c.from} → ${c.to}`,
      value: c,
      checked: true
    }))
  }]);
  return answers.selected;
}

function renderNoUpdates(ctx: Context, fmt: string, checked: number, skippedCount: number): number {
  formatOutput({
    ctx, command: 'update', output: fmt as OutputFormat, status: 'ok',
    data: { checked, updated: 0, skipped: skippedCount, updates: [] },
    textRenderer: () => `All bundles are up to date. (checked ${String(checked)})\n`
  });
  return 0;
}

async function applyUpdates(
  toInstall: UpdateCandidate[],
  lockPath: string,
  ctx: Context,
  http: HttpClient,
  tokens: TokenProvider
): Promise<{ updatedCount: number; updateResults: { bundleId: string; target: string; from: string; to: string }[] }> {
  let updatedCount = 0;
  const updateResults: { bundleId: string; target: string; from: string; to: string }[] = [];

  for (const candidate of toInstall) {
    try {
      const target = await resolveTarget(candidate.entry.target, ctx);
      await applyUpdate(candidate, target, lockPath, ctx, http, tokens);
      updateResults.push({ bundleId: candidate.entry.bundleId, target: candidate.entry.target, from: candidate.from, to: candidate.to });
      updatedCount++;
    } catch (err) {
      ctx.stderr.write(`Failed to update ${candidate.entry.bundleId}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  return { updatedCount, updateResults };
}

function isRemoteSource(type: string): boolean {
  return type === 'github' || type === 'awesome-copilot' || type === 'skills';
}

async function syncActiveHub(ctx: Context, http: HttpClient, tokens: TokenProvider): Promise<void> {
  try {
    const userPaths = resolveUserConfigPaths(ctx.env);
    if (!(await ctx.fs.exists(userPaths.root))) {
      return;
    }
    const activeStore = new ActiveHubStore(userPaths.activeHub, ctx.fs);
    const hubId = await activeStore.get();
    if (hubId === null) {
      return;
    }
    const mgr = createHubManager({ ctx, http, tokens });
    await mgr.syncHub(hubId);
  } catch {
    // Hub sync failure is non-fatal.
  }
}

async function resolveTarget(targetName: string, ctx: Context): Promise<Target> {
  const targets = await loadTargets(ctx);
  const target = targets.find((t) => t.name === targetName);
  if (target === undefined) {
    throwTargetNotFoundError('update', targetName, targets, (ts) =>
      `Configured targets: ${ts.map((t) => t.name).join(', ') || '(none)'}`
    );
  }
  return target!;
}

async function applyUpdate(
  candidate: UpdateCandidate,
  target: Target,
  lockPath: string,
  ctx: Context,
  http: HttpClient,
  tokens: TokenProvider
): Promise<void> {
  const downloader = new HttpsBundleDownloader(http, tokens);
  const extractor = new YauzlBundleExtractor();

  const dl = await downloader.download(candidate.installable);
  const files = await extractor.extract(dl.bytes);
  const manifest = validateManifest(files, { expectedId: undefined, expectedVersion: undefined });

  const writer = new FileTreeTargetWriter({ fs: ctx.fs, env: ctx.env });
  await writer.write(target, files);

  const checksums = checksumFiles(files);
  const entry: LockfileEntry = {
    target: target.name,
    sourceId: candidate.entry.sourceId,
    bundleId: manifest.id,
    bundleVersion: manifest.version,
    sha256: dl.sha256,
    installedAt: new Date().toISOString(),
    files: [...files.keys()].filter((f) => f !== 'deployment-manifest.yml'),
    fileChecksums: checksums
  };

  const lock = await readLockfile(lockPath, ctx.fs);
  let nextLock = upsertEntry(lock, entry);
  nextLock = upsertSource(nextLock, candidate.entry.sourceId, candidate.source);
  await writeLockfile(lockPath, nextLock, ctx.fs);

  const stateStore = new TargetStateStore({ fs: ctx.fs, statePath: path.join(ctx.cwd(), '.prompt-registry', 'target-state.json') });
  const existingState = await stateStore.load(target.name);
  const bundles = existingState?.lastInstalledBundles ?? [];
  const idx = bundles.findIndex((b) => b.bundleId === manifest.id);
  const bundleState = { bundleId: manifest.id, version: manifest.version, installedAt: new Date().toISOString() };
  if (idx === -1) {
    bundles.push(bundleState);
  } else {
    bundles[idx] = bundleState;
  }
  await stateStore.save({ targetName: target.name, lastInstalledBundles: bundles, lastUsedAt: new Date().toISOString() });
}

function failWith(ctx: Context, output: OutputFormat, err: RegistryError): number {
  if (output === 'json' || output === 'yaml' || output === 'ndjson') {
    formatOutput({ ctx, command: 'update', output, status: 'error', data: null, errors: [err.toJSON()] });
  } else {
    renderError(err, ctx);
  }
  return 1;
}
