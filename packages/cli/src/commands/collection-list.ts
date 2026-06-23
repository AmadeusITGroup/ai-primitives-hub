/**
 * `collection list` subcommand.
 *
 * Replaces `lib/bin/list-collections.js` (which directly imported
 * `listCollectionFiles` and `readCollection` from `../dist`). The new
 * subcommand:
 *
 *   - Goes through the framework's `Context` for fs access — no
 *     `node:fs` import.
 *   - Emits via `formatOutput` (text/json/yaml/ndjson) — the legacy
 *     binary only emitted JSON.
 *   - Uses `RegistryError` (`FS.NOT_FOUND`) on a missing
 *     `collections/` directory rather than `process.exit(1)` after a
 *     `console.error`.
 *
 * The data shape is preserved (`{ id, name, file }` records) so any
 * downstream consumer parsing the legacy JSON still works after a
 * `--output json` rename.
 */
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import {
  Command,
  copyCommandPrototype,
  Option,
} from '../framework';
import {
  type CommandDefinition,
  type Context,
  defineCommand,
  formatOutput,
  type OutputFormat,
  RegistryError,
  renderError,
  renderTable,
} from '../framework';

/**
 * Collection record.
 */
interface CollectionRecord {
  id: string;
  name: string;
  file: string;
}

/**
 * Command context for collection list command.
 */
interface CollectionListContext {
  ctx: Context;
}

/**
 * Base class for collection list command.
 */
abstract class BaseCollectionListCommand extends Command {
  public commandContext: CollectionListContext = { ctx: null as any };
}

/**
 * Native clipanion class command for collection list.
 */
export class CollectionListCommand extends BaseCollectionListCommand {
  public static readonly paths = [['collection', 'list']];

  public static readonly usage = Command.Usage({
    description: 'List `*.collection.yml` files and print their id/name/path.',
    category: 'Build & Author',
    details: `
      Usage: prompt-registry collection list [options]

      Options:
        -o, --output <format>  Output format (text, json, yaml, ndjson)
    `
  });

  public output = Option.String('-o', '--output') as OutputFormat | undefined;

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const fmt = (this.output ?? 'text');
    const cwd = ctx.cwd();
    const collectionsDir = path.join(cwd, 'collections');
    const dirExists = await ctx.fs.exists(collectionsDir);
    if (!dirExists) {
      const err = new RegistryError({
        code: 'FS.NOT_FOUND',
        message: `collections/ directory not found under ${cwd}`,
        hint: 'Run from a repo root that contains a `collections/` folder, '
          + 'or pass `--cwd <path>` once that flag lands.',
        context: { collectionsDir }
      });
      if (fmt === 'json' || fmt === 'yaml' || fmt === 'ndjson') {
        // Machine-readable: error in the envelope.
        formatOutput({
          ctx,
          command: 'collection.list',
          output: fmt,
          status: 'error',
          data: null,
          errors: [err.toJSON()]
        });
      } else {
        // Text mode: human-readable error to stderr (matches the
        // legacy binary's `console.error` behavior).
        renderError(err, ctx);
      }
      return 1;
    }

    const records = await listCollections(ctx, collectionsDir, cwd);
    formatOutput({
      ctx,
      command: 'collection.list',
      output: fmt,
      status: 'ok',
      data: records,
      textRenderer: renderCollectionsText
    });
    return 0;
  }
}

/**
 * Create a CommandDefinition wrapper for the collection list command class.
 * This adapts native clipanion classes to the framework's CommandDefinition pattern.
 * @param ctx CLI context.
 * @param defaultOutput Default output format (optional).
 * @returns CommandClass.
 */
const createCollectionListCommandDefinition = (
  ctx: Context,
  defaultOutput?: string
): typeof CollectionListCommand => {
  class ConfiguredCommand extends CollectionListCommand {
    public execute(): Promise<number> {
      this.commandContext = { ctx };
      if (defaultOutput !== undefined && !this.output) {
        this.output = defaultOutput as OutputFormat;
      }

      return super.execute();
    }
  }
  copyCommandPrototype(CollectionListCommand, ConfiguredCommand);

  return ConfiguredCommand;
};

