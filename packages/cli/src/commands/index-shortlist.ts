/**
 * `prompt-registry index shortlist` — manage shortlists in a primitive
 * index. Subcommands: `new | add | remove | list`.
 *
 * Replaces the legacy `primitive-index shortlist <sub>` verbs with a
 * single framework command. Each call loads the index, mutates it,
 * and writes it back atomically (saveIndex creates parent dirs).
 * @module cli/commands/index-shortlist
 */
import type {
  PrimitiveIndex,
  Shortlist,
} from '@prompt-registry/infra';
import {
  defaultIndexFile,
  loadIndex,
  saveIndex,
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

export type IndexShortlistSubcommand = 'new' | 'add' | 'remove' | 'list';

export interface IndexShortlistOptions {
  subcommand: IndexShortlistSubcommand;
  output?: OutputFormat;
  /** Path to the index JSON. */
  indexFile?: string;
  /** new: human label. */
  name?: string;
  /** new: optional description. */
  description?: string;
  /** add/remove: shortlist id. */
  shortlistId?: string;
  /** add/remove: primitive id. */
  primitiveId?: string;
}

/**
 * Build the `index shortlist` command. Dispatches to the chosen
 * subcommand.
 * @param opts CLI options.
 * @returns CommandDefinition.
 */
export const createIndexShortlistCommand = (
  opts: IndexShortlistOptions
): CommandDefinition =>
  defineCommand({
    path: ['index', 'shortlist', opts.subcommand],
    description: `Manage primitive-index shortlists: ${opts.subcommand}.`,
    category: 'Index & Search',
    run: ({ ctx }: { ctx: Context }): number | Promise<number> => {
      const fmt = opts.output ?? 'text';
      const indexPath = opts.indexFile ?? defaultIndexFile(ctx.env);
      try {
        const idx = loadIndex(indexPath);
        switch (opts.subcommand) {
          case 'new': { return runNew(ctx, fmt, idx, indexPath, opts);
          }
          case 'add': { return runAdd(ctx, fmt, idx, indexPath, opts);
          }
          case 'remove': { return runRemove(ctx, fmt, idx, indexPath, opts);
          }
          case 'list': { return Promise.resolve(runList(ctx, fmt, idx));
          }
        }
      } catch (cause) {
        return failWith(ctx, fmt, 'index.shortlist', classifyError(cause, indexPath));
      }
    }
  });

const runNew = async (
  ctx: Context,
  fmt: OutputFormat,
  idx: PrimitiveIndex,
  indexPath: string,
  opts: IndexShortlistOptions
): Promise<number> => {
  if (opts.name === undefined || opts.name.length === 0) {
    return failWith(ctx, fmt, 'index.shortlist', new RegistryError({
      code: 'USAGE.MISSING_FLAG',
      message: 'index shortlist new: --name <NAME> is required'
    }));
  }
  const sl = idx.createShortlist(opts.name, opts.description);
  saveIndex(idx, indexPath);
  formatOutput({
    ctx, command: 'index.shortlist', output: fmt, status: 'ok',
    data: { shortlist: sl },
    textRenderer: (d) => `Created shortlist "${d.shortlist.id}" (${d.shortlist.name}).\n`
  });
  return 0;
};

const runAdd = async (
  ctx: Context,
  fmt: OutputFormat,
  idx: PrimitiveIndex,
  indexPath: string,
  opts: IndexShortlistOptions
): Promise<number> => {
  const id = opts.shortlistId ?? '';
  const pid = opts.primitiveId ?? '';
  if (id.length === 0 || pid.length === 0) {
    return failWith(ctx, fmt, 'index.shortlist', new RegistryError({
      code: 'USAGE.MISSING_FLAG',
      message: 'index shortlist add: --id <SHORTLIST_ID> and --primitive <PRIMITIVE_ID> are required'
    }));
  }
  let sl: Shortlist;
  try {
    sl = idx.addToShortlist(id, pid);
  } catch (cause) {
    return failWith(ctx, fmt, 'index.shortlist', new RegistryError({
      code: 'INDEX.SHORTLIST_NOT_FOUND',
      message: `index shortlist add: ${(cause as Error).message}`,
      cause: cause instanceof Error ? cause : undefined
    }));
  }
  saveIndex(idx, indexPath);
  formatOutput({
    ctx, command: 'index.shortlist', output: fmt, status: 'ok',
    data: { shortlist: sl },
    textRenderer: (d) => `Added ${pid} to shortlist ${d.shortlist.id}.\n`
  });
  return 0;
};

const runRemove = async (
  ctx: Context,
  fmt: OutputFormat,
  idx: PrimitiveIndex,
  indexPath: string,
  opts: IndexShortlistOptions
): Promise<number> => {
  const id = opts.shortlistId ?? '';
  const pid = opts.primitiveId ?? '';
  if (id.length === 0 || pid.length === 0) {
    return failWith(ctx, fmt, 'index.shortlist', new RegistryError({
      code: 'USAGE.MISSING_FLAG',
      message: 'index shortlist remove: --id and --primitive are required'
    }));
  }
  let sl: Shortlist;
  try {
    sl = idx.removeFromShortlist(id, pid);
  } catch (cause) {
    return failWith(ctx, fmt, 'index.shortlist', new RegistryError({
      code: 'INDEX.SHORTLIST_NOT_FOUND',
      message: `index shortlist remove: ${(cause as Error).message}`,
      cause: cause instanceof Error ? cause : undefined
    }));
  }
  saveIndex(idx, indexPath);
  formatOutput({
    ctx, command: 'index.shortlist', output: fmt, status: 'ok',
    data: { shortlist: sl },
    textRenderer: (d) => `Removed ${pid} from shortlist ${d.shortlist.id}.\n`
  });
  return 0;
};

const runList = (
  ctx: Context,
  fmt: OutputFormat,
  idx: PrimitiveIndex
): number => {
  const shortlists = idx.listShortlists();
  formatOutput({
    ctx, command: 'index.shortlist', output: fmt, status: 'ok',
    data: { shortlists },
    textRenderer: (d) => d.shortlists.length === 0
      ? 'No shortlists.\n'
      : d.shortlists.map((sl: Shortlist) =>
        `${sl.id}\t${sl.name}\t${String(sl.primitiveIds.length)} items\n`
      ).join('')
  });
  return 0;
};

const classifyError = (cause: unknown, indexPath: string): RegistryError => {
  if (cause instanceof RegistryError) {
    return cause;
  }
  const msg = cause instanceof Error ? cause.message : String(cause);
  if (/ENOENT|no such file/i.test(msg)) {
    return new RegistryError({
      code: 'INDEX.NOT_FOUND',
      message: `index not found: ${indexPath}`,
      hint: 'Run `prompt-registry index build` or `prompt-registry index harvest` first.',
      cause: cause instanceof Error ? cause : undefined
    });
  }
  return new RegistryError({
    code: 'INDEX.LOAD_FAILED',
    message: `index shortlist: ${msg}`,
    cause: cause instanceof Error ? cause : undefined
  });
};

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
      Usage: prompt-registry index shortlist new --name <NAME> [options]

      Examples:
        prompt-registry index shortlist new --name "My Selection"
        prompt-registry index shortlist new --name "My Selection" --description "Custom selection"
    `
  });

  public name = Option.String('--name');
  public description = Option.String('--description');
  public index = Option.String('--index');
  public output = Option.String('-o,--output');

  public async execute(): Promise<number> {
    const ctx = getCommandContext(this);

    const fmt = (this.output ?? 'text') as OutputFormat;
    const indexPath = this.index ?? defaultIndexFile(ctx.env);

    try {
      const idx = loadIndex(indexPath);
      if (!this.name || this.name.length === 0) {
        return failWith(ctx, fmt, 'index.shortlist', new RegistryError({
          code: 'USAGE.MISSING_FLAG',
          message: 'index shortlist new: --name <NAME> is required'
        }));
      }
      const sl = idx.createShortlist(this.name, this.description);
      saveIndex(idx, indexPath);
      formatOutput({
        ctx, command: 'index.shortlist', output: fmt, status: 'ok',
        data: { shortlist: sl },
        textRenderer: (d) => `Created shortlist "${d.shortlist.id}" (${d.shortlist.name}).\n`
      });
      return 0;
    } catch (cause) {
      return failWith(ctx, fmt, 'index.shortlist', classifyError(cause, indexPath));
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
      Usage: prompt-registry index shortlist add --id <SHORTLIST_ID> --primitive <PRIMITIVE_ID> [options]

      Examples:
        prompt-registry index shortlist add --id my-list --primitive primitive-id
    `
  });

  public id = Option.String('--id');
  public primitive = Option.String('--primitive');
  public index = Option.String('--index');
  public output = Option.String('-o,--output');

  public async execute(): Promise<number> {
    const ctx = getCommandContext(this);

    const fmt = (this.output ?? 'text') as OutputFormat;
    const indexPath = this.index ?? defaultIndexFile(ctx.env);

    try {
      const idx = loadIndex(indexPath);
      const id = this.id ?? '';
      const pid = this.primitive ?? '';
      if (id.length === 0 || pid.length === 0) {
        return failWith(ctx, fmt, 'index.shortlist', new RegistryError({
          code: 'USAGE.MISSING_FLAG',
          message: 'index shortlist add: --id <SHORTLIST_ID> and --primitive <PRIMITIVE_ID> are required'
        }));
      }
      let sl: Shortlist;
      try {
        sl = idx.addToShortlist(id, pid);
      } catch (cause) {
        return failWith(ctx, fmt, 'index.shortlist', new RegistryError({
          code: 'INDEX.SHORTLIST_NOT_FOUND',
          message: `index shortlist add: ${(cause as Error).message}`,
          cause: cause instanceof Error ? cause : undefined
        }));
      }
      saveIndex(idx, indexPath);
      formatOutput({
        ctx, command: 'index.shortlist', output: fmt, status: 'ok',
        data: { shortlist: sl },
        textRenderer: (d) => `Added ${pid} to shortlist ${d.shortlist.id}.\n`
      });
      return 0;
    } catch (cause) {
      return failWith(ctx, fmt, 'index.shortlist', classifyError(cause, indexPath));
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
      Usage: prompt-registry index shortlist remove --id <SHORTLIST_ID> --primitive <PRIMITIVE_ID> [options]

      Examples:
        prompt-registry index shortlist remove --id my-list --primitive primitive-id
    `
  });

  public id = Option.String('--id');
  public primitive = Option.String('--primitive');
  public index = Option.String('--index');
  public output = Option.String('-o,--output');

  public async execute(): Promise<number> {
    const ctx = getCommandContext(this);

    const fmt = (this.output ?? 'text') as OutputFormat;
    const indexPath = this.index ?? defaultIndexFile(ctx.env);

    try {
      const idx = loadIndex(indexPath);
      const id = this.id ?? '';
      const pid = this.primitive ?? '';
      if (id.length === 0 || pid.length === 0) {
        return failWith(ctx, fmt, 'index.shortlist', new RegistryError({
          code: 'USAGE.MISSING_FLAG',
          message: 'index shortlist remove: --id and --primitive are required'
        }));
      }
      let sl: Shortlist;
      try {
        sl = idx.removeFromShortlist(id, pid);
      } catch (cause) {
        return failWith(ctx, fmt, 'index.shortlist', new RegistryError({
          code: 'INDEX.SHORTLIST_NOT_FOUND',
          message: `index shortlist remove: ${(cause as Error).message}`,
          cause: cause instanceof Error ? cause : undefined
        }));
      }
      saveIndex(idx, indexPath);
      formatOutput({
        ctx, command: 'index.shortlist', output: fmt, status: 'ok',
        data: { shortlist: sl },
        textRenderer: (d) => `Removed ${pid} from shortlist ${d.shortlist.id}.\n`
      });
      return 0;
    } catch (cause) {
      return failWith(ctx, fmt, 'index.shortlist', classifyError(cause, indexPath));
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
      Usage: prompt-registry index shortlist list [options]

      Examples:
        prompt-registry index shortlist list
    `
  });

  public index = Option.String('--index');
  public output = Option.String('-o,--output');

  public async execute(): Promise<number> {
    const ctx = getCommandContext(this);

    const fmt = (this.output ?? 'text') as OutputFormat;
    const indexPath = this.index ?? defaultIndexFile(ctx.env);

    try {
      const idx = loadIndex(indexPath);
      const shortlists = idx.listShortlists();
      formatOutput({
        ctx, command: 'index.shortlist', output: fmt, status: 'ok',
        data: { shortlists },
        textRenderer: (d) => d.shortlists.length === 0
          ? 'No shortlists.\n'
          : d.shortlists.map((sl: Shortlist) =>
            `${sl.id}\t${sl.name}\t${String(sl.primitiveIds.length)} items\n`
          ).join('')
      });
      return 0;
    } catch (cause) {
      return failWith(ctx, fmt, 'index.shortlist', classifyError(cause, indexPath));
    }
  }
}
