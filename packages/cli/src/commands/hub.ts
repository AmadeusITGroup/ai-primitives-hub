/**
 * `hub` commands.
 *
 * Subcommands:
 *   hub add <ref>         import a hub from a reference
 *   hub list              list saved hubs
 *   hub use [<id>|--clear]  set/clear the active hub
 *   hub remove <id>       remove a hub
 *   hub sync [<id>]       re-fetch a hub config (default: active)
 *
 * Converted to clipanion class-based commands with property initializers.
 */
import * as path from 'node:path';
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
 * Context passed to hub command execute methods.
 */
interface HubCommandContext {
  ctx: Context;
  http?: HttpClient;
  tokens?: TokenProvider;
}

/**
 * Base class for hub commands with shared context.
 */
abstract class BaseHubCommand extends Command {
  /**
   * Get the CLI context. This needs to be set by the CLI entry point.
   */
  public commandContext!: HubCommandContext;

  public output = Option.String('-o,--output');
}

/**
 * hub list - list saved hubs
 */
export class HubListCommand extends BaseHubCommand {
  public static readonly paths = [['hub', 'list']];
  public static readonly usage = Command.Usage({
    description: 'List imported hubs and optionally check reachability.',
    category: 'Hub & Discovery',
    details: `
      Usage: prompt-registry hub list [options]

      Options:
        --check                 Probe reachability of each hub source
        -o, --output <format>  Output format (text, json, yaml, ndjson)

      Examples:
        prompt-registry hub list
        prompt-registry hub list --check
    `
  });

  public check = Option.Boolean('--check');

  public async execute() {
    const { ctx, http, tokens } = this.commandContext;
    const fmt = (this.output ?? 'text') as OutputFormat;
    const mgr = createHubManager({ ctx, http, tokens });
    const hubs = await mgr.listHubs();
    const active = await mgr.getActiveHub();

    let reachability: Record<string, { status: 'ok' | 'error'; reason?: string }> | undefined;
    if (this.check) {
      reachability = {};
      const results = await Promise.all(hubs.map(async (h) => [h.id, await mgr.checkHub(h.id)] as const));
      for (const [id, r] of results) {
        reachability[id] = r;
      }
    }

    const enriched = reachability === undefined
      ? hubs
      : hubs.map((h) => ({ ...h, check: reachability[h.id] }));

    formatOutput({
      ctx, command: 'hub.list', output: fmt, status: 'ok',
      data: { hubs: enriched, activeId: active?.id ?? null },
      textRenderer: (d) => d.hubs.length === 0
        ? 'No hubs imported. Run `prompt-registry hub add <ref>` to import one.\n'
        : d.hubs.map((h: { id: string; name: string; check?: { status: string; reason?: string } }) => {
          const marker = h.id === d.activeId ? '*' : ' ';
          let probe: string;
          if (h.check === undefined) {
            probe = '';
          } else if (h.check.status === 'ok') {
            probe = '  [reachable]';
          } else {
            probe = `  [unreachable: ${h.check.reason ?? '?'}]`;
          }
          return `${marker} ${h.id}  ${h.name}${probe}\n`;
        }).join('')
    });
    return 0;
  }
}

/**
 * hub add - import a hub from a reference
 */
export class HubAddCommand extends BaseHubCommand {
  public static readonly paths = [['hub', 'add']];
  public static readonly usage = Command.Usage({
    description: 'Import a hub from a reference (GitHub repo, local path, or URL).',
    category: 'Hub & Discovery',
    details: `
      Usage: prompt-registry hub add --location <ref> [options]

      Options:
        --type <type>            Reference type: github (default), local, url
        --location <ref>         GitHub owner/repo, local path, or URL
        --ref <branch>           Git branch, tag, or commit (GitHub only)
        --id <id>                Custom hub ID (defaults to repo name)
        --no-sync                Skip syncing after import
        --no-use                 Skip setting as active hub
        -o, --output <format>     Output format (text, json, yaml, ndjson)

      Examples:
        prompt-registry hub add --location amadeus/copilot-hub
        prompt-registry hub add --type local --location ./my-hub --id local-hub
    `
  });

  public refType = Option.String('--type');
  public refLocation = Option.String('--location');
  public refRef = Option.String('--ref');
  public hubId = Option.String('--id');
  public noSync = Option.Boolean('--no-sync');
  public noUse = Option.Boolean('--no-use');

