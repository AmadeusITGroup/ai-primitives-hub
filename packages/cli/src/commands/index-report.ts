/**
 * `prompt-registry index report` — render a human-readable harvest
 * report from a JSONL progress log.
 *
 * Replaces the legacy `primitive-index hub-report` verb. JSON mode
 * emits a `{ summary, cacheStats?, bundles }` payload; text mode
 * renders a markdown header + per-bundle table identical to the
 * legacy output (so existing CI consumers keep their formatting).
 * @module cli/commands/index-report
 */
import * as path from 'node:path';
import {
  BlobCache,
  defaultHubCacheDir,
  defaultProgressFile,
} from '@prompt-registry/infra';
import {
  type BundleState,
  HarvestProgressLog,
  type ProgressSummary,
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

export interface IndexReportOptions {
  output?: OutputFormat;
  /** Hub identifier — used to derive default progressFile + cacheDir. */
  hubRepo?: string;
  /** Override progress file path. Defaults to `<defaultProgressFile(hubRepo)>`. */
  progressFile?: string;
  /** Cache directory; when set, blob-cache stats are included. */
  cacheDir?: string;
}

interface ReportData {
  summary: ProgressSummary;
  cacheStats?: { entries: number; bytes: number };
  bundles: BundleState[];
}

/**
 * Build the `index report` command.
 * @param opts CLI options.
 * @returns CommandDefinition.
 */
export const createIndexReportCommand = (
  opts: IndexReportOptions = {}
): CommandDefinition =>
  defineCommand({
    path: ['index', 'report'],
    description: 'Render a hub-harvest report from a progress log.',
    category: 'Index & Search',
    run: async ({ ctx }: { ctx: Context }): Promise<number> => {
      const fmt = opts.output ?? 'text';
      const progressFile = opts.progressFile ?? defaultProgressFile(opts.hubRepo, ctx.env);
      const cacheDir = opts.cacheDir ?? defaultHubCacheDir(opts.hubRepo, ctx.env);
      try {
        const log = await HarvestProgressLog.open(progressFile);
        const state = log.projectState();
        const summary = log.summary();
        await log.close();
        const bundles = [...state.values()]
          .toSorted((a, b) => a.sourceId.localeCompare(b.sourceId));
        const data: ReportData = { summary, bundles };
        if (cacheDir.length > 0) {
          try {
            const cache = new BlobCache(path.join(cacheDir, 'blobs'));
            data.cacheStats = await cache.stats();
          } catch {
            // Missing cache dir is fine — leave cacheStats undefined.
          }
        }
        formatOutput({
          ctx, command: 'index.report', output: fmt, status: 'ok',
          data,
          textRenderer: (d) => renderReportMarkdown(progressFile, d)
        });
        return 0;
      } catch (cause) {
        const err = new RegistryError({
          code: 'INDEX.REPORT_FAILED',
          message: `index report failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause: cause instanceof Error ? cause : undefined
        });
        return failWith(ctx, fmt, 'index.report', err);
      }
    }
  });

const renderReportMarkdown = (progressFile: string, d: ReportData): string => {
  const lines: string[] = [
    '# Primitive Index — Hub harvest report',
    '',
    `- Progress file: \`${progressFile}\``,
    `- Done: **${String(d.summary.done)}**  Skip: **${String(d.summary.skip)}**  Error: **${String(d.summary.error)}**`,
    `- Primitives (done): **${String(d.summary.primitives)}**  Wall ms: **${String(d.summary.wallMs)}**`
  ];
  if (d.cacheStats !== undefined) {
    lines.push(
      `- Blob cache: **${String(d.cacheStats.entries)}** entries, `
      + `**${(d.cacheStats.bytes / 1024).toFixed(1)} KiB**`
    );
  }
  lines.push(
    '',
    '| Source | Bundle | Status | Commit sha | Primitives | ms | Note |',
    '|--------|--------|--------|-----------|------------|----|------|'
  );
  for (const r of d.bundles) {
    const note = r.status === 'error' ? r.error ?? '' : r.reason ?? '';
    const escapedNote = note.split('|').join(String.raw`\|`);
    lines.push(
      `| ${r.sourceId} | ${r.bundleId} | ${r.status} | ${r.commitSha.slice(0, 10)}`
      + ` | ${r.primitives === undefined ? '—' : String(r.primitives)}`
      + ` | ${r.ms === undefined ? '—' : String(r.ms)}`
      + ` | ${escapedNote} |`
    );
  }
  return lines.join('\n') + '\n';
};

/**
 * Index report command class.
 * Renders a hub-harvest report from a progress log.
 */
export class IndexReportCommand extends Command {
  public static readonly paths = [['index', 'report']];

  public static readonly usage = Command.Usage({
    description: 'Render a hub-harvest report from a progress log.',
    category: 'Index & Search',
    details: `
      Usage: prompt-registry index report [options]

      Examples:
        prompt-registry index report --hub-repo OWNER/REPO
        prompt-registry index report --progress-file /tmp/progress.jsonl
        prompt-registry index report --cache-dir /tmp/cache
    `
  });

  public hubRepo = Option.String('--hub-repo');
  public progressFile = Option.String('--progress-file');
  public cacheDir = Option.String('--cache-dir');
  public output = Option.String('-o,--output');

  public async execute(): Promise<number> {
    const ctx = getCommandContext(this);

    const fmt = (this.output ?? 'text') as OutputFormat;
    const progressFile = this.progressFile ?? defaultProgressFile(this.hubRepo, ctx.env);
    const cacheDir = this.cacheDir ?? defaultHubCacheDir(this.hubRepo, ctx.env);

    try {
      const log = await HarvestProgressLog.open(progressFile);
      const state = log.projectState();
      const summary = log.summary();
      await log.close();
      const bundles = [...state.values()]
        .toSorted((a, b) => a.sourceId.localeCompare(b.sourceId));
      const data: ReportData = { summary, bundles };
      if (cacheDir.length > 0) {
        try {
          const cache = new BlobCache(path.join(cacheDir, 'blobs'));
          data.cacheStats = await cache.stats();
        } catch {
          // Missing cache dir is fine — leave cacheStats undefined.
        }
      }
      formatOutput({
        ctx, command: 'index.report', output: fmt, status: 'ok',
        data,
        textRenderer: (d) => renderReportMarkdown(progressFile, d)
      });
      return 0;
    } catch (cause) {
      const err = new RegistryError({
        code: 'INDEX.REPORT_FAILED',
        message: `index report failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause: cause instanceof Error ? cause : undefined
      });
      return failWith(ctx, fmt, 'index.report', err);
    }
  }
}
