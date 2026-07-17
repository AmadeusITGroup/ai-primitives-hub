/**
 * `index shortlist` — manage shortlists in a primitive index.
 * Subcommands: `new | add | remove | list`.
 *
 * Each call loads the index, mutates it, and writes it back atomically
 * (`saveIndex` creates parent dirs).
 * @module commands/index-shortlist
 */
import type {
  Shortlist,
} from '@ai-primitives-hub/infra';
import {
  defaultIndexFile,
  loadIndex,
  saveIndex,
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
  return new RegistryError({
    code: 'INDEX.LOAD_FAILED',
    message: `index shortlist: ${msg}`,
    cause: cause instanceof Error ? cause : undefined
  });
};

const renderShortlistList = (shortlists: Shortlist[]): string =>
  shortlists.length === 0
    ? 'No shortlists.\n'
    : shortlists.map((sl) =>
      `${sl.id}\t${sl.name}\t${String(sl.primitiveIds.length)} items\n`
    ).join('');

/**
 * Index shortlist new command class.
 * Creates a new shortlist.
 */
export class IndexShortlistNewCommand extends Command {
  public static readonly paths = [['index', 'shortlist', 'new']];

  public static readonly usage = Command.Usage({
    description: 'Create a new shortlist.',
    category: 'Index & Search',
    details: `
      Usage: ai-primitives-hub index shortlist new --name <NAME> [options]

      Examples:
        ai-primitives-hub index shortlist new --name "My Selection"
        ai-primitives-hub index shortlist new --name "My Selection" --description "Custom selection"
    `
  });

  public name = Option.String('--name');
  public description = Option.String('--description');
  public index = Option.String('--index');
  public output = Option.String('-o,--output');
  public commandContext!: { ctx: Context };

  public execute(): Promise<number> {
    const { ctx } = this.commandContext;

    const fmt = (this.output ?? 'text') as OutputFormat;
    const indexPath = this.index ?? defaultIndexFile(ctx.env);

    try {
      const idx = loadIndex(indexPath);
      if (!this.name || this.name.length === 0) {
        return Promise.resolve(failWith(ctx, fmt, 'index.shortlist', new RegistryError({
          code: 'USAGE.MISSING_FLAG',
          message: 'index shortlist new: --name <NAME> is required'
        })));
      }
      const sl = idx.createShortlist(this.name, this.description);
      saveIndex(idx, indexPath);
      formatOutput({
        ctx, command: 'index.shortlist', output: fmt, status: 'ok',
        data: { shortlist: sl },
        textRenderer: (d) => `Created shortlist "${d.shortlist.id}" (${d.shortlist.name}).\n`
      });
      return Promise.resolve(0);
    } catch (cause) {
      return Promise.resolve(failWith(ctx, fmt, 'index.shortlist', classifyError(cause, indexPath)));
    }
  }
}

/**
 * Index shortlist add command class.
 * Adds a primitive to a shortlist.
 */
export class IndexShortlistAddCommand extends Command {
  public static readonly paths = [['index', 'shortlist', 'add']];

  public static readonly usage = Command.Usage({
    description: 'Add a primitive to a shortlist.',
    category: 'Index & Search',
    details: `
      Usage: ai-primitives-hub index shortlist add --id <SHORTLIST_ID> --primitive <PRIMITIVE_ID> [options]

      Examples:
        ai-primitives-hub index shortlist add --id my-list --primitive primitive-id
    `
  });

  public id = Option.String('--id');
  public primitive = Option.String('--primitive');
  public index = Option.String('--index');
  public output = Option.String('-o,--output');
  public commandContext!: { ctx: Context };