  public async execute() {
    const { ctx, http, tokens } = this.commandContext;
    const fmt = (this.output ?? 'text') as OutputFormat;
    const mgr = createHubManager({ ctx, http, tokens });

    if (!this.refLocation) {
      renderError(new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'hub add: --location <ref> is required',
        hint: 'Examples: hub add --type github --location owner/repo --ref main'
      }), ctx);
      return 1;
    }

    const refType = (this.refType ?? 'github') as 'github' | 'local' | 'url';
    let location = this.refLocation;
    if (refType === 'local' && !path.isAbsolute(location)) {
      location = path.resolve(ctx.cwd(), location);
    }

    const id = await mgr.importHub({
      type: refType,
      location,
      ref: this.refRef
    }, this.hubId);

    // F-05: auto-use and auto-sync after import (unless flags disable)
    if (!this.noUse) {
      await mgr.useHub(id);
    }

    if (!this.noSync) {
      await mgr.syncHub(id);
    }

    formatOutput({
      ctx, command: 'hub.add', output: fmt, status: 'ok',
      data: { id, location, type: refType, used: !this.noUse, synced: !this.noSync },
      textRenderer: (d) => {
        const actions: string[] = [`Imported hub "${d.id}" from ${d.type}:${d.location}`];
        if (d.used) {
          actions.push('marked as active');
        }
        if (d.synced) {
          actions.push('synced');
        }
        const suffix = d.used ? '' : `\nRun \`prompt-registry hub use ${d.id}\` to activate it.`;
        return `${actions.join(', ')}.${suffix}\n`;
      }
    });
    return 0;
  }
}

/**
 * hub use - set/clear the active hub
 */
export class HubUseCommand extends BaseHubCommand {
  public static readonly paths = [['hub', 'use']];
  public static readonly usage = Command.Usage({
    description: 'Set or clear the active hub.',
    category: 'Hub & Discovery',
    details: `
      Usage: prompt-registry hub use <hub-id>
      Usage: prompt-registry hub use --clear

      Options:
        --clear                  Clear the active hub
        -o, --output <format>     Output format (text, json, yaml, ndjson)

      Examples:
        prompt-registry hub use amadeus-copilot-hub
        prompt-registry hub use --clear
    `
  });

  public clear = Option.Boolean('--clear');
  public hubId = Option.String({ required: false });

  public async execute() {
    const { ctx, http, tokens } = this.commandContext;
    const fmt = (this.output ?? 'text') as OutputFormat;
    const mgr = createHubManager({ ctx, http, tokens });

    if (this.clear) {
      await mgr.useHub(null);
      formatOutput({
        ctx, command: 'hub.use', output: fmt, status: 'ok',
        data: { activeId: null },
        textRenderer: () => 'Active hub cleared.\n'
      });
      return 0;
    }

    if (!this.hubId) {
      renderError(new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'hub use: provide a hub id or --clear',
        hint: 'Run `prompt-registry hub list` to see available hubs.'
      }), ctx);
      return 1;
    }

    await mgr.useHub(this.hubId);
    formatOutput({
      ctx, command: 'hub.use', output: fmt, status: 'ok',
      data: { activeId: this.hubId },
      textRenderer: (d) => `Active hub: ${d.activeId}.\n`
    });
    return 0;
  }
}

/**
 * hub remove - remove a hub
 */
export class HubRemoveCommand extends BaseHubCommand {
  public static readonly paths = [['hub', 'remove']];
  public static readonly usage = Command.Usage({
    description: 'Remove an imported hub.',
    category: 'Hub & Discovery',
    details: `
      Usage: prompt-registry hub remove <hub-id>

      Options:
        -o, --output <format>  Output format (text, json, yaml, ndjson)

      Examples:
        prompt-registry hub remove old-hub
    `
  });

  public hubId = Option.String({ required: false });

  public async execute() {
    const { ctx, http, tokens } = this.commandContext;
    const fmt = (this.output ?? 'text') as OutputFormat;
    const mgr = createHubManager({ ctx, http, tokens });

    if (!this.hubId) {
      renderError(new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'hub remove: <hubId> is required',
        hint: 'Run `prompt-registry hub list` to see available hub IDs.'
      }), ctx);
      return 1;
    }

    await mgr.removeHub(this.hubId);
    formatOutput({
      ctx, command: 'hub.remove', output: fmt, status: 'ok',
      data: { id: this.hubId },
      textRenderer: (d) => `Removed hub "${d.id}".\n`
    });
    return 0;
  }
}

/**
 * hub create - scaffold a hub-config.yml skeleton
 */
export class HubCreateCommand extends BaseHubCommand {
  public static readonly paths = [['hub', 'create']];
  public static readonly usage = Command.Usage({
    description: 'Scaffold a hub-config.yml skeleton.',
    category: 'Hub & Discovery',
    details: `
      Usage: prompt-registry hub create --name <name> [--out <dir>] [--add-source <path>]

      Options:
        --name <name>        Hub display name.
        --out <dir>          Output directory (default: cwd).
        --add-source <path>  Pre-populate a local source in the config.

      Examples:
        $ prompt-registry hub create --name "My Hub"
        $ prompt-registry hub create --name "Dev Hub" --out ./hubs/dev
    `
  });

