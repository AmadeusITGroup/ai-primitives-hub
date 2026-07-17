/**
 * `index harvest` — fetch hub-config + walk every source + write a
 * primitive index.
 *
 * Heavy lifting lives in `harvestHub` (`@ai-primitives-hub/infra`'s
 * `harvest/hub-harvester.ts`); this command only adapts options + emits
 * the canonical envelope.
 * @module commands/index-harvest
 */
import * as path from 'node:path';
import {
  resolveUserConfigPaths,
} from '@ai-primitives-hub/app';
import {
  ActiveHubStore,
  harvestHub as defaultHarvestHub,
  type HubHarvestPipelineOptions,
  type HubHarvestPipelineResult,
  HubStore,
} from '@ai-primitives-hub/infra';
import {
  Command,
  type Context,
  failWith,
  formatOutput,
  Option,
  type OutputFormat,
  RegistryError,
} from '../framework';

/**
 * Populate hub source fields on `cmd` from the currently active hub
 * when the user hasn't provided them explicitly.
 *
 * Falls back to the legacy `prompt-registry` config directory so the
 * `ai-primitives-hub` CLI can reuse an active hub configured by the
 * `gh prompt-registry` extension.
 * @param cmd IndexHarvestCommand instance (mutated).
 * @param cmd.hubRepo
 * @param cmd.hubBranch
 * @param cmd.hubConfigFile
 * @param ctx CLI context.
 */
async function autoDetectHubFromActive(
  cmd: { hubRepo?: string; hubBranch?: string; hubConfigFile?: string },
  ctx: Context
): Promise<void> {
  try {
    const userPaths = resolveUserConfigPaths(ctx.env);

    // Legacy fallback: `gh prompt-registry` stores active hubs under
    // `~/.config/prompt-registry`; reuse them when the new CLI has no active hub.
    const legacyRoot = path.join(path.dirname(userPaths.root), 'prompt-registry');
    const candidates = [
      { activeHub: userPaths.activeHub, hubs: userPaths.hubs },
      { activeHub: path.join(legacyRoot, 'active-hub.json'), hubs: path.join(legacyRoot, 'hubs') }
    ];

    for (const candidate of candidates) {
      const activeId = await new ActiveHubStore(candidate.activeHub, ctx.fs).get();
      if (activeId === null) {
        continue;
      }
      const saved = await new HubStore(candidate.hubs, ctx.fs).load(activeId);
      const hubConfigFile = path.join(candidate.hubs, `${activeId}.yml`);
      applyHubRef(cmd, saved.reference, hubConfigFile);
      return;
    }
  } catch {
    // If detection fails for any reason, fall through to the explicit error below.
  }
}

/**
 * Apply a loaded hub reference to the command's hub source fields.
 * @param cmd Command instance (mutated).
 * @param cmd.hubRepo Output GitHub owner/repo.
 * @param cmd.hubBranch Output Git ref.
 * @param cmd.hubConfigFile Output local/URL config file path.
 * @param hubRef Loaded hub reference.
 * @param hubRef.type Hub source type.
 * @param hubRef.location Hub location or owner/repo.
 * @param hubRef.ref Optional Git ref.
 * @param hubConfigFile Absolute path to the locally cached hub config YAML.
 */
function applyHubRef(
  cmd: { hubRepo?: string; hubBranch?: string; hubConfigFile?: string },
  hubRef: { type: 'github' | 'local' | 'url'; location: string; ref?: string },
  hubConfigFile: string
): void {
  if (hubRef.type === 'github') {
    cmd.hubRepo = hubRef.location;
    if (hubRef.ref) {
      cmd.hubBranch = hubRef.ref;
    }
  }
  cmd.hubConfigFile = hubConfigFile;
}

const buildHarvestError = (cause: unknown): RegistryError => new RegistryError({
  code: 'INDEX.HARVEST_FAILED',
  message: `index harvest failed: ${cause instanceof Error ? cause.message : String(cause)}`,
  cause: cause instanceof Error ? cause : undefined
});

const isHubRefMissing = (noHubConfig: boolean, hubConfigFile: string | undefined, hubRepo: string | undefined): boolean =>
  !noHubConfig && !hubConfigFile && (!hubRepo || hubRepo.length === 0);

