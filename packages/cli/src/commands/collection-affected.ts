/**
 * `collection affected` subcommand.
 *
 * Given a list of changed paths (typically produced by `git diff
 * --name-only` in a CI workflow), emits the collections whose
 * `.collection.yml` itself or any item-path is in that set.
 *
 * Path normalization: backslash-to-slash, strip a leading `/`, trim.
 * Strings that normalize to empty are dropped silently.
 * @module commands/collection-affected
 */
import {
  type AffectedCollection,
  affectedCollections,
} from '@ai-primitives-hub/app';
import {
  Command,
  type Context,
  formatOutput,
  Option,
  type OutputFormat,
} from '../framework';

/**
 * Render affected collections as text.
 * @param d Affected data.
 * @param d.affected
 * @returns Formatted text output.
 */
const renderText = (d: { affected: AffectedCollection[] }): string => {
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
    const affected = affectedCollections(ctx.cwd(), this.changedPath ?? []);

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
