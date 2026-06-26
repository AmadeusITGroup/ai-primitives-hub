/**
 * `prompt-registry index harvest` — fetch hub-config + walk every
 * source + write a primitive index.
 *
 * Replaces the legacy `primitive-index hub-harvest` verb. Heavy
 * lifting lives in `harvestHub` (`lib/src/primitive-index/hub-harvest-pipeline.ts`);
 * this command only adapts options + emits the canonical envelope.
 * @module cli/commands/index-harvest
 */
import {
  resolveUserConfigPaths,
} from '@prompt-registry/app';
import {
  harvestHub as defaultHarvestHub,
  type HubHarvestPipelineOptions,
  type HubHarvestPipelineResult,
} from '@prompt-registry/infra';
import {
  ActiveHubStore,
  HubStore,
} from '@prompt-registry/infra';
import {
  Command,
  type CommandDefinition,
  type Context,
  defineCommand,
  failWith,
  formatOutput,
  getCommandContext,
  Option,
  type OutputFormat,
  RegistryError,
} from '../framework';

/** Pipeline runner type — matches `harvestHub` from the pipeline module. */
export type HarvestRunner = (
  opts: HubHarvestPipelineOptions,
  env: NodeJS.ProcessEnv
) => Promise<HubHarvestPipelineResult>;

export interface IndexHarvestOptions {
  output?: OutputFormat;
  hubRepo?: string;
  hubBranch?: string;
  hubConfigFile?: string;
  noHubConfig?: boolean;
  cacheDir?: string;
  progressFile?: string;
  outFile?: string;
  concurrency?: number;
  /** Env-var name to read the GitHub token from (e.g. `GH_TOKEN`). */
  tokenEnv?: string;
  sourcesInclude?: string[];
  sourcesExclude?: string[];
  extraSources?: string[];
  force?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  /** Test seam: override the pipeline runner. */
  runPipeline?: HarvestRunner;
}

/**
 * Build the `index harvest` command.
 * @param opts CLI options.
 * @returns CommandDefinition.
 */
export const createIndexHarvestCommand = (
  opts: IndexHarvestOptions = {}
): CommandDefinition =>
  defineCommand({
    path: ['index', 'harvest'],
    description: 'Fetch hub-config, walk every source, and write a primitive index.',
    category: 'Index & Search',
    run: async ({ ctx }: { ctx: Context }): Promise<number> => {
      const fmt = opts.output ?? 'text';
      const noHubConfig = opts.noHubConfig === true;
      const hubConfigFile = opts.hubConfigFile;
      if (!noHubConfig && hubConfigFile === undefined
        && (opts.hubRepo === undefined || opts.hubRepo.length === 0)) {
        return failWith(ctx, fmt, 'index.harvest', new RegistryError({
          code: 'USAGE.MISSING_FLAG',
          message: 'index harvest: --hub-repo <OWNER/REPO> is required (or use --no-hub-config / --hub-config-file)'
        }));
      }
      const explicitToken = opts.tokenEnv === undefined
        ? undefined
        : ctx.env[opts.tokenEnv];
      const pipelineOpts: HubHarvestPipelineOptions = {
        hubRepo: opts.hubRepo,
        hubBranch: opts.hubBranch,
        hubConfigFile: opts.hubConfigFile,
        noHubConfig: opts.noHubConfig,
        cacheDir: opts.cacheDir,
        progressFile: opts.progressFile,
        outFile: opts.outFile,
        concurrency: opts.concurrency,
        explicitToken,
        sourcesInclude: opts.sourcesInclude,
        sourcesExclude: opts.sourcesExclude,
        extraSources: opts.extraSources,
        force: opts.force,
        dryRun: opts.dryRun,
        onEvent: opts.verbose === true
          ? (ev): void => {
            ctx.stderr.write(`[${ev.kind}] ${JSON.stringify(ev)}\n`);
          }
          : undefined,
        onLog: (msg): void => {
          ctx.stderr.write(`[index harvest] ${msg}\n`);
        }
      };
      const runner = opts.runPipeline ?? defaultHarvestHub;
      let result: HubHarvestPipelineResult;
      try {
        result = await runner(pipelineOpts, ctx.env);
      } catch (cause) {
        return failWith(ctx, fmt, 'index.harvest', new RegistryError({
          code: 'INDEX.HARVEST_FAILED',
          message: `index harvest failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause: cause instanceof Error ? cause : undefined
        }));
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
  });

/**
 * Populate hub source fields on `cmd` from the currently active hub
 * when the user hasn't provided them explicitly.
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
    const activeStore = new ActiveHubStore(userPaths.activeHub, ctx.fs);
    const activeId = await activeStore.get();
    if (activeId === null) {
      return;
    }
    const hubStore = new HubStore(userPaths.hubs, ctx.fs);
    const saved = await hubStore.load(activeId);
    const ref = saved.reference;
    if (ref.type === 'github') {
      cmd.hubRepo = ref.location;
      if (ref.ref) {
        cmd.hubBranch = ref.ref;
      }
    } else if (ref.type === 'local' || ref.type === 'url') {
      cmd.hubConfigFile = ref.location;
    }
  } catch {
    // If detection fails for any reason, fall through to the explicit error below.
  }
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
      Usage: prompt-registry index harvest [options]

      Examples:
        prompt-registry index harvest --hub-repo OWNER/REPO
        prompt-registry index harvest --hub-config-file hub-config.yml
        prompt-registry index harvest --no-hub-config --extra-source 'local:/path/to/bundles'
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

  public async execute(): Promise<number> {
    const ctx = getCommandContext(this);

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
        hint: 'Run `prompt-registry hub add <ref>` and `hub use <id>` to configure an active hub, or pass --hub-repo directly.'
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
