/**
 * `collection affected` subcommand.
 *
 * Given a list of changed paths (typically produced by `git diff
 * --name-only` in a CI workflow), emits the collections whose
 * `.collection.yml`, README or an item path overlaps a changed path.
 *
 * Path normalization: backslash-to-slash, strip a leading `/`, trim.
 * Strings that normalize to empty are dropped silently.
 * @module commands/collection-affected
 */
import {
  listCollectionFiles,
  readCollection,
  resolveCollectionItemPaths,
  resolveCollectionReadmePath,
} from '@ai-primitives-hub/app';
import {
  Command,
  type Context,
  formatOutput,
  Option,
  type OutputFormat,
} from '../framework';

/**
 * Affected collection record.
 */
interface AffectedRecord {
  id: string;
  file: string;
}

/**
 * Normalize path for comparison.
 * @param p Path to normalize.
 * @returns Normalized path.
 */
const normalize = (p: string): string =>
  String(p).replaceAll('\\', '/').replaceAll(/^\/+/g, '').trim();

/**
 * Render affected collections as text.
 * @param d Affected data.
 * @param d.affected
 * @returns Formatted text output.
 */
const renderText = (d: { affected: AffectedRecord[] }): string => {
  if (d.affected.length === 0) {
    return 'no affected collections\n';
  }
  return d.affected.map((a) => `${a.id}  ${a.file}`).join('\n') + '\n';
};

/**
 * Collection affected command class.
 */
export class CollectionAffectedCommand extends Command {
  public static readonly paths = [['collection', 'affected']];

  public static readonly usage = Command.Usage({
    description: 'Print collections that overlap with the supplied changed-path list.',
    category: 'Build & Author',
    details: `
      Usage: ai-primitives-hub collection affected [options]

      Options:
        -o, --output <format>       Output format (text, json, yaml, ndjson)
        --changed-path <path>       Changed path to check against (can be repeated)
    `
  });

  public output = Option.String('-o', '--output') as OutputFormat | undefined;
  public changedPath = Option.Array('--changed-path');
  public commandContext!: { ctx: Context };

  public execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const fmt = (this.output ?? 'text');
    const cwd = ctx.cwd();
    const changed = new Set((this.changedPath ?? []).map((p) => normalize(p)).filter(Boolean));
    const overlaps = (file: string): boolean => {
      if (changed.has(file)) {
        return true;
      }
      // Git reports a submodule update as the gitlink path, not its child files.
      for (let slash = file.lastIndexOf('/'); slash > 0; slash = file.lastIndexOf('/', slash - 1)) {
        if (changed.has(file.slice(0, slash))) {
          return true;
        }
      }
      return false;
    };

    const collectionFiles = listCollectionFiles(cwd);
    const affected: AffectedRecord[] = [];
    for (const file of collectionFiles) {
      const collection = readCollection(cwd, file);
      const itemPaths = resolveCollectionItemPaths(cwd, collection).map((p) => normalize(p));
      const readmePath = resolveCollectionReadmePath(collection);
      if (overlaps(normalize(file)) || (readmePath && overlaps(normalize(readmePath))) || itemPaths.some((p) => overlaps(p))) {
        affected.push({ id: collection.id, file });
      }
    }

    formatOutput({
      ctx,
      command: 'collection.affected',
      output: fmt,
      status: 'ok',
      data: { affected },
      textRenderer: renderText
    });
    return Promise.resolve(0);
  }
}
