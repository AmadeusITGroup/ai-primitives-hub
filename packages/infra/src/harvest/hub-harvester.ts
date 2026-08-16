/**
 * Hub harvest pipeline — orchestrates the full
 * "fetch hub-config → walk sources → write index" workflow.
 *
 * Extracted from the legacy `lib/src/primitive-index/cli.ts` so the
 * framework command (`ai-primitives-hub index harvest`) and any other
 * caller can drive the same logic without re-implementing argv
 * plumbing.
 *
 * The function takes an `events` callback for observability — the
 * CLI command pipes those into stderr; tests can capture them.
 *
 * Ported from the reference branch's `infra/src/harvest/hub-harvester.ts`.
 * Adaptations (this is the one module in the harvest subsystem that
 * constructs a GitHub client rather than receiving one via DI, so it's
 * also the one place these differences surface):
 *   - `GitHubClient` (reference's standalone class, `{ tokens, env,
 *     fetch, ... }` options) -> `core`'s `GitHubApi` port almost
 *     everywhere, with the concrete `GitHubApiClient` (built on
 *     `NodeHttpClient`) kept only where `.lastRateLimit` telemetry is
 *     read (`BuildHarvestResultParams`/`HubHarvestPipelineResult`).
 *   - `staticTokenProvider` (reference's `github/token.ts` factory,
 *     `string | null`) -> `./auth`'s `StaticTokenProvider` class (`core`'s
 *     `TokenProvider` port, `string | undefined`).
 *   - Dropped the reference's `env` passthrough into the GitHub client
 *     constructor: there, it only ever fed `createProxyAwareFetch(env)`
 *     (HTTP_PROXY/HTTPS_PROXY support) when no explicit `fetch` was
 *     given. `NodeHttpClient` has no proxy-aware-fetch equivalent yet -
 *     a real feature gap, but one for `NodeHttpClient` to close, not
 *     this module to work around.
 * @module harvest/hub-harvester
 */
import {
  readFile,
} from 'node:fs/promises';
import * as path from 'node:path';
import type {
  GitHubApi,
  HubSourceSpec,
  PrimitiveIndexKey,
  PrimitiveIndexStore,
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  StaticTokenProvider,
} from '../auth';
import {
  GitHubApiClient,
  NodeHttpClient,
} from '../http';
import {
  PrimitiveIndex,
} from '../search/primitive-index';
import type {
  BundleProvider,
  EmbeddingProvider,
  IndexStats,
  Primitive,
} from '../search/types';
import {
  saveIndex,
} from '../stores/json-index-store';
import {
  BlobCache,
} from './blob-cache';
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
  EtagStore,
} from './etag-store';
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
  createSourceRevision,
  type SourceRevisionEntry,
} from './source-revision';
import {
  defaultResolver,
  redactToken,
  resolveGithubToken,
  type TokenResolver,
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
  client: GitHubApi | undefined;
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
  result: HubHarvestResult;
  hubRepo: string;
  hubBranch: string;
  sourcesCount: number;
  tokenSource: string;
  client: GitHubApiClient;
  sourceRevision: string;
  hubId: string;
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
  /**
   * Optional embedding provider. When supplied, the harvested primitives are
   * embedded into the index so that `ranking: 'hybrid'` searches work locally.
   */
  embeddings?: EmbeddingProvider;
  /** Embedding strategy when `embeddings` is supplied. Default: `single`. */
  embeddingStrategy?: 'single' | 'dual';
  /** Stable app-level search profile that produced the persisted index. */
  searchProfileId?: string;
  /** Stable hub identity used by the shared namespaced index store. */
  hubId?: string;
  /** Optional shared namespaced index location resolver. */
  indexStore?: PrimitiveIndexStore;
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
  rateLimit: GitHubApiClient['lastRateLimit'];
  tokenSource: string;
  sourceRevision: string;
  hubId: string;
  /** Per-source outcomes used by lifecycle adapters to expose index coverage. */
  sourceCoverage: HarvestSourceCoverage[];
}

