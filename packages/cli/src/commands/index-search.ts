/**
 * `prompt-registry index search` — search a primitive index.
 *
 * Framework command replacing the legacy `primitive-index search`
 * verb. The semantics are identical (BM25 + facets, deterministic
 * ranking) but output goes through `formatOutput` so JSON callers
 * get the canonical envelope and text callers get a readable table.
 *
 * Default index path is `<XDG cache>/primitive-index.json`; override
 * with `--index <FILE>`.
 * @module cli/commands/index-search
 */
import {
  generateSourceId,
} from '@prompt-registry/core';
import type {
  HttpClient,
  RegistrySource,
  Target,
  TokenProvider,
} from '@prompt-registry/core';
import {
  defaultIndexFile,
  defaultTokenProvider,
  loadIndex,
  NodeHttpClient,
  readTargets,
} from '@prompt-registry/infra';
import type {
  PrimitiveKind,
  SearchQuery,
  SearchResult,
} from '@prompt-registry/infra';
import inquirer from 'inquirer';
import {
  Command,
  type Context,
  createHubManager,
  failWith,
  formatOutput,
  getCommandContext,
  Option,
  type OutputFormat,
  readTargetsSafely,
  RegistryError,
} from '../framework';
import {
  installBundleWithSource,
} from './install';

export interface IndexSearchOptions {
  output?: OutputFormat;
  /** Free-text query. */
  query?: string;
  /** Path to the index JSON. Defaults to `<XDG cache>/primitive-index.json`. */
  indexFile?: string;
  /** Filter by primitive kind. */
  kinds?: PrimitiveKind[];
  /** Filter by source id. */
  sources?: string[];
  /** Filter by bundle id. */
  bundles?: string[];
  /** Filter by tag. */
  tags?: string[];
  /** Show only installed primitives. */
  installedOnly?: boolean;
  /** Cap number of hits returned. */
  limit?: number;
  /** Skip the first `offset` hits. */
  offset?: number;
  /** Include per-term explanation in each hit. */
  explain?: boolean;
  /** After showing results, interactively select bundles and install them. */
  install?: boolean;
  /** Show a checkbox selector when combined with --install (mirrors install --interactive). */
  interactive?: boolean;
  /** Target name to install into (used with --install). Defaults to auto-detect. */
  installTarget?: string;
  /** DI seam: HTTP client (tests). */
  http?: HttpClient;
  /** DI seam: token provider (tests). */
  tokens?: TokenProvider;
}

/**
 * Index search command class.
 * Supports free-text query and facet filters.
 */
export class IndexSearchCommand extends Command {
  public static readonly paths = [['index', 'search'], ['search']];

  public static readonly usage = Command.Usage({
    description: 'Search a primitive index by free text + facets.',
    category: 'Index & Search',
    details: `
      Usage: prompt-registry index search [options] [query]

      Options:
        --query <text>           Search query text
        --index <path>           Path to index file
        --kinds <kinds>          Filter by primitive kind (comma-separated)
        --sources <sources>       Filter by source IDs (comma-separated)
        --bundles <bundles>      Filter by bundle IDs (comma-separated)
        --tags <tags>            Filter by tags (comma-separated)
        --installed-only          Show only installed primitives
        --limit <n>              Limit number of results
        --offset <n>             Skip first n results
        --explain                 Show search scoring explanation
        --install                Install matching primitives
        --interactive            Interactive mode for installation
        --install-target <name>  Target name for installation
        -o, --output <format>    Output format (text, json, yaml, ndjson)

      Examples:
        prompt-registry index search "docker"
        prompt-registry index search --query "docker" --kinds skill
        prompt-registry index search --sources github --limit 10
    `
  });

  public query = Option.String('--query');
  public index = Option.String('--index');
  public output = Option.String('-o,--output');
  public kinds = Option.Array('--kinds');
  public sources = Option.Array('--sources');
  public bundles = Option.Array('--bundles');
  public tags = Option.Array('--tags');
  public installedOnly = Option.Boolean('--installed-only');
  public limit = Option.String('--limit');
  public offset = Option.String('--offset');
  public explain = Option.Boolean('--explain');
  public install = Option.Boolean('--install', false);
  public interactive = Option.Boolean('--interactive', false);
  public installTarget = Option.String('--install-target');

