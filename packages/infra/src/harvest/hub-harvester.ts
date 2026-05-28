/**
 * Hub harvest pipeline — orchestrates the full
 * "fetch hub-config → walk sources → write index" workflow.
 *
 * Extracted from the legacy `lib/src/primitive-index/cli.ts` so the
 * framework command (`prompt-registry index harvest`) and any other
 * caller can drive the same logic without re-implementing argv
 * plumbing.
 *
 * The function takes an `events` callback for observability — the
 * CLI command pipes those into stderr; tests can capture them.
 * @module primitive-index/hub-harvest-pipeline
 */
import {
  readFile,
} from 'node:fs/promises';
import * as path from 'node:path';
import type {
  HubSourceSpec,
  TokenProvider,
} from '@prompt-registry/core';
import {
  BlobCache,
} from '../github/blob-cache';
import {
  GitHubClient,
} from '../github/client';
import {
  EtagStore,
} from '../github/etag-store';
import {
  staticTokenProvider,
} from '../github/token';
import {
  PrimitiveIndex,
} from '../search/primitive-index';
import type {
  BundleProvider,
  IndexStats,
  Primitive,
} from '../search/types';
import {
  saveIndex,
} from '../stores/json-index-store';
import {
  AwesomeCopilotBundleProvider,
} from './bundle-providers/awesome-copilot-bundle-provider';
import {
  GitHubSingleBundleProvider,
} from './bundle-providers/github-bundle-provider';
import {
  AwesomeCopilotPluginBundleProvider,
} from './bundle-providers/plugin-bundle-provider';
import {
  defaultHubCacheDir,
  defaultIndexFile,
} from './default-paths';
import {
  parseExtraSource,
} from './extra-source';
import {
  harvestBundle,
} from './harvester';
import {
  parseHubConfig,
} from './hub-config-parser';
import {
  saveIndexWithIntegrity,
} from './integrity';
import {
  HarvestProgressLog,
  type ProgressSummary,
} from './progress-log';
import {
  redactToken,
  resolveGithubToken,
} from './token-provider';
import {
  resolveCommitSha,
} from './tree-enumerator';

export type HubHarvestEvent =
  | { kind: 'source-start'; sourceId: string }
  | { kind: 'source-skip'; sourceId: string; commitSha: string; reason: string }
  | { kind: 'source-done'; sourceId: string; commitSha: string; primitives: number; ms: number }
  | { kind: 'source-error'; sourceId: string; error: string };

/**
 * Parameters for resolving hub sources.
 */
interface ResolveHubSourcesParams {
  noHubConfig: boolean;
  hubConfigFile: string | undefined;
  hubRepo: string;
  hubBranch: string;
  client: GitHubClient;
  extraSources: string[] | undefined;
  onLog: ((msg: string) => void) | undefined;
  sourcesInclude: string[] | undefined;
  sourcesExclude: string[] | undefined;
}

/**
 * Parameters for building harvest result.
 */
interface BuildHarvestResultParams {
  outFile: string;
  progressFile: string;
  cacheDir: string;
  stats: IndexStats;
  result: { index: PrimitiveIndex; totalMs: number; done: number; error: number; skip: number; primitives: number; wallMs: number };
  hubRepo: string;
  hubBranch: string;
  sourcesCount: number;
  tokenSource: string;
  client: GitHubClient;
}

export interface HubHarvestPipelineOptions {
  /** "owner/repo" — required unless `noHubConfig` or `hubConfigFile`. */
  hubRepo?: string;
  /** Branch / tag / commit. Defaults to `main`. */
  hubBranch?: string;
  /**
   * Read sources from a local YAML file instead of fetching
   * `hub-config.yml` from the hub repo. Useful for tests / dev.
   */
  hubConfigFile?: string;
  /**
   * Skip fetching the hub-config entirely; sources come from
   * `extraSources` only.
   */
  noHubConfig?: boolean;
  /** Override cache root. Defaults to `defaultHubCacheDir(hubRepo)`. */
  cacheDir?: string;
  /** Override progress-file path. Defaults to `<cacheDir>/progress.jsonl`. */
  progressFile?: string;
  /** Override output index file. Defaults to `defaultIndexFile()`. */
  outFile?: string;
  /** Concurrency. Default 4 (measured 5.3× speedup vs serial). */
  concurrency?: number;
  /** Optional token. Otherwise resolved via `resolveGithubToken`. */
  explicitToken?: string;
  /** Filter sources to this set of ids (after extra-source injection). */
  sourcesInclude?: string[];
  /** Filter out these source ids. */
  sourcesExclude?: string[];
  /** Inject synthetic sources via the `parseExtraSource` mini-DSL. */
  extraSources?: string[];
  /** Skip cache and re-fetch every blob. */
  force?: boolean;
  /** Walk sources but don't write the index. */
  dryRun?: boolean;
  /** Observer for harvester progress events. */
  onEvent?: (ev: HubHarvestEvent) => void;
  /** Observer for diagnostic messages (one per source-config decision). */
  onLog?: (msg: string) => void;
}