/**
 * Factory function to create a configured collection list command class.
 * @param ctx CLI context.
 * @param defaultOutput Default output format (optional).
 * @returns CommandClass.
 */
export const createCollectionListCommandClass = (
  ctx: Context,
  defaultOutput?: string
): typeof CollectionListCommand => {
  return createCollectionListCommandDefinition(ctx, defaultOutput);
};

/**
 * Build the `collection list` command.
 * @param opts - Command options.
 * @param opts.output
 * @returns CommandDefinition wired to the framework adapter.
 */
export const createCollectionListCommand = (
  opts: { output?: OutputFormat } = {}
): CommandDefinition =>
  defineCommand({
    path: ['collection', 'list'],
    description: 'List `*.collection.yml` files and print their id/name/path.',
    category: 'Build & Author',
    run: async ({ ctx }: { ctx: Context }): Promise<number> => {
      const cwd = ctx.cwd();
      const collectionsDir = path.join(cwd, 'collections');
      const dirExists = await ctx.fs.exists(collectionsDir);
      if (!dirExists) {
        const err = new RegistryError({
          code: 'FS.NOT_FOUND',
          message: `collections/ directory not found under ${cwd}`,
          hint: 'Run from a repo root that contains a `collections/` folder, '
            + 'or pass `--cwd <path>` once that flag lands.',
          context: { collectionsDir }
        });
        const output = opts.output ?? 'text';
        if (output === 'json' || output === 'yaml' || output === 'ndjson') {
          // Machine-readable: error in the envelope.
          formatOutput({
            ctx,
            command: 'collection.list',
            output,
            status: 'error',
            data: null,
            errors: [err.toJSON()]
          });
        } else {
          // Text mode: human-readable error to stderr (matches the
          // legacy binary's `console.error` behavior).
          renderError(err, ctx);
        }
        return 1;
      }

      const records = await listCollections(ctx, collectionsDir, cwd);
      formatOutput({
        ctx,
        command: 'collection.list',
        output: opts.output ?? 'text',
        status: 'ok',
        data: records,
        textRenderer: renderCollectionsText
      });
      return 0;
    }
  });

/**
 * List collections from directory.
 * @param ctx CLI context.
 * @param collectionsDir Collections directory path.
 * @param cwd Current working directory.
 * @returns Array of collection records.
 */
const listCollections = async (
  ctx: Context,
  collectionsDir: string,
  cwd: string
): Promise<CollectionRecord[]> => {
  const entries = await ctx.fs.readDir(collectionsDir);
  const ymlFiles = entries.filter((e) => e.endsWith('.collection.yml')).toSorted((a, b) => a.localeCompare(b));
  const records: CollectionRecord[] = [];
  for (const filename of ymlFiles) {
    const absolute = path.join(collectionsDir, filename);
    const text = await ctx.fs.readFile(absolute);
    const doc = yaml.load(text) as { id?: unknown; name?: unknown } | null;
    if (doc === null || typeof doc !== 'object') {
      // Skip ill-formed YAML files; legacy binary would crash, but the
      // CLI should be tolerant — bad files are caught by `collection
      // validate`.
      continue;
    }
    const id = typeof doc.id === 'string' ? doc.id : '';
    const name = typeof doc.name === 'string' ? doc.name : id;
    records.push({
      id,
      name,
      file: path.relative(cwd, absolute)
    });
  }
  return records;
};

/**
 * Render collections as text.
 * @param records Collection records.
 * @returns Formatted text output.
 */
const renderCollectionsText = (records: CollectionRecord[]): string =>
  renderTable<CollectionRecord>({
    columns: [
      { header: 'ID', get: (r) => r.id },
      { header: 'NAME', get: (r) => r.name },
      { header: 'FILE', get: (r) => r.file }
    ],
    rows: records,
    emptyMessage: 'no collections found\n'
  });
