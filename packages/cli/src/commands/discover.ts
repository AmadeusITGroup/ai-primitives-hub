/**
 * `ai-primitives-hub discover` — context-aware resource discovery.
 *
 * Analyzes project context (tech stack, domain, activity) and searches
 * the primitive index for relevant Copilot resources.
 *
 * The non-AI path is implemented today. The `--ai` and `--interactive`
 * flags are reserved for a future Copilot SDK integration and currently
 * fail with a clear, structured error.
 * @module commands/discover
 */
import type {
  DetectedContext,
} from '@ai-primitives-hub/app';
import {
  buildSearchQueries,
  ContextDetector,
} from '@ai-primitives-hub/app';
import type {
  PrimitiveKind,
  SearchHit,
} from '@ai-primitives-hub/infra';
import {
  defaultIndexFile,
  loadIndex,
} from '@ai-primitives-hub/infra';
import {
  Command,
  failWith,
  formatOutput,
  getCommandContext,
  Option,
  type OutputFormat,
  parseCsvKinds,
  RegistryError,
} from '../framework';

/**
 * Deduplicate search hits by primitive identity, keeping the highest score.
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
 * Render discovery results as human-readable text.
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
 * Classify errors for the discover command.
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
      hint: 'Run `ai-primitives-hub index build` or `ai-primitives-hub index harvest` first.',
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

/**
 * Discover command class.
 */
export class DiscoverCommand extends Command {
  public static readonly paths = [['discover']];

  public static readonly usage = Command.Usage({
    description: 'Discover relevant Copilot resources based on project context.',
    category: 'Hub & Discovery',
    details: `
      Usage: ai-primitives-hub discover [options]

      Examples:
        ai-primitives-hub discover
        ai-primitives-hub discover --limit 20
        ai-primitives-hub discover --kinds prompt,skill
        ai-primitives-hub discover --index ./primitive-index.json

      Options:
        --index <path>         Path to index JSON (default: XDG cache/primitive-index.json)
        --limit <n>            Limit number of recommendations (default: 10)
        --kinds <kinds>        Filter by primitive kind (comma-separated)
        --ai                   Enable AI-powered recommendations (not yet implemented)
        --interactive          Enable interactive mode (not yet implemented)
        -o, --output <format>  Output format (text, json, yaml, ndjson)
    `
  });

  public output = Option.String('-o,--output');
  public index = Option.String('--index');
  public limit = Option.String('--limit');
  public kinds = Option.String('--kinds');
  public enableAI = Option.Boolean('--ai');
  public interactive = Option.Boolean('--interactive');

  public async execute(): Promise<number> {
    const ctx = getCommandContext(this);
    const fmt = (this.output ?? 'text') as OutputFormat;
    const indexPath = this.index ?? defaultIndexFile(ctx.env);
    const limit = this.limit ? Number.parseInt(this.limit, 10) : undefined;
    const cwd = ctx.cwd();

    if (this.enableAI) {
      return failWith(ctx, fmt, 'discover', new RegistryError({
        code: 'USAGE.AI_NOT_IMPLEMENTED',
        message: 'AI-powered discovery is not yet implemented',
        hint: 'Run `ai-primitives-hub discover` without `--ai` for context-aware index search.'
      }));
    }

    if (this.interactive) {
      return failWith(ctx, fmt, 'discover', new RegistryError({
        code: 'USAGE.INTERACTIVE_NOT_IMPLEMENTED',
        message: 'Interactive discovery is not yet implemented',
        hint: 'Run `ai-primitives-hub discover` without `--interactive`.'
      }));
    }

    let kinds: PrimitiveKind[] | undefined;
    try {
      kinds = parseCsvKinds(this.kinds);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return failWith(ctx, fmt, 'discover', new RegistryError({
        code: 'USAGE.INVALID_FLAG',
        message: msg,
        hint: 'Use a comma-separated list of primitive kinds.'
      }));
    }

    try {
      const detector = new ContextDetector({ cwd });
      const context = await detector.detect();

      const idx = loadIndex(indexPath);
      const queries = buildSearchQueries(context);

      const allHits: SearchHit[] = [];
      for (const query of queries) {
        const result = idx.search({
          q: query,
          kinds,
          limit: limit ?? 5
        });
        allHits.push(...result.hits);
      }

      const uniqueHits = deduplicateHits(allHits);
      const sortedHits = uniqueHits.toSorted((a, b) => b.score - a.score);
      const rankedHits = sortedHits.slice(0, limit ?? 10);

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
}