  public execute(): Promise<number> {
    const { ctx } = this.commandContext;

    const fmt = (this.output ?? 'text') as OutputFormat;
    const indexPath = this.index ?? defaultIndexFile(ctx.env);

    try {
      const idx = loadIndex(indexPath);
      const id = this.id ?? '';
      const pid = this.primitive ?? '';
      if (id.length === 0 || pid.length === 0) {
        return Promise.resolve(failWith(ctx, fmt, 'index.shortlist', new RegistryError({
          code: 'USAGE.MISSING_FLAG',
          message: 'index shortlist add: --id <SHORTLIST_ID> and --primitive <PRIMITIVE_ID> are required'
        })));
      }
      let sl: Shortlist;
      try {
        sl = idx.addToShortlist(id, pid);
      } catch (cause) {
        return Promise.resolve(failWith(ctx, fmt, 'index.shortlist', new RegistryError({
          code: 'INDEX.SHORTLIST_NOT_FOUND',
          message: `index shortlist add: ${(cause as Error).message}`,
          cause: cause instanceof Error ? cause : undefined
        })));
      }
      saveIndex(idx, indexPath);
      formatOutput({
        ctx, command: 'index.shortlist', output: fmt, status: 'ok',
        data: { shortlist: sl },
        textRenderer: (d) => `Added ${pid} to shortlist ${d.shortlist.id}.\n`
      });
      return Promise.resolve(0);
    } catch (cause) {
      return Promise.resolve(failWith(ctx, fmt, 'index.shortlist', classifyError(cause, indexPath)));
    }
  }
}

/**
 * Index shortlist remove command class.
 * Removes a primitive from a shortlist.
 */
export class IndexShortlistRemoveCommand extends Command {
  public static readonly paths = [['index', 'shortlist', 'remove']];

  public static readonly usage = Command.Usage({
    description: 'Remove a primitive from a shortlist.',
    category: 'Index & Search',
    details: `
      Usage: ai-primitives-hub index shortlist remove --id <SHORTLIST_ID> --primitive <PRIMITIVE_ID> [options]

      Examples:
        ai-primitives-hub index shortlist remove --id my-list --primitive primitive-id
    `
  });

  public id = Option.String('--id');
  public primitive = Option.String('--primitive');
  public index = Option.String('--index');
  public output = Option.String('-o,--output');
  public commandContext!: { ctx: Context };

  public execute(): Promise<number> {
    const { ctx } = this.commandContext;

    const fmt = (this.output ?? 'text') as OutputFormat;
    const indexPath = this.index ?? defaultIndexFile(ctx.env);

    try {
      const idx = loadIndex(indexPath);
      const id = this.id ?? '';
      const pid = this.primitive ?? '';
      if (id.length === 0 || pid.length === 0) {
        return Promise.resolve(failWith(ctx, fmt, 'index.shortlist', new RegistryError({
          code: 'USAGE.MISSING_FLAG',
          message: 'index shortlist remove: --id and --primitive are required'
        })));
      }
      let sl: Shortlist;
      try {
        sl = idx.removeFromShortlist(id, pid);
      } catch (cause) {
        return Promise.resolve(failWith(ctx, fmt, 'index.shortlist', new RegistryError({
          code: 'INDEX.SHORTLIST_NOT_FOUND',
          message: `index shortlist remove: ${(cause as Error).message}`,
          cause: cause instanceof Error ? cause : undefined
        })));
      }
      saveIndex(idx, indexPath);
      formatOutput({
        ctx, command: 'index.shortlist', output: fmt, status: 'ok',
        data: { shortlist: sl },
        textRenderer: (d) => `Removed ${pid} from shortlist ${d.shortlist.id}.\n`
      });
      return Promise.resolve(0);
    } catch (cause) {
      return Promise.resolve(failWith(ctx, fmt, 'index.shortlist', classifyError(cause, indexPath)));
    }
  }
}

/**
 * Index shortlist list command class.
 * Lists all shortlists.
 */
export class IndexShortlistListCommand extends Command {
  public static readonly paths = [['index', 'shortlist', 'list']];

  public static readonly usage = Command.Usage({
    description: 'List all shortlists.',
    category: 'Index & Search',
    details: `
      Usage: ai-primitives-hub index shortlist list [options]

      Examples:
        ai-primitives-hub index shortlist list
    `
  });

  public index = Option.String('--index');
  public output = Option.String('-o,--output');
  public commandContext!: { ctx: Context };

  public execute(): Promise<number> {
    const { ctx } = this.commandContext;

    const fmt = (this.output ?? 'text') as OutputFormat;
    const indexPath = this.index ?? defaultIndexFile(ctx.env);

    try {
      const idx = loadIndex(indexPath);
      const shortlists = idx.listShortlists();
      formatOutput({
        ctx, command: 'index.shortlist', output: fmt, status: 'ok',
        data: { shortlists },
        textRenderer: (d) => renderShortlistList(d.shortlists)
      });
      return Promise.resolve(0);
    } catch (cause) {
      return Promise.resolve(failWith(ctx, fmt, 'index.shortlist', classifyError(cause, indexPath)));
    }
  }
}
