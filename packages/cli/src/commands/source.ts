/**
 * `source` commands (default-local-hub UX).
 *
 * Subcommands:
 *   source add --type {github|local} --url <ref> [--id <id>] [--name <n>]
 *                                                     [--enabled true|false]
 *   source list [--hub <id>]
 *   source remove <sourceId>
 *
 * Converted to clipanion class-based commands with property initializers.
 */

import {
  generateSourceId,
} from '@prompt-registry/core';
import type {
  HttpClient,
} from '@prompt-registry/core';
import type {
  TokenProvider,
} from '@prompt-registry/infra';
import {
  Command,
  createHubManager,
  Option,
} from '../framework';
import {
  type Context,
  formatOutput,
  type OutputFormat,
  RegistryError,
  renderError,
} from '../framework';

/**
 * Context passed to source command execute methods.
 */
interface SourceCommandContext {
  ctx: Context;
  http?: HttpClient;
  tokens?: TokenProvider;
}

/**
 * Base class for source commands with shared context.
 */
abstract class BaseSourceCommand extends Command {
  /**
   * Get the CLI context. This needs to be set by the CLI entry point.
   */
  public commandContext!: SourceCommandContext;

  public output = Option.String('-o,--output');
}

/**
 * source add - add a detached source to the default-local hub
 */
export class SourceAddCommand extends BaseSourceCommand {
  public static readonly paths = [['source', 'add']];
  public static readonly usage = Command.Usage({
    description: 'Add a detached source to the default-local hub.',
    category: 'Hub & Discovery',
    details: `
      Usage: prompt-registry source add --url <ref> [--type <type>] [--id <id>] [--name <name>]

      Options:
        --type <type>   Source type: github (default) or local.
        --url <ref>     GitHub owner/repo or local path.
        --id <id>       Source ID (defaults to generated ID).
        --name <name>   Display name (defaults to ID).
        --enabled       Enable the source (default true).

      Examples:
        $ prompt-registry source add --url amadeus/copilot-skills
        $ prompt-registry source add --type local --url ./skills --id local-skills
    `
  });

  public sourceType = Option.String('--type');
  public url = Option.String('--url');
  public sourceId = Option.String('--id');
  public name = Option.String('--name');
  public enabled = Option.Boolean('--enabled');

  public async execute() {
    const { ctx, http, tokens } = this.commandContext;
    const fmt = (this.output ?? 'text') as OutputFormat;
    const mgr = createHubManager({ ctx, http, tokens });

    if (!this.url) {
      return renderError(new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'source add: --url <owner/repo|path> is required'
      }), ctx);
    }

    const type = (this.sourceType ?? 'github') as 'github' | 'local';
    const id = this.sourceId ?? generateSourceId(type, this.url);
    const added = await mgr.addDetachedSource({
      id, name: this.name ?? id, type, url: this.url,
      enabled: this.enabled ?? true, priority: 0
    });
    formatOutput({
      ctx, command: 'source.add', output: fmt, status: 'ok',
      data: { source: added },
      textRenderer: (d) => `Added source "${d.source.id}" (${d.source.type}: ${d.source.url}) to default-local hub.\n`
    });
    return 0;
  }
}

/**
 * source list - list sources across all hubs or a specific hub
 */
export class SourceListCommand extends BaseSourceCommand {
  public static readonly paths = [['source', 'list']];
  public static readonly usage = Command.Usage({
    description: 'List sources across all hubs or a specific hub.',
    category: 'Hub & Discovery',
    details: `
      Usage: prompt-registry source list [--hub <hub-id>]

      Examples:
        $ prompt-registry source list
        $ prompt-registry source list --hub my-hub
    `
  });

  public hubId = Option.String('--hub');

  public async execute() {
    const { ctx, http, tokens } = this.commandContext;
    const fmt = (this.output ?? 'text') as OutputFormat;
    const mgr = createHubManager({ ctx, http, tokens });

    try {
      const sources = (this.hubId && this.hubId.length > 0)
        ? await mgr.listSources(this.hubId)
        : await mgr.listSourcesAcrossAllHubs();

      formatOutput({
        ctx, command: 'source.list', output: fmt, status: 'ok',
        data: { sources },
        textRenderer: (d) => d.sources.length === 0
          ? 'No sources.\n'
          : d.sources.map((s) => `${String(s.id)}  [${String(s.hubId)}]  ${String(s.type)}: ${String(s.url)}\n`).join('')
      });
      return 0;
    } catch (err) {
      ctx.stderr.write(`Error in source list: ${err instanceof Error ? err.message : String(err)}\n`);
      if (err instanceof Error) {
        ctx.stderr.write(`${err.stack}\n`);
      }
      return 1;
    }
  }
}

/**
 * source remove - remove a detached source from the default-local hub
 */
export class SourceRemoveCommand extends BaseSourceCommand {
  public static readonly paths = [['source', 'remove']];
  public static readonly usage = Command.Usage({
    description: 'Remove a detached source from the default-local hub.',
    category: 'Hub & Discovery',
    details: `
      Usage: prompt-registry source remove <source-id>

      Examples:
        $ prompt-registry source remove local-skills
    `
  });

  public sourceId = Option.String();

  public async execute() {
    const { ctx, http, tokens } = this.commandContext;
    const fmt = (this.output ?? 'text') as OutputFormat;
    const mgr = createHubManager({ ctx, http, tokens });

    if (!this.sourceId) {
      return renderError(new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'source remove: <sourceId> required'
      }), ctx);
    }

    const removed = await mgr.removeDetachedSource(this.sourceId);
    if (!removed) {
      return renderError(new RegistryError({
        code: 'BUNDLE.NOT_FOUND',
        message: `source remove: "${this.sourceId}" not in default-local hub`
      }), ctx);
    }
    formatOutput({
      ctx, command: 'source.remove', output: fmt, status: 'ok',
      data: { id: this.sourceId },
      textRenderer: (d) => `Removed source "${d.id}".\n`
    });
    return 0;
  }
}
