/**
 * `prompt-registry index build` — build a primitive index from a
 * local folder of bundles.
 *
 * Wraps `LocalFolderBundleProvider` + `PrimitiveIndex.buildFrom` and
 * persists via `saveIndex`. Output goes through `formatOutput` so
 * callers get a stable JSON envelope on `-o json`.
 * @module cli/commands/index-build
 */
import * as path from 'node:path';
import type {
  IndexStats,
} from '@prompt-registry/infra';
import {
  LocalFolderBundleProvider,
  PrimitiveIndex,
  saveIndex,
} from '@prompt-registry/infra';
import {
  Command,
  failWith,
  formatOutput,
  getCommandContext,
  Option,
  type OutputFormat,
  RegistryError,
} from '../framework';

export interface IndexBuildOptions {
  output?: OutputFormat;
  /** Root folder containing bundle subdirectories. Required. */
  root: string;
  /** Output path. Defaults to `<root>/primitive-index.json`. */
  outFile?: string;
  /** Source id label. Defaults to the basename of `root`. */
  sourceId?: string;
}

interface BuildResult {
  outFile: string;
  stats: IndexStats;
}

/**
 * Index build command class.
 * Builds a primitive index from a local folder of bundles.
 */
export class IndexBuildCommand extends Command {
  public static readonly paths = [['index', 'build']];

  public static readonly usage = Command.Usage({
    description: 'Build a primitive index from a local folder of bundles.',
    category: 'Index & Search',
    details: `
      Usage: prompt-registry index build --root <DIR> [options]

      Options:
        --root <dir>            Root directory containing bundles (required)
        --out, --out-file <path>  Output index file path
        --source-id <id>         Source ID for the index
        -o, --output <format>     Output format (text, json, yaml, ndjson)

      Examples:
        prompt-registry index build --root ./bundles
        prompt-registry index build --root ./bundles --out /tmp/index.json
        prompt-registry index build --root ./bundles --source-id my-source
    `
  });

  public root = Option.String('--root');
  public out = Option.String('--out,--out-file');
  public sourceId = Option.String('--source-id');
  public output = Option.String('-o,--output');

  public async execute(): Promise<number> {
    const ctx = getCommandContext(this);

    const fmt = (this.output ?? 'text') as OutputFormat;

    if (!this.root || this.root.length === 0) {
      return failWith(ctx, fmt, 'index.build', new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'index build: --root <DIR> is required'
      }));
    }

    try {
      const outFile = this.out ?? path.join(this.root, 'primitive-index.json');
      const provider = new LocalFolderBundleProvider({
        root: this.root,
        sourceId: this.sourceId
      });
      const idx = await PrimitiveIndex.buildFrom(provider, {
        hubId: this.sourceId
      });
      saveIndex(idx, outFile);
      const stats = idx.stats();
      const data: BuildResult = { outFile, stats };
      formatOutput({
        ctx,
        command: 'index.build',
        output: fmt,
        status: 'ok',
        data,
        textRenderer: (d) =>
          `built ${String(d.stats.primitives)} primitives `
          + `from ${String(d.stats.bundles)} bundles → ${d.outFile}\n`
      });
      return 0;
    } catch (cause) {
      const err = new RegistryError({
        code: 'INDEX.BUILD_FAILED',
        message: `index build failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause: cause instanceof Error ? cause : undefined
      });
      return failWith(ctx, fmt, 'index.build', err);
    }
  }
}

// Re-export for symmetry with other commands' default-path helpers.

export { defaultIndexFile } from '@prompt-registry/infra';
