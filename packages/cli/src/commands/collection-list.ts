/**
 * `collection list` subcommand.
 *
 * Lists `*.collection.yml` files under `<cwd>/collections/` and prints
 * their id/name/path. Emits via `formatOutput` (text/json/yaml/ndjson).
 * @module commands/collection-list
 */
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import {
  Command,
  type Context,
  formatOutput,
  Option,
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
      // Skip ill-formed YAML files; bad files are caught by `collection validate`.
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

/**
 * Collection list command class.
 */
export class CollectionListCommand extends Command {
  public static readonly paths = [['collection', 'list']];

  public static readonly usage = Command.Usage({
    description: 'List `*.collection.yml` files and print their id/name/path.',
    category: 'Build & Author',
    details: `
      Usage: ai-primitives-hub collection list [options]

      Options:
        -o, --output <format>  Output format (text, json, yaml, ndjson)
    `
  });

  public output = Option.String('-o', '--output') as OutputFormat | undefined;
  public commandContext!: { ctx: Context };

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
        // Text mode: human-readable error to stderr.
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