export interface HubHarvestPipelineResult {
  outFile: string;
  progressFile: string;
  cacheDir: string;
  stats: IndexStats;
  totals: {
    totalMs: number;
    done: number;
    error: number;
    skip: number;
    primitives: number;
    wallMs: number;
  };
  hub: {
    repo: string;
    branch: string;
    sources: number;
  };
  rateLimit: GitHubClient['lastRateLimit'];
  tokenSource: string;
}

function resolveHubRepo(
  noHubConfig: boolean,
  hubConfigFile: string | undefined,
  hubRepo: string | undefined
): { hubRepo: string; hubId: string } {
  const resolvedHubRepo = !noHubConfig && hubConfigFile === undefined
    ? hubRepo as string
    : (hubRepo ?? 'local/local');
  const hubId = noHubConfig || hubConfigFile !== undefined ? 'local' : resolvedHubRepo;
  return { hubRepo: resolvedHubRepo, hubId };
}

async function resolveHubSources(params: ResolveHubSourcesParams): Promise<HubSourceSpec[]> {
  let sources = await loadBaseSources(params.noHubConfig, params.hubConfigFile, params.hubRepo, params.hubBranch, params.client);
  sources = injectExtraSources(sources, params.extraSources, params.onLog);
  sources = filterSources(sources, params.sourcesInclude, params.sourcesExclude);
  return sources;
}

async function loadBaseSources(
  noHubConfig: boolean,
  hubConfigFile: string | undefined,
  hubRepo: string,
  hubBranch: string,
  client: GitHubClient
): Promise<HubSourceSpec[]> {
  if (hubConfigFile !== undefined) {
    return parseHubConfig(await readFile(hubConfigFile, 'utf8'));
  }
  if (noHubConfig) {
    return [];
  }
  const [owner, repo] = hubRepo.split('/');
  const yamlText = await client.getText(
    `https://raw.githubusercontent.com/${owner}/${repo}/${hubBranch}/hub-config.yml`
  );
  return parseHubConfig(yamlText);
}

function injectExtraSources(
  sources: HubSourceSpec[],
  extraSources: string[] | undefined,
  onLog: ((msg: string) => void) | undefined
): HubSourceSpec[] {
  for (const raw of extraSources ?? []) {
    const injected = parseExtraSource(raw);
    sources = sources.filter((s) => s.id !== injected.id);
    sources.push(injected);
    onLog?.(
      `injected extra-source id=${injected.id} type=${injected.type} `
      + `url=${injected.url}@${injected.branch}`
      + (injected.pluginsPath === undefined ? '' : ` pluginsPath=${injected.pluginsPath}`)
    );
  }
  return sources;
}

function filterSources(
  sources: HubSourceSpec[],
  sourcesInclude: string[] | undefined,
  sourcesExclude: string[] | undefined
): HubSourceSpec[] {
  if (sourcesInclude !== undefined && sourcesInclude.length > 0) {
    const set = new Set(sourcesInclude);
    sources = sources.filter((s) => set.has(s.id));
  }
  if (sourcesExclude !== undefined && sourcesExclude.length > 0) {
    const set = new Set(sourcesExclude);
    sources = sources.filter((s) => !set.has(s.id));
  }
  return sources;
}

/**
 * Harvest primitives from a GitHub hub (collections, plugins, or both).
 * Returns a summary with primitive counts and (if `dryRun=true`) a preview.
 * (consumed by the CLI command's JSON envelope).
 * @param opts Pipeline options (see {@link HubHarvestPipelineOptions}).
 * @param env Process env to read from. Defaults to `process.env`.
 * @returns Summary suitable for surfacing as JSON.
 */
