/**
 * `index build` — build a primitive index from a local folder of
 * bundles.
 *
 * Delegates to the `buildIndex` use case in `@ai-primitives-hub/app`;
 * this file only parses flags, validates required options, and formats
 * output.
 * @module commands/index-build
 */
import type {
  BuildIndexResult,
} from '@ai-primitives-hub/app';
import {
  buildIndex,
} from '@ai-primitives-hub/app';
import {
  defaultIndexFile,
  LocalFolderBundleProvider,
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
 * Index build command class.
 * Builds a primitive index from a local folder of bundles.
 */
export class IndexBuildCommand extends Command {
  public static readonly paths = [['index', 'build']];

  public static readonly usage = Command.Usage({
    description: 'Build a primitive index from a local folder of bundles.',
    category: 'Index & Search',
    details: `
      Usage: ai-primitives-hub index build [options]

      Options:
        --root <dir>              Root directory containing bundles (default: current directory)
        --out, --out-file <path>  Output index file path (default: <XDG cache>/primitive-index.json)
        --source-id <id>          Source ID for the index
        --embed                   Embed primitive text using the local ternlight model
        --embed-strategy <name>   Embedding strategy: single (default) or dual
        -o, --output <format>     Output format (text, json, yaml, ndjson)

      Examples:
        ai-primitives-hub index build
        ai-primitives-hub index build --embed
        ai-primitives-hub index build --embed --embed-strategy dual
        ai-primitives-hub index build --root ./bundles
        ai-primitives-hub index build --root ./bundles --out /tmp/index.json
        ai-primitives-hub index build --root ./bundles --source-id my-source
    `
  });

  public root = Option.String('--root');
  public out = Option.String('--out,--out-file');
  public sourceId = Option.String('--source-id');
  public embed = Option.Boolean('--embed', false);
  public embedStrategy = Option.String('--embed-strategy');
  public output = Option.String('-o,--output');
  public commandContext!: { ctx: Context };

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;

    const fmt = (this.output ?? 'text') as OutputFormat;
    const root = this.root ?? ctx.cwd();

    try {
      const outFile = this.out ?? defaultIndexFile(ctx.env);
      const provider = new LocalFolderBundleProvider({
        root,
        sourceId: this.sourceId
      });
      const data: BuildIndexResult = await buildIndex({
        provider,
        outFile,
        hubId: this.sourceId,
        embed: this.embed,
        embedStrategy: this.embedStrategy as 'single' | 'dual' | undefined,
        onLog: (msg): void => {
          ctx.stderr.write(`[index build] ${msg}\n`);
        }
      });
      formatOutput({
        ctx,
        command: 'index.build',
        output: fmt,
        status: 'ok',
        data,
        textRenderer: (d) =>
          `built ${String(d.primitives)} primitives `
          + `from ${String(d.bundles)} bundles → ${d.outFile}`
          + `${d.embeddings ? ` (embeddings: ${d.embeddings.provider} dim=${d.embeddings.dim})` : ''}\n`
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
