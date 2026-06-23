/**
 * `collection affected` subcommand.
 *
 * Replaces `lib/bin/detect-affected-collections.js`. Given a list of
 * changed paths (typically produced by `git diff --name-only` in a
 * CI workflow), emits the collections whose `.collection.yml` itself
 * or any item-path is in that set.
 *
 * Path normalization mirrors the legacy script: backslash-to-slash,
 * strip a leading `/`, trim. Strings that normalize to empty are
 * dropped silently.
 */
import {
  readCollection,
} from '@prompt-registry/app';
import {
  listCollectionFiles,
  resolveCollectionItemPaths,
} from '../collections';
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
} from '../framework';

/**
 * Affected collection record.
 */
interface AffectedRecord {
  id: string;
  file: string;
}

/**
 * Options for collection affected command.
 */
export interface CollectionAffectedOptions {
  /** Output format. Default 'text'. */
  output?: OutputFormat;
  /**
   * Changed paths to check against (repo-relative). Mirrors the
   * legacy `--changed-path` flag (repeatable).
   */
  changedPaths?: string[];
}

/**
 * Command context for collection affected command.
 */
interface CollectionAffectedContext {
  ctx: Context;
}

/**
 * Base class for collection affected command.
 */
abstract class BaseCollectionAffectedCommand extends Command {
  public commandContext: CollectionAffectedContext = { ctx: null as any };
}

/**
 * Native clipanion class command for collection affected.
 */
export class CollectionAffectedCommand extends BaseCollectionAffectedCommand {
  public static readonly paths = [['collection', 'affected']];

  public static readonly usage = Command.Usage({
    description: 'Print collections that overlap with the supplied changed-path list.',
    category: 'Build & Author',
    details: `
      Usage: prompt-registry collection affected [options]

      Options:
        -o, --output <format>       Output format (text, json, yaml, ndjson)
        --changed-path <path>       Changed path to check against (can be repeated)
    `
  });

  public output = Option.String('-o', '--output') as OutputFormat | undefined;
  public changedPath = Option.Array('--changed-path');

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const fmt = (this.output ?? 'text');
    const cwd = ctx.cwd();
    const changed = (this.changedPath ?? [])
      .map((p) => normalize(p))
      .filter((s) => s.length > 0);
    const changedSet = new Set(changed);

    const collectionFiles = listCollectionFiles(cwd);
    const affected: AffectedRecord[] = [];
    for (const file of collectionFiles) {
      const collection = readCollection(cwd, file);
      const itemPaths = resolveCollectionItemPaths(cwd, collection).map((p) => normalize(p));
      const itemPathsSet = new Set(itemPaths);
      const normalizedFile = normalize(file);
      if (changedSet.has(normalizedFile)) {
        affected.push({ id: collection.id, file });
        continue;
      }
      for (const c of changed) {
        if (itemPathsSet.has(c)) {
          affected.push({ id: collection.id, file });
          break;
        }
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
    return 0;
  }
}

/**
 * Create a CommandDefinition wrapper for the collection affected command class.
 * This adapts native clipanion classes to the framework's CommandDefinition pattern.
 * @param ctx CLI context.
 * @param defaultOutput Default output format (optional).
 * @param defaultChangedPaths Default changed paths (optional).
 * @returns CommandClass.
 */
const createCollectionAffectedCommandDefinition = (
  ctx: Context,
  defaultOutput?: string,
  defaultChangedPaths?: string[]
): typeof CollectionAffectedCommand => {
  class ConfiguredCommand extends CollectionAffectedCommand {
    public async execute(): Promise<number> {
      this.commandContext = { ctx };
      if (defaultOutput !== undefined && !this.output) {
        this.output = defaultOutput as OutputFormat;
      }
      if (defaultChangedPaths !== undefined && (!this.changedPath || this.changedPath.length === 0)) {
        this.changedPath = defaultChangedPaths;
      }

      return super.execute();
    }
  }
  copyCommandPrototype(CollectionAffectedCommand, ConfiguredCommand);

  return ConfiguredCommand;
};

/**
 * Factory function to create a configured collection affected command class.
 * @param ctx CLI context.
 * @param defaultOutput Default output format (optional).
 * @param defaultChangedPaths Default changed paths (optional).
 * @returns CommandClass.
 */
export const createCollectionAffectedCommandClass = (
  ctx: Context,
  defaultOutput?: string,
  defaultChangedPaths?: string[]
): typeof CollectionAffectedCommand => {
  return createCollectionAffectedCommandDefinition(ctx, defaultOutput, defaultChangedPaths);
};

/**
 * Build the `collection affected` command.
 * @param opts - Command options.
 * @returns CommandDefinition wired to the framework adapter.
 */
export const createCollectionAffectedCommand = (
  opts: CollectionAffectedOptions = {}
): CommandDefinition =>
  defineCommand({
    path: ['collection', 'affected'],
    description: 'Print collections that overlap with the supplied changed-path list.',
    category: 'Build & Author',
    run: ({ ctx }: { ctx: Context }): number => {
      const cwd = ctx.cwd();
      const changed = (opts.changedPaths ?? [])
        .map((p) => normalize(p))
        .filter((s) => s.length > 0);
      const changedSet = new Set(changed);

      const collectionFiles = listCollectionFiles(cwd);
      const affected: AffectedRecord[] = [];
      for (const file of collectionFiles) {
        const collection = readCollection(cwd, file);
        const itemPaths = resolveCollectionItemPaths(cwd, collection).map((p) => normalize(p));
        const itemPathsSet = new Set(itemPaths);
        const normalizedFile = normalize(file);
        if (changedSet.has(normalizedFile)) {
          affected.push({ id: collection.id, file });
          continue;
        }
        for (const c of changed) {
          if (itemPathsSet.has(c)) {
            affected.push({ id: collection.id, file });
            break;
          }
        }
      }

      formatOutput({
        ctx,
        command: 'collection.affected',
        output: opts.output ?? 'text',
        status: 'ok',
        data: { affected },
        textRenderer: renderText
      });
      return 0;
    }
  });

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