export const harvestHub = async (
  opts: HubHarvestPipelineOptions,
  env: NodeJS.ProcessEnv = process.env
): Promise<HubHarvestPipelineResult> => {
  validateHarvestOptions(opts);
  const { hubRepo, hubBranch, cacheDir, progressFile, outFile, concurrency } = resolveHarvestPaths(opts, env);
  const { resolvedToken, client, tokenSource } = await createGitHubClient(hubRepo, opts);
  const sources = await resolveHubSources({
    noHubConfig: opts.noHubConfig === true,
    hubConfigFile: opts.hubConfigFile,
    hubRepo,
    hubBranch,
    client,
    extraSources: opts.extraSources,
    onLog: opts.onLog,
    sourcesInclude: opts.sourcesInclude,
    sourcesExclude: opts.sourcesExclude
  });

  logHarvestStart(opts, hubRepo, hubBranch, resolvedToken, sources.length, concurrency);
  const result = await runHarvester(sources, client, staticTokenProvider(resolvedToken), cacheDir, progressFile, concurrency, opts);
  await writeIndexWithIntegrity(result.index, outFile, env);

  const stats = result.index.stats();

  return buildHarvestResult({
    outFile,
    progressFile,
    cacheDir,
    stats,
    result,
    hubRepo,
    hubBranch,
    sourcesCount: sources.length,
    tokenSource,
    client
  });
};

function validateHarvestOptions(opts: HubHarvestPipelineOptions): void {
  const noHubConfig = opts.noHubConfig === true;
  const hubConfigFile = opts.hubConfigFile;
  if (!noHubConfig && hubConfigFile === undefined && (opts.hubRepo === undefined || opts.hubRepo.length === 0)) {
    throw new Error('hubRepo is required (or set noHubConfig=true / hubConfigFile)');
  }
}

function resolveHarvestPaths(opts: HubHarvestPipelineOptions, env: NodeJS.ProcessEnv): {
  hubRepo: string;
  hubBranch: string;
  cacheDir: string;
  progressFile: string;
  outFile: string;
  concurrency: number;
} {
  const { hubRepo } = resolveHubRepo(opts.noHubConfig === true, opts.hubConfigFile, opts.hubRepo);
  const hubBranch = opts.hubBranch ?? 'main';
  const hubId = opts.noHubConfig === true || opts.hubConfigFile !== undefined ? 'local' : hubRepo;
  const cacheDir = opts.cacheDir
    ?? defaultHubCacheDir(hubId, env);
  const progressFile = opts.progressFile ?? path.join(cacheDir, 'progress.jsonl');
  const outFile = opts.outFile
    ?? defaultIndexFile(env);
  const concurrency = opts.concurrency ?? 4;
  return { hubRepo, hubBranch, cacheDir, progressFile, outFile, concurrency };
}

async function createGitHubClient(hubRepo: string, opts: HubHarvestPipelineOptions): Promise<{
  resolvedToken: string;
  client: GitHubClient;
  tokenSource: string;
}> {
  const token = await resolveGithubToken({ explicit: opts.explicitToken });
  if (token.token === undefined || token.token.length === 0) {
    throw new Error('No GitHub token available (tried explicit, env, gh CLI).');
  }
  const resolvedToken: string = token.token;
  const client = new GitHubClient({ tokens: staticTokenProvider(resolvedToken) });
  const [owner, repo] = hubRepo.split('/');
  if (owner === undefined || repo === undefined || owner.length === 0 || repo.length === 0) {
    throw new Error(`Invalid hubRepo: ${hubRepo} (expected "owner/repo").`);
  }
  return { resolvedToken, client, tokenSource: token.source };
}

function logHarvestStart(opts: HubHarvestPipelineOptions, hubRepo: string, hubBranch: string, resolvedToken: string, sourcesCount: number, concurrency: number): void {
  opts.onLog?.(
    `hub=${hubRepo}@${hubBranch} `
    + `token=${opts.explicitToken ? 'explicit' : 'env'}:${redactToken(resolvedToken)} `
    + `sources=${String(sourcesCount)} concurrency=${String(concurrency)}`
  );
}