function resolveHubRepo(
  noHubConfig: boolean,
  hubConfigFile: string | undefined,
  hubRepo: string | undefined
): { hubRepo: string; hubId: string } {
  const resolvedHubRepo = !noHubConfig && hubConfigFile === undefined
    ? hubRepo as string
    : (hubRepo ?? 'local/local');
  const hubId = hubRepo ?? 'local';
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
  client: GitHubApi | undefined
): Promise<HubSourceSpec[]> {
  if (hubConfigFile !== undefined) {
    return parseHubConfig(await readFile(hubConfigFile, 'utf8'));
  }
  if (noHubConfig) {
    return [];
  }
  if (client === undefined) {
    throw new Error('GitHub client is required to load hub sources');
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
  const hubId = opts.hubId ?? (opts.noHubConfig === true || opts.hubConfigFile !== undefined ? 'local' : hubRepo);

  const requiresHubConfig = opts.noHubConfig !== true && opts.hubConfigFile === undefined;
  let client: GitHubApiClient | undefined;
  let resolvedToken: string | undefined;
  let tokenSource = 'none';

  if (requiresHubConfig) {
    ({ resolvedToken, client, tokenSource } = await createGitHubClient(hubRepo, opts, env));
  } else {
    client = createUnauthenticatedClient();
  }

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

  // A local hub-config still needs an authenticated client for its GitHub
  // sources. The unauthenticated client above is only sufficient to read the
  // local config itself; leaving it in place silently bypasses env/gh token
  // resolution and throttles every source as an anonymous request.
  if (!requiresHubConfig && sources.length > 0) {
    // A local hub-config should still use env/gh credentials when available,
    // but harvesting public sources must continue to work anonymously when
    // no token exists. Token resolution is diagnostic here, not mandatory.
    ({ resolvedToken, client, tokenSource } = await createGitHubClient(hubRepo, opts, env, client));
  }

  // An empty offline harvest must succeed without GitHub credentials.
  // HubHarvester never calls the client when there are no sources.
  const harvestClient = client ?? new GitHubApiClient(
    new NodeHttpClient(),
    { tokenProvider: new StaticTokenProvider('') }
  );

  logHarvestStart(opts, hubRepo, hubBranch, resolvedToken, tokenSource, sources.length, concurrency);
  const result = await runHarvester(
    sources,
    harvestClient,
    new StaticTokenProvider(resolvedToken ?? ''),
    cacheDir,
    progressFile,
    concurrency,
    opts,
    hubId
  );
  const searchProfileId = opts.searchProfileId ?? 'bm25-v1';
  const indexKey: PrimitiveIndexKey = {
    hubId,
    sourceRevision: result.sourceRevision,
    searchProfileId
  };
  const resolvedOutFile = opts.outFile ?? opts.indexStore?.getIndexPath(indexKey) ?? outFile;
  if (opts.dryRun !== true) {
    await writeIndexWithIntegrity(result.index, resolvedOutFile, env);
  }

  const stats = result.index.stats();

  return buildHarvestResult({
    outFile: resolvedOutFile,
    progressFile,
    cacheDir,
    stats,
    result,
    hubRepo,
    hubBranch,
    sourcesCount: sources.length,
    tokenSource,
    client: harvestClient,
    sourceRevision: result.sourceRevision,
    hubId
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

async function createGitHubClient(
  hubRepo: string,
  opts: HubHarvestPipelineOptions,
  env: NodeJS.ProcessEnv,
  fallbackClient?: GitHubApiClient
): Promise<{
  resolvedToken: string | undefined;
  client: GitHubApiClient;
  tokenSource: string;
}> {
  const resolver: TokenResolver = {
    readEnv: (name: string): string | undefined => {
      const value = env[name];
      return value && value.length > 0 ? value : undefined;
    },
    readGhCli: (): Promise<string | undefined> => defaultResolver.readGhCli()
  };
  const token = await resolveGithubToken({ explicit: opts.explicitToken }, resolver);
  if (token.token === undefined || token.token.length === 0) {
    if (fallbackClient) {
      return { resolvedToken: undefined, client: fallbackClient, tokenSource: 'none' };
    }
    throw new Error('No GitHub token available (tried explicit, env, gh CLI).');
  }
  const resolvedToken: string = token.token;
  const client = new GitHubApiClient(new NodeHttpClient(), { tokenProvider: new StaticTokenProvider(resolvedToken) });
  const [owner, repo] = hubRepo.split('/');
  if (owner === undefined || repo === undefined || owner.length === 0 || repo.length === 0) {
    throw new Error(`Invalid hubRepo: ${hubRepo} (expected "owner/repo").`);
  }
  return { resolvedToken, client, tokenSource: token.source };
}

function createUnauthenticatedClient(): GitHubApiClient {
  return new GitHubApiClient(new NodeHttpClient(), { tokenProvider: new StaticTokenProvider('') });
}

function logHarvestStart(
  opts: HubHarvestPipelineOptions,
  hubRepo: string,
  hubBranch: string,
  resolvedToken: string | undefined,
  tokenSource: string,
  sourcesCount: number,
  concurrency: number
): void {
  opts.onLog?.(
    `hub=${hubRepo}@${hubBranch} `
    + `token=${tokenSource}:${redactToken(resolvedToken)} `
    + `sources=${String(sourcesCount)} concurrency=${String(concurrency)}`
  );
}

async function runHarvester(
  sources: HubSourceSpec[],
  client: GitHubApi,
  tokenProvider: TokenProvider,
  cacheDir: string,
  progressFile: string,
  concurrency: number,
  opts: HubHarvestPipelineOptions,
  hubId: string
): Promise<HubHarvestResult> {
  const cache = new BlobCache(path.join(cacheDir, 'blobs'));
  const etagStore = await EtagStore.open(path.join(cacheDir, 'etags.json'));
  const harvester = new HubHarvester({
    sources, client, cache, etagStore,
    progressFile, concurrency,
    force: opts.force ?? false,
    dryRun: opts.dryRun ?? false,
    onEvent: opts.onEvent,
    onLog: opts.onLog,
    embeddings: opts.embeddings,
    embeddingStrategy: opts.embeddingStrategy,
    searchProfileId: opts.searchProfileId,
    hubId
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
      // The progress log is append-only and its primitive total spans prior
      // runs. Report the count in the index written by this invocation.
      primitives: params.stats.primitives,
      wallMs: params.result.wallMs
    },
    hub: { repo: params.hubRepo, branch: params.hubBranch, sources: params.sourcesCount },
    rateLimit: params.client.lastRateLimit,
    tokenSource: params.tokenSource,
    sourceRevision: params.sourceRevision,
    hubId: params.hubId,
    sourceCoverage: params.result.sourceCoverage
  };
}

export interface HubHarvesterOptions {
  sources: HubSourceSpec[];
  client: GitHubApi;
  cache: BlobCache;
  progressFile: string;
  /** Max number of bundles harvested in parallel. Default 1 (serial). */
  concurrency?: number;
  /** Observer hook for CLI logging, tests, etc. */
  onEvent?: (ev: HubHarvestEvent) => void;
  /** Optional diagnostic/progress log sink. */
  onLog?: (msg: string) => void;
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
  /**
   * Optional embedding provider. When supplied, the harvested primitives are
   * embedded into the index so that `ranking: 'hybrid'` searches work locally.
   */
  embeddings?: EmbeddingProvider;
  /** Embedding strategy when `embeddings` is supplied. Default: `single`. */
  embeddingStrategy?: 'single' | 'dual';
  /** Stable app-level search profile that produced the persisted index. */
  searchProfileId?: string;
  /** Stable hub identity stored in index metadata. */
  hubId?: string;
}

/** Outcome of one configured source in a harvest lifecycle operation. */
export interface HarvestSourceCoverage {
  sourceId: string;
  state: 'indexed' | 'skipped' | 'unsupported' | 'failed';
  primitives?: number;
  revision?: string;
  message?: string;
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
  sourceRevision: string;
  /** One deterministic record for every configured source. */
  sourceCoverage: HarvestSourceCoverage[];
}

/* eslint-disable @typescript-eslint/member-ordering -- public API kept at top. */
export class HubHarvester {
  public constructor(private readonly opts: HubHarvesterOptions) {}

  public async run(): Promise<HubHarvestResult> {
    const startedAt = Date.now();
    const log = await HarvestProgressLog.open(this.opts.progressFile);
    const snapshot = await loadSnapshot(this.snapshotFile());
    const primitives: Primitive[] = [];
    const sourceRevisions = new Map<string, SourceRevisionEntry>();
    const sourceCoverage = new Map<string, HarvestSourceCoverage>();
    const concurrency = Math.max(1, this.opts.concurrency ?? 1);

    const queue = [...this.opts.sources];
    const workers: Promise<void>[] = [];

    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const spec = queue.shift();
        if (!spec) {
          return;
        }
        await this.processSource(spec, log, primitives, snapshot, sourceRevisions, sourceCoverage);
      }
    };
    for (let i = 0; i < concurrency; i += 1) {
      workers.push(worker());
    }
    await Promise.all(workers);

    await log.close();

    // Reconstruct the index from the complete active source set. A source can
    // be skipped (and restored from the snapshot) or fail transiently after a
    // previous successful run. The old implementation only saved primitives
    // produced by this invocation, which turned an otherwise recoverable warm
    // run into a one-source/empty index when GitHub returned 403/404 errors.
    const currentBySource = new Map<string, Primitive[]>();
    for (const p of primitives) {
      const list = currentBySource.get(p.bundle.sourceId) ?? [];
      list.push(p);
      currentBySource.set(p.bundle.sourceId, list);
    }
    const activeSourceIds = new Set(this.opts.sources.map((source) => source.id));
    const fresh = new Map<string, Primitive[]>();
    for (const sourceId of activeSourceIds) {
      fresh.set(sourceId, currentBySource.get(sourceId) ?? snapshot.get(sourceId) ?? []);
    }
    await saveSnapshot(this.snapshotFile(), fresh);

    const indexPrimitives = [...fresh.values()].flat();
    const sourceRevision = createSourceRevision([...sourceRevisions.values()]);
    const index = await PrimitiveIndex.buildFromPrimitives(indexPrimitives, {
      hubId: this.opts.hubId,
      sourceRevision,
      embeddings: this.opts.embeddings,
      embeddingStrategy: this.opts.embeddingStrategy,
      searchProfileId: this.opts.searchProfileId,
      onLog: this.opts.onLog
    });
    const summary = log.summary();
    return {
      ...summary,
      totalMs: Date.now() - startedAt,
      index,
      sourceRevision,
      sourceCoverage: this.opts.sources.map((source) => sourceCoverage.get(source.id) ?? {
        sourceId: source.id,
        state: 'failed',
        message: 'Source did not produce a harvest outcome.'
      })
    };
  }

  private snapshotFile(): string {
    return path.join(path.dirname(this.opts.progressFile), 'primitives-snapshot.json');
  }

  private async processSource(
    spec: HubSourceSpec,
    log: HarvestProgressLog,
    out: Primitive[],
    snapshot: Map<string, Primitive[]>,
    sourceRevisions: Map<string, SourceRevisionEntry>,
    sourceCoverage: Map<string, HarvestSourceCoverage>
  ): Promise<void> {
    const bundleId = spec.id;
    this.opts.onLog?.(`processing source ${spec.id}...`);
    this.opts.onEvent?.({ kind: 'source-start', sourceId: spec.id });
    let commitSha: string | undefined;
    try {
      commitSha = await this.resolveCommitShaForSource(spec);
      sourceRevisions.set(spec.id, {
        sourceId: spec.id,
        url: spec.url,
        branch: spec.branch,
        revision: commitSha
      });
      const skipReason = await this.checkSkipConditions(spec, bundleId, commitSha, log, snapshot, out);
      if (skipReason !== undefined) {
        sourceCoverage.set(spec.id, {
          sourceId: spec.id,
          state: 'skipped',
          revision: commitSha,
          message: skipReason
        });
        this.opts.onLog?.(`source ${spec.id} skipped`);
        return;
      }
      const primsTotal = await this.harvestSource(spec, bundleId, commitSha, log, out);
      sourceCoverage.set(spec.id, {
        sourceId: spec.id,
        state: 'indexed',
        primitives: primsTotal,
        revision: commitSha
      });
      this.opts.onLog?.(`source ${spec.id} done: ${String(primsTotal)} primitive${primsTotal === 1 ? '' : 's'}`);
      this.opts.onEvent?.({
        kind: 'source-done', sourceId: spec.id, commitSha,
        primitives: primsTotal, ms: Date.now()
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!sourceRevisions.has(spec.id)) {
        sourceRevisions.set(spec.id, {
          sourceId: spec.id,
          url: spec.url,
          branch: spec.branch,
          revision: commitSha ?? 'unknown'
        });
      }
      await log.recordError({
        sourceId: spec.id, bundleId,
        commitSha: commitSha ?? 'unknown', error: msg
      });
      sourceCoverage.set(spec.id, {
        sourceId: spec.id,
        state: 'failed',
        revision: commitSha,
        message: msg
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
  ): Promise<string | undefined> {
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
      return 'already-harvested';
    }
    if (this.opts.dryRun) {
      await log.recordSkip({
        sourceId: spec.id, bundleId, commitSha,
        reason: 'dry-run'
      });
      this.opts.onEvent?.({
        kind: 'source-skip', sourceId: spec.id, commitSha, reason: 'dry-run'
      });
      return 'dry-run';
    }
    return undefined;
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