  public async execute(): Promise<number> {
    const ctx = getCommandContext(this);

    const fmt = (this.output ?? 'text') as OutputFormat;
    const indexPath = this.index ?? defaultIndexFile(ctx.env);

    try {
      const idx = loadIndex(indexPath);
      const query: SearchQuery = {
        q: this.query,
        kinds: this.kinds as PrimitiveKind[],
        sources: this.sources,
        bundles: this.bundles,
        tags: this.tags,
        installedOnly: this.installedOnly,
        limit: this.limit ? Number.parseInt(this.limit, 10) : undefined,
        offset: this.offset ? Number.parseInt(this.offset, 10) : undefined,
        explain: this.explain
      };
      const result = idx.search(query);
      formatOutput({
        ctx,
        command: 'index.search',
        output: fmt,
        status: 'ok',
        data: result,
        textRenderer: (r) => renderSearchText(r)
      });
      if (this.install && result.hits.length > 0) {
        return await searchAndInstall(
          result,
          { installTarget: this.installTarget, interactive: this.interactive },
          ctx,
          fmt
        );
      }
      return 0;
    } catch (cause) {
      return failWith(ctx, fmt, 'index.search', classifyError(cause, indexPath));
    }
  }
}

/**
 * After a search, offer interactive bundle selection and install.
 * Maps primitive `bundle.sourceId` → hub RegistrySource via `generateSourceId`.
 * @param result Search result.
 * @param opts Options (installTarget, http, tokens).
 * @param ctx CLI context.
 * @param fmt Output format.
 * @returns Exit code.
 */

type SearchCandidate = { bundleId: string; version: string; source: RegistrySource };

function buildSearchCandidates(sources: RegistrySource[], hits: SearchResult['hits']): SearchCandidate[] {
  const sourceById = new Map<string, RegistrySource>();
  for (const src of sources) {
    sourceById.set(generateSourceId(src.type, src.url), src);
    sourceById.set(src.id, src);
  }
  const seen = new Set<string>();
  const result: SearchCandidate[] = [];
  for (const hit of hits) {
    const b = hit.primitive.bundle;
    if (seen.has(b.bundleId)) {
      continue;
    }
    seen.add(b.bundleId);
    const src = sourceById.get(b.sourceId);
    if (src !== undefined) {
      result.push({ bundleId: b.bundleId, version: b.bundleVersion, source: src });
    }
  }
  return result;
}

async function selectBundleIds(candidates: SearchCandidate[], interactive: boolean, ctx: Context): Promise<string[] | null> {
  if (!interactive) {
    return candidates.map((c) => c.bundleId);
  }
  const choices = candidates.map((c) => ({
    name: `${c.bundleId}@${c.version}  (${c.source.name})`,
    value: c.bundleId,
    short: c.bundleId
  }));
  const answer = await inquirer.prompt<{ selectedIds: string[] }>([
    {
      type: 'checkbox',
      name: 'selectedIds',
      message: 'Select bundles to install:',
      choices,
      validate: (input: string[]) => input.length > 0 || 'Select at least one bundle'
    }
  ]);
  if (answer.selectedIds.length === 0) {
    ctx.stdout.write('No bundles selected.\n');
    return null;
  }
  return answer.selectedIds;
}