/**
 * Index harvest command class.
 * Fetches hub-config, walks every source, and writes a primitive index.
 */
export class IndexHarvestCommand extends Command {
  public static readonly paths = [['index', 'harvest']];

  public static readonly usage = Command.Usage({
    description: 'Fetch hub-config, walk every source, and write a primitive index.',
    category: 'Index & Search',
    details: `
      Usage: ai-primitives-hub index harvest [options]

      Examples:
        ai-primitives-hub index harvest --hub-repo OWNER/REPO
        ai-primitives-hub index harvest --hub-config-file hub-config.yml
        ai-primitives-hub index harvest --no-hub-config --extra-source 'local:/path/to/bundles'
    `
  });

  public hubRepo = Option.String('--hub-repo');
  public hubBranch = Option.String('--hub-branch');
  public hubConfigFile = Option.String('--hub-config-file');
  public noHubConfig = Option.Boolean('--no-hub-config');
  public cacheDir = Option.String('--cache-dir');
  public progressFile = Option.String('--progress-file');
  public outFile = Option.String('--out-file');
  public concurrency = Option.String('--concurrency');
  public tokenEnv = Option.String('--token-env');
  public sourcesInclude = Option.Array('--sources-include');
  public sourcesExclude = Option.Array('--sources-exclude');
  public extraSources = Option.Array('--extra-source');
  public force = Option.Boolean('--force');
  public dryRun = Option.Boolean('--dry-run');
  public verbose = Option.Boolean('--verbose');
  public output = Option.String('-o,--output');
  public commandContext!: { ctx: Context };

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;

    const fmt = (this.output ?? 'text') as OutputFormat;
    const noHubConfig = this.noHubConfig === true;

    if (isHubRefMissing(noHubConfig, this.hubConfigFile, this.hubRepo)) {
      await autoDetectHubFromActive(this, ctx);
    }

    const hubConfigFile = this.hubConfigFile;

    if (isHubRefMissing(noHubConfig, hubConfigFile, this.hubRepo)) {
      return failWith(ctx, fmt, 'index.harvest', new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'index harvest: --hub-repo <OWNER/REPO> is required (or use --no-hub-config / --hub-config-file)',
        hint: 'Run `ai-primitives-hub hub add <ref>` and `hub use <id>` to configure an active hub, or pass --hub-repo directly.'
      }));
    }

    const explicitToken = this.tokenEnv === undefined
      ? undefined
      : ctx.env[this.tokenEnv];

    const pipelineOpts: HubHarvestPipelineOptions = {
      hubRepo: this.hubRepo,
      hubBranch: this.hubBranch,
      hubConfigFile: this.hubConfigFile,
      noHubConfig: this.noHubConfig,
      cacheDir: this.cacheDir,
      progressFile: this.progressFile,
      outFile: this.outFile,
      concurrency: this.concurrency ? Number.parseInt(this.concurrency, 10) : undefined,
      explicitToken,
      sourcesInclude: this.sourcesInclude,
      sourcesExclude: this.sourcesExclude,
      extraSources: this.extraSources,
      force: this.force,
      dryRun: this.dryRun,
      onEvent: this.verbose === true
        ? (ev): void => {
          ctx.stderr.write(`[${ev.kind}] ${JSON.stringify(ev)}\n`);
        }
        : undefined,
      onLog: (msg): void => {
        ctx.stderr.write(`[index harvest] ${msg}\n`);
      }
    };

    const runner = defaultHarvestHub;
    let result: HubHarvestPipelineResult;

    try {
      result = await runner(pipelineOpts, ctx.env);
    } catch (cause) {
      return failWith(ctx, fmt, 'index.harvest', buildHarvestError(cause));
    }

    formatOutput({
      ctx, command: 'index.harvest', output: fmt, status: 'ok',
      data: result,
      textRenderer: (r) =>
        `done=${String(r.totals.done)} `
        + `error=${String(r.totals.error)} `
        + `skip=${String(r.totals.skip)} `
        + `primitives=${String(r.totals.primitives)} `
        + `wallMs=${String(r.totals.wallMs)} `
        + `totalMs=${String(r.totals.totalMs)}\n`
    });

    return result.totals.error > 0 ? 1 : 0;
  }
}