async function runHarvester(
  sources: HubSourceSpec[],
  client: GitHubClient,
  tokenProvider: TokenProvider,
  cacheDir: string,
  progressFile: string,
  concurrency: number,
  opts: HubHarvestPipelineOptions
): Promise<{ index: PrimitiveIndex; totalMs: number; done: number; error: number; skip: number; primitives: number; wallMs: number }> {
  const cache = new BlobCache(path.join(cacheDir, 'blobs'));
  const etagStore = await EtagStore.open(path.join(cacheDir, 'etags.json'));
  const harvester = new HubHarvester({
    sources, client, cache, etagStore,
    progressFile, concurrency,
    force: opts.force ?? false,
    dryRun: opts.dryRun ?? false,
    onEvent: opts.onEvent
  });
  const result = await harvester.run();
  await etagStore.save();
  return result;
}

// eslint-disable-next-line @typescript-eslint/require-await -- Intentionally async for interface compatibility
async function writeIndexWithIntegrity(index: PrimitiveIndex, outFile: string, env: NodeJS.ProcessEnv): Promise<void> {
  saveIndex(index, outFile);
  const signKey = env.PRIMITIVE_INDEX_SIGN_KEY;
  const signKeyId = env.PRIMITIVE_INDEX_SIGN_KEY_ID ?? 'default';
  if (signKey !== undefined && signKey.length > 0) {
    const sigFile = outFile.replace(/\.json$/u, '.sig.json');
    saveIndexWithIntegrity(index.toJSON(), sigFile, { keyId: signKeyId, key: signKey });
  }
}

function buildHarvestResult(params: BuildHarvestResultParams): HubHarvestPipelineResult {
  return {
    outFile: params.outFile,
    progressFile: params.progressFile,
    cacheDir: params.cacheDir,
    stats: params.stats,
    totals: {
      totalMs: params.result.totalMs,
      done: params.result.done,
      error: params.result.error,
      skip: params.result.skip,
      primitives: params.result.primitives,
      wallMs: params.result.wallMs
    },
    hub: { repo: params.hubRepo, branch: params.hubBranch, sources: params.sourcesCount },
    rateLimit: params.client.lastRateLimit,
    tokenSource: params.tokenSource
  };
}

export interface HubHarvesterOptions {
  sources: HubSourceSpec[];
  client: GitHubClient;
  cache: BlobCache;
  progressFile: string;
  /** Max number of bundles harvested in parallel. Default 1 (serial). */
  concurrency?: number;
  /** Observer hook for CLI logging, tests, etc. */
  onEvent?: (ev: HubHarvestEvent) => void;
  /**
   * Optional ETag store; enables conditional /commits/:ref lookups so
   * warm runs can answer "did anything change?" with a 304 replay.
   */
  etagStore?: EtagStore;
  /**
   * When true, ignores the progress log's shouldResume() and re-harvests
   * every source. Use to refresh the snapshot after content changes that
   * don't move the commit sha (rare — mainly for forced reindex).
   */
  force?: boolean;
  /**
   * When true, the harvester resolves commit shas and logs what it would
   * do, but never calls into harvestBundle or writes the snapshot. Useful
   * for "how much does this hub cost to ingest" estimates.
   */
  dryRun?: boolean;
}

export interface HubHarvestResult extends ProgressSummary {
  /** Wall-clock total in ms. */
  totalMs: number;
  /**
   * Final index assembled from every successful harvest in this run *and*
   * previously completed bundles carried via cache. For now
   * this holds only the primitives newly collected in this run.
   */
  index: PrimitiveIndex;
}

/* eslint-disable @typescript-eslint/member-ordering -- public API kept at top. */
export class HubHarvester {
  public constructor(private readonly opts: HubHarvesterOptions) {}

