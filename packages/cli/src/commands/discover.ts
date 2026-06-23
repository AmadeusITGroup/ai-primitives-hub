/**
 * `discover` command — context-aware resource discovery.
 *
 * Analyzes project context (tech stack, domain, activity) and searches
 * the primitive index for relevant Copilot resources (prompts, instructions,
 * agents, skills, chatmodes, MCP servers).
 *
 * Usage:
 *   prompt-registry discover [--index <path>] [--limit <n>] [--kinds <kinds>]
 * @module cli/commands/discover
 */
import {
  buildSearchQueries,
  ContextDetector,
  type DetectedContext,
  RecommendationEngine,
} from '@prompt-registry/app';
import type {
  DiscoveryOptions as DomainDiscoveryOptions,
} from '@prompt-registry/core';
import type {
  PrimitiveKind,
  SearchHit,
} from '@prompt-registry/infra';
import {
  CopilotSdkClient,
  defaultIndexFile,
  loadIndex,
} from '@prompt-registry/infra';
import {
  Command,
  failWith,
  getCommandContext,
  Option,
} from '../framework';
import {
  type CommandDefinition,
  type Context,
  defineCommand,
  formatOutput,
  type OutputFormat,
  RegistryError,
} from '../framework';

/**
 * Discover command options.
 */
export interface DiscoverOptions {
  output?: OutputFormat;
  /** Path to the index JSON. */
  indexFile?: string;
  /** Limit number of recommendations. */
  limit?: number;
  /** Filter by primitive kind. */
  kinds?: PrimitiveKind[];
  /** Working directory to analyze. */
  cwd?: string;
  /** Enable AI-powered recommendations. */
  enableAI?: boolean;
  /** Enable interactive mode. */
  interactive?: boolean;
}

/**
 * Build the `discover` command.
 * @param opts CLI options.
 * @returns CommandDefinition.
 */
export const createDiscoverCommand = (
  opts: DiscoverOptions = {}
): CommandDefinition =>
  defineCommand({
    path: ['discover'],
    description: 'Discover relevant Copilot resources based on project context.',
    category: 'Hub & Discovery',
    run: async ({ ctx }: { ctx: Context }): Promise<number> => {
      const fmt = opts.output ?? 'text';
      const indexPath = opts.indexFile ?? defaultIndexFile(ctx.env);
      const cwd = opts.cwd ?? ctx.cwd();

      try {
        // Detect context
        const detector = new ContextDetector({ cwd });
        const context = await detector.detect();

        // Use AI recommendations if enabled
        if (opts.enableAI) {
          const copilotSdk = new CopilotSdkClient();
          const engine = new RecommendationEngine(copilotSdk);

          const domainOptions: DomainDiscoveryOptions = {
            enableAI: true,
            interactive: opts.interactive ?? false,
            cwd,
            indexFile: indexPath,
            limit: opts.limit,
            kinds: opts.kinds
          };

          const recommendations = await engine.generateRecommendations(context, domainOptions);

          formatOutput({
            ctx,
            command: 'discover',
            output: fmt,
            status: 'ok',
            data: {
              context,
              aiEnabled: true,
              recommendations
            },
            textRenderer: (d) => renderAiDiscoveryText(d.context, d.recommendations)
          });
          return 0;
        }

        // Load index
        const idx = loadIndex(indexPath);

        // Build search queries from context
        const queries = buildSearchQueries(context);

        // Search for each query and aggregate results
        const allHits: SearchHit[] = [];
        for (const query of queries) {
          const result = idx.search({
            q: query,
            kinds: opts.kinds,
            limit: opts.limit ?? 5
          });
          allHits.push(...result.hits);
        }

        // Deduplicate and rank by score
        const uniqueHits = deduplicateHits(allHits);
        const sortedHits = uniqueHits.toSorted((a, b) => b.score - a.score);
        const rankedHits = sortedHits.slice(0, opts.limit ?? 10);

        formatOutput({
          ctx,
          command: 'discover',
          output: fmt,
          status: 'ok',
          data: {
            context,
            queries,
            results: rankedHits
          },
          textRenderer: (d) => renderDiscoveryText(d.context, d.queries, d.results)
        });
        return 0;
      } catch (cause) {
        return failWith(ctx, fmt, 'discover', classifyError(cause, indexPath));
      }
    }
  });

/**
 * Discover command class.
 */
export class DiscoverCommand extends Command {
  public static readonly paths = [['discover']];

  public static readonly usage = Command.Usage({
    description: 'Discover relevant Copilot resources based on project context.',
    category: 'Hub & Discovery',
    details: `
      Usage: prompt-registry discover [options]

      Examples:
        prompt-registry discover
        prompt-registry discover --limit 20
        prompt-registry discover --kinds prompt,skill
        prompt-registry discover --ai
        prompt-registry discover --ai --interactive

      Options:
        --index <path>         Path to index JSON (default: XDG cache/primitive-index.json)
        --limit <n>            Limit number of recommendations (default: 10)
        --kinds <kinds>        Filter by primitive kind (comma-separated)
        --ai                   Enable AI-powered recommendations
        --interactive          Enable interactive mode
        -o, --output <format>  Output format (text, json, yaml, ndjson)
    `
  });