  public name = Option.String('--name');
  public out = Option.String('--out');
  public addSource = Option.String('--add-source');

  public async execute() {
    const { ctx } = this.commandContext;
    const fmt = (this.output ?? 'text') as OutputFormat;

    if (!this.name) {
      renderError(new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'hub create: --name <name> is required',
        hint: 'Example: hub create --name "My Hub" --out ./my-hub'
      }), ctx);
      return 1;
    }

    const outDir = this.out ? path.resolve(ctx.cwd(), this.out) : ctx.cwd();
    const configPath = path.join(outDir, 'hub-config.yml');
    const now = new Date().toISOString();
    const sourcesBlock = this.addSource
      ? `  - id: local-source\n    type: local\n    url: ${path.resolve(ctx.cwd(), this.addSource)}\n`
      : '  # - id: my-source\n  #   type: github\n  #   url: owner/repo\n';

    const content = [
      '# hub-config.yml — created by prompt-registry hub create',
      'version: "1.0.0"',
      'metadata:',
      `  name: "${this.name}"`,
      '  description: ""',
      '  maintainer: ""',
      `  updatedAt: "${now}"`,
      'sources:',
      sourcesBlock,
      'profiles: []'
    ].join('\n') + '\n';

    await ctx.fs.mkdir(outDir, { recursive: true });
    await ctx.fs.writeFile(configPath, content);

    formatOutput({
      ctx, command: 'hub.create', output: fmt, status: 'ok',
      data: { path: configPath, name: this.name, outDir },
      textRenderer: (d) => `Created hub config: ${d.path}\n`
        + `Edit it to add sources and profiles, then run:\n`
        + `  prompt-registry hub add --type local --location ${d.outDir}\n`
    });
    return 0;
  }
}

/**
 * hub sync - re-fetch a hub config
 */
export class HubSyncCommand extends BaseHubCommand {
  public static readonly paths = [['hub', 'sync']];
  public static readonly usage = Command.Usage({
    description: 'Re-fetch and sync a hub config.',
    category: 'Hub & Discovery',
    details: `
      Usage: prompt-registry hub sync [<hub-id>]

      Examples:
        $ prompt-registry hub sync          # sync active hub
        $ prompt-registry hub sync my-hub   # sync specific hub
    `
  });

  public hubId = Option.String({ required: false });

  public async execute() {
    const { ctx, http, tokens } = this.commandContext;
    const fmt = (this.output ?? 'text') as OutputFormat;
    const mgr = createHubManager({ ctx, http, tokens });

    let id = this.hubId;
    if (!id) {
      const active = await mgr.getActiveHub();
      if (!active) {
        renderError(new RegistryError({
          code: 'USAGE.MISSING_FLAG',
          message: 'hub sync: no <hubId> given and no active hub',
          hint: 'Run `prompt-registry hub use <id>` or pass the hub id directly.'
        }), ctx);
        return 1;
      }
      id = active.id;
    }

    await mgr.syncHub(id);
    formatOutput({
      ctx, command: 'hub.sync', output: fmt, status: 'ok',
      data: { id },
      textRenderer: (d) => `Synced hub "${d.id}".\n`
    });
    return 0;
  }
}

/**
 * hub refresh - sync the active hub (F-05 shorthand)
 */
export class HubRefreshCommand extends BaseHubCommand {
  public static readonly paths = [['hub', 'refresh']];
  public static readonly usage = Command.Usage({
    description: 'Sync the active hub (shorthand for hub sync).',
    category: 'Hub & Discovery',
    details: `
      Usage: prompt-registry hub refresh

      Examples:
        $ prompt-registry hub refresh   # same as: hub sync (active)
    `
  });

  public async execute() {
    const { ctx, http, tokens } = this.commandContext;
    const fmt = (this.output ?? 'text') as OutputFormat;
    const mgr = createHubManager({ ctx, http, tokens });

    const active = await mgr.getActiveHub();
    if (!active) {
      renderError(new RegistryError({
        code: 'HUB.NO_ACTIVE',
        message: 'hub refresh: no active hub',
        hint: 'Run `prompt-registry hub use <id>` first.'
      }), ctx);
      return 1;
    }

    await mgr.syncHub(active.id);
    formatOutput({
      ctx, command: 'hub.refresh', output: fmt, status: 'ok',
      data: { id: active.id },
      textRenderer: (d) => `Refreshed hub "${d.id}".\n`
    });
    return 0;
  }
}