async function installSelectedBundles(
  selectedIds: string[],
  candidates: SearchCandidate[],
  target: Target,
  ctx: Context,
  http: HttpClient,
  tokens: TokenProvider,
  fmt: OutputFormat
): Promise<number> {
  let installed = 0;
  for (const bundleId of selectedIds) {
    const c = candidates.find((x) => x.bundleId === bundleId);
    if (c === undefined) {
      continue;
    }
    try {
      const code = await installBundleWithSource(bundleId, c.source, target, ctx, http, tokens, fmt);
      if (code === 0) {
        installed++;
      }
    } catch (err) {
      ctx.stderr.write(`Failed to install ${bundleId}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  ctx.stdout.write(`Installed ${installed}/${selectedIds.length} bundle(s)\n`);
  return installed === selectedIds.length ? 0 : 1;
}

async function searchAndInstall(
  result: SearchResult,
  opts: Pick<IndexSearchOptions, 'installTarget' | 'interactive' | 'http' | 'tokens'>,
  ctx: Context,
  fmt: OutputFormat
): Promise<number> {
  const http = opts.http ?? new NodeHttpClient();
  const tokens = opts.tokens ?? defaultTokenProvider(ctx.env);
  const mgr = createHubManager({ ctx, http, tokens });
  const active = await mgr.getActiveHub();
  if (active === null) {
    ctx.stderr.write('No active hub found. Run `prompt-registry hub use <id>` first.\n');
    return 1;
  }

  const candidates = buildSearchCandidates(active.config.sources, result.hits);

  if (candidates.length === 0) {
    ctx.stdout.write('No bundles from the active hub matched the search results.\n');
    return 0;
  }

  const selectedIds = await selectBundleIds(candidates, opts.interactive ?? false, ctx);
  if (selectedIds === null) {
    return 0;
  }

  const targets = await readTargetsSafely(readTargets({ cwd: ctx.cwd(), fs: ctx.fs }));
  let target: Target | undefined;
  if (opts.installTarget && opts.installTarget.length > 0) {
    target = targets.find((t) => t.name === opts.installTarget);
  } else if (targets.length === 1) {
    target = targets[0];
  } else if (targets.length > 1 && opts.interactive) {
    const { chosenTarget } = await inquirer.prompt<{ chosenTarget: string }>([
      { type: 'list', name: 'chosenTarget', message: 'Select target:', choices: targets.map((t) => ({ name: `${t.name} (${t.type})`, value: t.name })) }
    ]);
    target = targets.find((t) => t.name === chosenTarget);
  } else if (targets.length > 1) {
    ctx.stderr.write('Multiple targets configured. Use --install-target <name> to specify one.\n');
    return 1;
  }

  if (target === undefined) {
    ctx.stderr.write('No target found. Run `prompt-registry target add` first.\n');
    return 1;
  }

  ctx.stdout.write(`\nInstalling ${selectedIds.length} bundle(s) to target "${target.name}"\n`);
  if (opts.interactive) {
    const { proceed } = await inquirer.prompt<{ proceed: boolean }>([
      { type: 'confirm', name: 'proceed', message: 'Proceed with installation?', default: true }
    ]);
    if (!proceed) {
      ctx.stdout.write('Installation cancelled.\n');
      return 0;
    }
  }

  return installSelectedBundles(selectedIds, candidates, target, ctx, http, tokens, fmt);
}

const classifyError = (cause: unknown, indexPath: string): RegistryError => {
  if (cause instanceof RegistryError) {
    return cause;
  }
  const msg = cause instanceof Error ? cause.message : String(cause);
  // Missing-file is the most common operator error and deserves a
  // dedicated code so scripts can branch on it.
  if (/ENOENT|no such file/i.test(msg)) {
    return new RegistryError({
      code: 'INDEX.NOT_FOUND',
      message: `index not found: ${indexPath}`,
      hint: 'Run `prompt-registry index build` or `prompt-registry index harvest` first.',
      cause: cause instanceof Error ? cause : undefined
    });
  }
  return new RegistryError({
    code: 'INDEX.LOAD_FAILED',
    message: `failed to load index ${indexPath}: ${msg}`,
    cause: cause instanceof Error ? cause : undefined
  });
};

const renderSearchText = (r: SearchResult): string => {
  const lines: string[] = [`total: ${String(r.total)}  took: ${String(r.tookMs)}ms`];
  for (const hit of r.hits) {
    const p = hit.primitive;
    lines.push(
      `${hit.score.toFixed(3)}  [${p.kind}] ${p.title}`
      + `  (${p.bundle.sourceId}/${p.bundle.bundleId})  ${p.id}`
    );
    if (p.description.length > 0) {
      lines.push(`      ${p.description}`);
    }
  }
  return lines.join('\n') + '\n';
};