  public output = Option.String('-o', '--output') as OutputFormat | undefined;
  public index = Option.String('--index');
  public limit = Option.String('--limit');
  public kinds = Option.Array('--kinds');
  public enableAI = Option.Boolean('--ai');
  public interactive = Option.Boolean('--interactive');

  public async execute(): Promise<number> {
    const ctx = getCommandContext(this);

    const fmt = (this.output ?? 'text');
    const indexPath = this.index ?? defaultIndexFile(ctx.env);
    const limit = this.limit ? Number.parseInt(this.limit, 10) : undefined;

    const opts: DiscoverOptions = {
      output: fmt,
      indexFile: indexPath,
      limit,
      kinds: this.kinds as PrimitiveKind[],
      cwd: ctx.cwd(),
      enableAI: this.enableAI,
      interactive: this.interactive
    };

    const cmd = createDiscoverCommand(opts);
    return cmd.run({ ctx });
  }
}

/**
 * Deduplicate hits by primitive ID.
 * @param hits Search hits.
 * @returns Deduplicated hits.
 */
export function deduplicateHits(hits: SearchHit[]): SearchHit[] {
  const unique = new Map<string, SearchHit>();

  for (const hit of hits) {
    const key = `${hit.primitive.id}:${hit.primitive.bundle.sourceId}:${hit.primitive.bundle.bundleId}`;
    const existing = unique.get(key);
    if (!existing || hit.score > existing.score) {
      unique.set(key, hit);
    }
  }

  return Array.from(unique.values());
}

/**
 * Render discovery results as text.
 * @param context Detected context.
 * @param queries Search queries used.
 * @param results Search hits.
 * @returns Formatted text.
 */
export function renderDiscoveryText(
  context: DetectedContext,
  queries: string[],
  results: SearchHit[]
): string {
  const lines = [
    'Detected Context:',
    `  Languages: ${context.techStack.languages.join(', ') || 'none'}`,
    `  Frameworks: ${context.techStack.frameworks.join(', ') || 'none'}`,
    `  Domain: ${context.domain.category || context.domain.businessDomain || 'unknown'}`,
    '',
    'Search Queries:',
    ...queries.map((q) => `  - ${q}`),
    '',
    `Recommendations (${results.length}):`,
    ...results.flatMap((hit) => {
      const p = hit.primitive;
      const line = `  [${hit.score.toFixed(3)}] [${p.kind}] ${p.title} (${p.bundle.sourceId}/${p.bundle.bundleId})`;
      return p.description.length > 0 ? [line, `      ${p.description}`] : [line];
    }),
    ''
  ];

  return lines.join('\n');
}

/**
 * Render AI-powered discovery results as text.
 * @param context Detected context.
 * @param recommendations AI recommendations.
 * @returns Formatted text.
 */
export function renderAiDiscoveryText(
  context: DetectedContext,
  recommendations: unknown[]
): string {
  const lines = [
    'Detected Context:',
    `  Languages: ${context.techStack.languages.join(', ') || 'none'}`,
    `  Frameworks: ${context.techStack.frameworks.join(', ') || 'none'}`,
    `  Domain: ${context.domain.category || context.domain.businessDomain || 'unknown'}`,
    '',
    'AI-Powered Recommendations:',
    ...recommendations.map((rec) => {
      const r = rec as { type: string; name: string; description: string; relevanceScore: number; reasoning: string; source: string };
      return [
        `  [${r.type}] ${r.name}`,
        `    Score: ${r.relevanceScore.toFixed(3)}`,
        `    Source: ${r.source}`,
        `    Reasoning: ${r.reasoning}`,
        r.description.length > 0 ? `    Description: ${r.description}` : ''
      ].filter(Boolean).join('\n');
    }),
    ''
  ];

  return lines.join('\n');
}

/**
 * Classify errors for discover command.
 * @param cause Error cause.
 * @param indexPath Index path.
 * @returns RegistryError.
 */
const classifyError = (cause: unknown, indexPath: string): RegistryError => {
  if (cause instanceof RegistryError) {
    return cause;
  }
  const msg = cause instanceof Error ? cause.message : String(cause);
  if (/ENOENT|no such file/i.test(msg)) {
    return new RegistryError({
      code: 'INDEX.NOT_FOUND',
      message: `index not found: ${indexPath}`,
      hint: 'Run `prompt-registry index build` or `prompt-registry index harvest` first.',
      cause: cause instanceof Error ? cause : undefined
    });
  }
  if (/EACCES|permission/i.test(msg)) {
    return new RegistryError({
      code: 'INDEX.PERMISSION',
      message: `permission denied accessing index: ${indexPath}`,
      hint: 'Check file permissions.',
      cause: cause instanceof Error ? cause : undefined
    });
  }
  return new RegistryError({
    code: 'INDEX.ERROR',
    message: `failed to load index: ${msg}`,
    context: { indexFile: indexPath },
    cause: cause instanceof Error ? cause : undefined
  });
};