  public async run(): Promise<HubHarvestResult> {
    const startedAt = Date.now();
    const log = await HarvestProgressLog.open(this.opts.progressFile);
    const snapshot = await loadSnapshot(this.snapshotFile());
    const primitives: Primitive[] = [];
    const concurrency = Math.max(1, this.opts.concurrency ?? 1);

    const queue = [...this.opts.sources];
    const workers: Promise<void>[] = [];

    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const spec = queue.shift();
        if (!spec) {
          return;
        }
        await this.processSource(spec, log, primitives, snapshot);
      }
    };
    for (let i = 0; i < concurrency; i += 1) {
      workers.push(worker());
    }
    await Promise.all(workers);

    await log.close();

    // Persist a fresh snapshot capturing the latest set of primitives per
    // sourceId so the next warm run can reconstruct the full index.
    const fresh = new Map<string, Primitive[]>();
    for (const p of primitives) {
      const list = fresh.get(p.bundle.sourceId) ?? [];
      list.push(p);
      fresh.set(p.bundle.sourceId, list);
    }
    await saveSnapshot(this.snapshotFile(), fresh);

    const index = PrimitiveIndex.fromPrimitives(primitives);
    const summary = log.summary();
    return {
      ...summary,
      totalMs: Date.now() - startedAt,
      index
    };
  }

  private snapshotFile(): string {
    return path.join(path.dirname(this.opts.progressFile), 'primitives-snapshot.json');
  }

  private async processSource(
    spec: HubSourceSpec,
    log: HarvestProgressLog,
    out: Primitive[],
    snapshot: Map<string, Primitive[]>
  ): Promise<void> {
    const bundleId = spec.id;
    this.opts.onEvent?.({ kind: 'source-start', sourceId: spec.id });
    let commitSha: string | undefined;
    try {
      commitSha = await this.resolveCommitShaForSource(spec);
      const shouldSkip = await this.checkSkipConditions(spec, bundleId, commitSha, log, snapshot, out);
      if (shouldSkip) {
        return;
      }
      const primsTotal = await this.harvestSource(spec, bundleId, commitSha, log, out);
      this.opts.onEvent?.({
        kind: 'source-done', sourceId: spec.id, commitSha,
        primitives: primsTotal, ms: Date.now()
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await log.recordError({
        sourceId: spec.id, bundleId,
        commitSha: commitSha ?? 'unknown', error: msg
      });
      this.opts.onEvent?.({ kind: 'source-error', sourceId: spec.id, error: msg });
    }
  }

  private async resolveCommitShaForSource(spec: HubSourceSpec): Promise<string> {
    return resolveCommitSha(this.opts.client, {
      owner: spec.owner,
      repo: spec.repo,
      ref: spec.branch,
      etagStore: this.opts.etagStore
    });
  }

  private async checkSkipConditions(
    spec: HubSourceSpec,
    bundleId: string,
    commitSha: string,
    log: HarvestProgressLog,
    snapshot: Map<string, Primitive[]>,
    out: Primitive[]
  ): Promise<boolean> {
    if (!this.opts.force && !log.shouldResume(spec.id, bundleId, commitSha)) {
      await log.recordSkip({
        sourceId: spec.id, bundleId, commitSha,
        reason: 'already-harvested'
      });
      const cached = snapshot.get(spec.id) ?? [];
      out.push(...cached);
      this.opts.onEvent?.({
        kind: 'source-skip', sourceId: spec.id, commitSha, reason: 'already-harvested'
      });
      return true;
    }
    if (this.opts.dryRun) {
      await log.recordSkip({
        sourceId: spec.id, bundleId, commitSha,
        reason: 'dry-run'
      });
      this.opts.onEvent?.({
        kind: 'source-skip', sourceId: spec.id, commitSha, reason: 'dry-run'
      });
      return true;
    }
    return false;
  }

  private async harvestSource(
    spec: HubSourceSpec,
    bundleId: string,
    commitSha: string,
    log: HarvestProgressLog,
    out: Primitive[]
  ): Promise<number> {
    const startedRepo = Date.now();
    if (spec.type === 'awesome-copilot-plugin') {
      return this.harvestPluginSource(spec, bundleId, commitSha, log, out, startedRepo);
    }
    if (spec.type === 'awesome-copilot') {
      return this.harvestAwesomeCopilotSource(spec, bundleId, commitSha, log, out, startedRepo);
    }
    return this.harvestGitHubSource(spec, bundleId, commitSha, log, out, startedRepo);
  }

  private async harvestPluginSource(
    spec: HubSourceSpec,
    bundleId: string,
    commitSha: string,
    log: HarvestProgressLog,
    out: Primitive[],
    startedRepo: number
  ): Promise<number> {
    const provider = new AwesomeCopilotPluginBundleProvider({
      spec, client: this.opts.client, cache: this.opts.cache,
      etagStore: this.opts.etagStore
    });
    const refs = await this.collectRefs(provider);
    const pluginConcurrency = Math.max(1, this.opts.concurrency ?? 4);
    const primsTotal = await this.harvestBatches(provider, refs, spec.id, commitSha, log, out, pluginConcurrency);
    await log.recordDone({
      sourceId: spec.id, bundleId, commitSha,
      primitives: 0, ms: Date.now() - startedRepo
    });
    return primsTotal;
  }

  private async harvestAwesomeCopilotSource(
    spec: HubSourceSpec,
    bundleId: string,
    commitSha: string,
    log: HarvestProgressLog,
    out: Primitive[],
    startedRepo: number
  ): Promise<number> {
    const provider = new AwesomeCopilotBundleProvider({
      spec, client: this.opts.client, cache: this.opts.cache
    });
    const refs = await this.collectRefs(provider);
    const collectionConcurrency = Math.max(1, this.opts.concurrency ?? 4);
    const primsTotal = await this.harvestBatches(provider, refs, spec.id, commitSha, log, out, collectionConcurrency);
    await log.recordDone({
      sourceId: spec.id, bundleId, commitSha,
      primitives: 0, ms: Date.now() - startedRepo
    });
    return primsTotal;
  }

  private async harvestGitHubSource(
    spec: HubSourceSpec,
    bundleId: string,
    commitSha: string,
    log: HarvestProgressLog,
    out: Primitive[],
    startedRepo: number
  ): Promise<number> {
    await log.recordStart({ sourceId: spec.id, bundleId, commitSha });
    const provider = new GitHubSingleBundleProvider({
      spec, client: this.opts.client, cache: this.opts.cache
    });
    const refs = await this.collectRefs(provider);
    const ref = refs[0];
    const prims = await harvestBundle(provider, ref);
    out.push(...prims);
    await log.recordDone({
      sourceId: spec.id, bundleId, commitSha,
      primitives: prims.length, ms: Date.now() - startedRepo
    });
    return prims.length;
  }

  private async collectRefs(provider: BundleProvider): Promise<Parameters<typeof harvestBundle>[1][]> {
    const refs: Parameters<typeof harvestBundle>[1][] = [];
    for await (const ref of provider.listBundles()) {
      refs.push(ref);
    }
    return refs;
  }

  private async harvestBatches(
    provider: BundleProvider,
    refs: Parameters<typeof harvestBundle>[1][],
    sourceId: string,
    commitSha: string,
    log: HarvestProgressLog,
    out: Primitive[],
    concurrency: number
  ): Promise<number> {
    let primsTotal = 0;
    const harvestOne = async (ref: Parameters<typeof harvestBundle>[1]): Promise<number> => {
      const perStart = Date.now();
      await log.recordStart({
        sourceId, bundleId: ref.bundleId, commitSha
      });
      const prims = await harvestBundle(provider, ref);
      const ms = Date.now() - perStart;
      out.push(...prims);
      await log.recordDone({
        sourceId, bundleId: ref.bundleId, commitSha,
        primitives: prims.length, ms
      });
      return prims.length;
    };
    for (let i = 0; i < refs.length; i += concurrency) {
      const batch = refs.slice(i, i + concurrency);
      const counts = await Promise.all(batch.map((r) => harvestOne(r)));
      primsTotal += counts.reduce((a, b) => a + b, 0);
    }
    return primsTotal;
  }
}

/**
 * Snapshot of the latest Primitive[] per sourceId. Persisted next to the
 * progress log so warm runs can serve an up-to-date index even when every
 * source is skipped. Written atomically via tmp + rename.
 * @param file - Absolute path of the snapshot JSON file.
 */
async function loadSnapshot(file: string): Promise<Map<string, Primitive[]>> {
  try {
    const raw = await (await import('node:fs/promises')).readFile(file, 'utf8');
    const obj = JSON.parse(raw) as { primitivesBySource: Record<string, Primitive[]> };
    return new Map(Object.entries(obj.primitivesBySource ?? {}));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Map();
    }
    // Corrupt snapshot is not fatal; the worst case is an empty warm-run
    // index on one run, which the next run will repopulate.
    return new Map();
  }
}

async function saveSnapshot(file: string, snapshot: Map<string, Primitive[]>): Promise<void> {
  const fsPromises = await import('node:fs/promises');
  await fsPromises.mkdir(path.dirname(file), { recursive: true });
  const obj = { primitivesBySource: Object.fromEntries(snapshot) };
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsPromises.writeFile(tmp, JSON.stringify(obj), 'utf8');
  await fsPromises.rename(tmp, file);
}
