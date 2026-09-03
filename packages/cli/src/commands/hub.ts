/**
 * `hub` commands.
 *
 * Subcommands:
 *   hub add <ref>         import a hub from a reference
 *   hub list              list saved hubs
 *   hub use [<id>|--clear]  set/clear the active hub
 *   hub remove <id>       remove a hub
 *   hub sync [<id>]       re-fetch a hub config (default: active)
 *   hub create            scaffold a hub-config.yml skeleton
 *   hub validate          validate a hub-config.yml offline
 *   hub refresh           sync the active hub (shorthand)
 *
 * Our `HubManager` (`@ai-primitives-hub/app`) names two methods the
 * reference branch's manager names differently: `useHub` here is
 * `setActiveHub`, and `removeHub` here is `deleteHub`. There is also no
 * `checkHub(hubId)` convenience — `hub list --check` instead calls
 * `verifyHubAvailability(reference)` per listed hub (boolean only, no
 * failure `reason` string).
 */
import * as path from 'node:path';
import {
  validateHubConfigFile,
} from '@ai-primitives-hub/app';
import type {
  DeepHubConfigValidationResult,
  HubConfigFileValidationResult,
  HubValidationProgress,
  SourceAuthenticationContext,
} from '@ai-primitives-hub/app';
import type {
  GitHubSourceAuthCategory,
  HttpClient,
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  createGitHubSourceAuthRuntime,
  createGitHubSourceAuthSession,
  defaultTokenProvider,
  GITHUB_APP_AUTH_KEY_FILE,
  GITHUB_APP_CLIENT_ID,
  GITHUB_APP_ID,
  GITHUB_APP_INSTALLATION_ID,
  isGitHubAppAuthEnabled,
  NodeHttpClient,
  NodeProcessRunner,
  parseHubConfig,
} from '@ai-primitives-hub/infra';
import type {
  GitHubSourceAuthRuntime,
  GitHubSourceAuthSession,
  GitHubSourcePreflightReport,
} from '@ai-primitives-hub/infra';
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
      Usage: ai-primitives-hub hub list [options]

      Options:
        --check                 Probe reachability of each hub source
        -o, --output <format>  Output format (text, json, yaml, ndjson)

      Examples:
        ai-primitives-hub hub list
        ai-primitives-hub hub list --check
    `
  });

  public check = Option.Boolean('--check');

  public async execute() {
    const { ctx, http, tokens } = this.commandContext;
    const fmt = (this.output ?? 'text') as OutputFormat;
    const mgr = createHubManager({ ctx, http, tokens });
    const hubs = await mgr.listHubs();
    const active = await mgr.getActiveHub();

    let reachability: Record<string, { status: 'ok' | 'error' }> | undefined;
    if (this.check) {
      reachability = {};
      const results = await Promise.all(hubs.map(async (h) => {
        const ok = await mgr.verifyHubAvailability(h.reference);
        return [h.id, { status: ok ? 'ok' as const : 'error' as const }] as const;
      }));
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
        ? 'No hubs imported. Run `ai-primitives-hub hub add <ref>` to import one.\n'
        : d.hubs.map((h: { id: string; name: string; check?: { status: string } }) => {
          const marker = h.id === d.activeId ? '*' : ' ';
          let probe: string;
          if (h.check === undefined) {
            probe = '';
          } else if (h.check.status === 'ok') {
            probe = '  [reachable]';
          } else {
            probe = '  [unreachable]';
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
      Usage: ai-primitives-hub hub add --location <ref> [options]

      Options:
        --type <type>            Reference type: github (default), local, url, artifactory
        --location <ref>         GitHub owner/repo, local path, URL, or Artifactory hub root
                                  Example: http://127.0.0.1:8081/artifactory/<repository-key>/<hub-prefix>
                                  Use the repository API root; omit /ui/native and hub-config.yml.
        --ref <branch>           Git branch, tag, or commit (GitHub only)
        --config-file <path>     Artifactory config path (default: hub-config.yml)
        --auth <mode>            Artifactory auth: anonymous or bearer
        --credential-ref <name>  Environment variable for Artifactory Bearer auth
        --id <id>                Custom hub ID (defaults to repo name)
        --no-sync                Skip syncing after import
        --no-use                 Skip setting as active hub
        -o, --output <format>     Output format (text, json, yaml, ndjson)

      Examples:
        ai-primitives-hub hub add --location amadeus/copilot-hub
        ai-primitives-hub hub add --type local --location ./my-hub --id local-hub
    `
  });

  public refType = Option.String('--type');
  public refLocation = Option.String('--location');
  public refRef = Option.String('--ref');
  public configFile = Option.String('--config-file');
  public authMode = Option.String('--auth');
  public credentialRef = Option.String('--credential-ref');
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

    const refType = (this.refType ?? 'github') as 'github' | 'local' | 'url' | 'artifactory';
    if (!['github', 'local', 'url', 'artifactory'].includes(refType)) {
      renderError(new RegistryError({ code: 'USAGE.INVALID_FLAG', message: `hub add: unsupported type '${refType}'` }), ctx);
      return 1;
    }
    if (refType !== 'artifactory' && (this.configFile || this.authMode || this.credentialRef)) {
      renderError(new RegistryError({ code: 'USAGE.INVALID_FLAG', message: 'Artifactory options require --type artifactory' }), ctx);
      return 1;
    }
    if (this.authMode !== undefined && this.authMode !== 'anonymous' && this.authMode !== 'bearer') {
      renderError(new RegistryError({ code: 'USAGE.INVALID_FLAG', message: '--auth must be anonymous or bearer' }), ctx);
      return 1;
    }
    if (refType === 'artifactory' && this.authMode === 'bearer' && !this.credentialRef) {
      renderError(new RegistryError({ code: 'USAGE.INVALID_FLAG', message: '--credential-ref is required with --auth bearer' }), ctx);
      return 1;
    }
    if (this.credentialRef !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(this.credentialRef)) {
      renderError(new RegistryError({ code: 'USAGE.INVALID_FLAG', message: '--credential-ref must be an environment variable name' }), ctx);
      return 1;
    }
    let location = this.refLocation;
    if (refType === 'local' && !path.isAbsolute(location)) {
      location = path.resolve(ctx.cwd(), location);
    }

    const id = await mgr.importHub({
      type: refType,
      location,
      ref: this.refRef,
      configFile: refType === 'artifactory' ? (this.configFile ?? 'hub-config.yml') : undefined,
      authMode: refType === 'artifactory'
        ? ((this.authMode ?? 'anonymous'))
        : undefined,
      credentialRef: refType === 'artifactory' ? this.credentialRef : undefined
    }, this.hubId);

    // F-05: auto-use and auto-sync after import (unless flags disable)
    if (!this.noUse) {
      await mgr.setActiveHub(id);
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
        const suffix = d.used ? '' : `\nRun \`ai-primitives-hub hub use ${d.id}\` to activate it.`;
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
      Usage: ai-primitives-hub hub use <hub-id>
      Usage: ai-primitives-hub hub use --clear

      Options:
        --clear                  Clear the active hub
        -o, --output <format>     Output format (text, json, yaml, ndjson)

      Examples:
        ai-primitives-hub hub use amadeus-copilot-hub
        ai-primitives-hub hub use --clear
    `
  });

  public clear = Option.Boolean('--clear');
  public hubId = Option.String({ required: false });

  public async execute() {
    const { ctx, http, tokens } = this.commandContext;
    const fmt = (this.output ?? 'text') as OutputFormat;
    const mgr = createHubManager({ ctx, http, tokens });

    if (this.clear) {
      await mgr.setActiveHub(null);
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
        hint: 'Run `ai-primitives-hub hub list` to see available hubs.'
      }), ctx);
      return 1;
    }

    await mgr.setActiveHub(this.hubId);
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
      Usage: ai-primitives-hub hub remove <hub-id>

      Options:
        -o, --output <format>  Output format (text, json, yaml, ndjson)

      Examples:
        ai-primitives-hub hub remove old-hub
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
        hint: 'Run `ai-primitives-hub hub list` to see available hub IDs.'
      }), ctx);
      return 1;
    }

    await mgr.deleteHub(this.hubId);
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
      Usage: ai-primitives-hub hub create --name <name> [--out <dir>] [--add-source <path>]

      Options:
        --name <name>        Hub display name.
        --out <dir>          Output directory (default: cwd).
        --add-source <path>  Pre-populate a local source in the config.

      Examples:
        $ ai-primitives-hub hub create --name "My Hub"
        $ ai-primitives-hub hub create --name "Dev Hub" --out ./hubs/dev
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
      '# hub-config.yml — created by ai-primitives-hub hub create',
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
        + `  ai-primitives-hub hub add --type local --location ${d.outDir}\n`
    });
    return 0;
  }
}

const renderHubValidationText = (
  result: HubConfigFileValidationResult | DeepHubConfigValidationResult
): string => {
  const lines = [`Validating ${result.file}`];
  if (result.valid) {
    const isDeep = 'deep' in result && result.deep;
    lines.push(
      '',
      isDeep
        ? '[ OK ] YAML syntax, schema, runtime, source policies, source catalogs, and profile references'
        : '[ OK ] YAML syntax, schema, runtime checks, and source policies',
      '',
      isDeep
        ? `Hub configuration valid (${result.sources.length} sources checked, ${result.bundlesFound} bundles discovered)`
        : 'Hub configuration valid'
    );
  } else {
    lines.push('', '[FAIL] Hub configuration invalid');
    for (const error of result.errors) {
      lines.push(`  - ${error}`);
    }
  }
  return `${lines.join('\n')}\n`;
};

const renderHubValidationProgress = (ctx: Context, event: HubValidationProgress): void => {
  switch (event.phase) {
    case 'started': {
      ctx.stderr.write(
        `Deep validation: checking ${event.sourcesTotal} source(s) and ${event.profilesTotal} profile(s)\n`
      );
      return;
    }
    case 'source': {
      const position = `[source ${event.current}/${event.total}]`;
      if (event.status === 'started') {
        ctx.stderr.write(`${position} Checking ${event.sourceId} (${event.sourceType})...\n`);
        return;
      }
      const status = event.skipped ? 'skipped' : (event.valid ? 'ok' : 'failed');
      ctx.stderr.write(
        `${position} ${event.sourceId}: ${status} (${event.bundlesFound ?? 0} bundle(s))\n`
      );
      return;
    }
    case 'catalog': {
      const position = `[source ${event.current}/${event.total}]`;
      if (event.status === 'started') {
        ctx.stderr.write(`${position} Discovering bundles...\n`);
        return;
      }
      ctx.stderr.write(`${position} Discovered ${event.bundlesFound ?? 0} bundle(s)\n`);
      return;
    }
    case 'profile': {
      const position = `[profile ${event.current}/${event.total}]`;
      if (event.status === 'started') {
        ctx.stderr.write(`${position} Resolving ${event.profileId}...\n`);
        return;
      }
      const status = event.valid ? 'ok' : 'failed';
      ctx.stderr.write(
        `${position} ${event.profileId}: ${status} (${event.bundlesTotal} reference(s))\n`
      );
      return;
    }
    case 'completed': {
      ctx.stderr.write(
        `Deep validation complete: ${event.valid ? 'valid' : 'invalid'} `
        + `(${event.bundlesFound} bundle(s) discovered)\n`
      );
      return;
    }
  }
};

interface HubSourceAuthenticationPreparation {
  sourceAuthentication?: ReadonlyMap<string, SourceAuthenticationContext>;
  report?: GitHubSourcePreflightReport;
  errors: string[];
}

async function prepareHubSourceAuthentication(
  ctx: Context,
  configPath: string,
  verbose: boolean,
  runtime: GitHubSourceAuthRuntime
): Promise<HubSourceAuthenticationPreparation> {
  try {
    const specs = parseHubConfig(await ctx.fs.readFile(configPath), { strict: true });
    const report = await runtime.preflight(specs, {
      onLog: verbose ? (message) => ctx.stderr.write(`[github preflight] ${message}\n`) : undefined
    });
    if (!report.valid) {
      return {
        report,
        errors: report.results
          .filter((result) => result.category === 'unresolved')
          .map((result) => {
            const operation = result.operations.at(-1);
            return `GitHub source preflight failed for ${result.sourceId}: ${result.errorCode ?? 'GH_SOURCE_PREFLIGHT_UNRESOLVED'}`
              + (operation === undefined ? '' : ` (operation: ${operation})`);
          })
      };
    }
    return {
      report,
      sourceAuthentication: new Map(
        report.results.map((result) => [result.sourceId, {
          category: result.category,
          target: result.target!,
          tokenProvider: result.category === 'public-anonymous'
            ? undefined
            : runtime.tokenProviderFor(result.category as Exclude<GitHubSourceAuthCategory, 'unresolved'>)
        }])
      ),
      errors: []
    };
  } catch (error) {
    const code = typeof (error as { code?: unknown } | undefined)?.code === 'string'
      ? (error as { code: string }).code
      : undefined;
    return {
      errors: [`GitHub source preflight could not run: ${code === undefined ? '' : `${code}: `}${error instanceof Error ? error.message : String(error)}`]
    };
  }
}

/**
 * hub validate - validate a repository hub-config YAML file offline.
 */
export class HubValidateCommand extends BaseHubCommand {
  public static readonly paths = [['hub', 'validate']];
  public static readonly usage = Command.Usage({
    description: 'Validate hub-config.yml against the schema and hub policies.',
    category: 'Hub & Discovery',
    details: `
      Usage: ai-primitives-hub hub validate [options]

      By default, validates YAML syntax, required fields, source/profile references,
      source-type configuration, and GitHub bundle ID prefixes without network calls.
      Use --check-sources to validate source accessibility, discover catalogs,
      and resolve profile bundle references and versions.

      Options:
        --config <path>          Hub configuration file (default: hub-config.yml)
        --check-sources          Contact/scan enabled sources and resolve profiles
        --github-app-id <id>     App ID for automatic source-aware setup
        --github-app-key-file <path>
                                 PEM path for automatic source-aware setup
        -v, --verbose            Print deep-validation progress to stderr
        -o, --output <format>    Output format (text, json, yaml, ndjson)

      Examples:
        ai-primitives-hub hub validate
        ai-primitives-hub hub validate --config configs/hub-config.yml -o json
        ai-primitives-hub hub validate --check-sources
        ai-primitives-hub hub validate --check-sources --verbose -o json
    `
  });

  public config = Option.String('--config');
  public checkSources = Option.Boolean('--check-sources', false);
  public githubAppId = Option.String('--github-app-id');
  public githubAppClientId = Option.String('--github-app-client-id');
  public githubAppKeyFile = Option.String('--github-app-key-file');
  public githubAppInstallationId = Option.String('--github-app-installation-id');
  public githubAppSetupTimeoutMs = Option.String('--github-app-setup-timeout-ms');
  public verbose = Option.Boolean('-v,--verbose', false);

  public async execute(): Promise<number> {
    const { ctx, http, tokens } = this.commandContext;
    const fmt = (this.output ?? 'text') as OutputFormat;
    const configuredPath = this.config ?? 'hub-config.yml';
    const configPath = path.isAbsolute(configuredPath)
      ? configuredPath
      : path.join(ctx.cwd(), configuredPath);
    if (this.verbose && !this.checkSources) {
      ctx.stderr.write('--verbose has no effect without --check-sources; validation remains offline.\n');
    }
    const appBootstrapRequested = this.githubAppId !== undefined
      || this.githubAppClientId !== undefined
      || this.githubAppKeyFile !== undefined
      || ctx.env[GITHUB_APP_AUTH_KEY_FILE] !== undefined;
    let appSession: GitHubSourceAuthSession | undefined;
    try {
      let sourceAuthentication: ReadonlyMap<string, SourceAuthenticationContext> | undefined;
      let sourcePreflight: GitHubSourcePreflightReport | undefined;
      if (this.checkSources && (isGitHubAppAuthEnabled(ctx.env) || appBootstrapRequested)) {
        const staticResult = await validateHubConfigFile(ctx.fs, configPath);
        if (!staticResult.valid) {
          formatOutput({
            ctx,
            command: 'hub.validate',
            output: fmt,
            status: 'error',
            data: staticResult,
            warnings: staticResult.warnings,
            textRenderer: renderHubValidationText
          });
          return 1;
        }
        let runtime: GitHubSourceAuthRuntime;
        if (appBootstrapRequested) {
          appSession = await createGitHubSourceAuthSession({
            env: ctx.env,
            http: http ?? new NodeHttpClient(),
            appId: this.githubAppId ?? ctx.env[GITHUB_APP_ID],
            clientId: this.githubAppClientId ?? ctx.env[GITHUB_APP_CLIENT_ID],
            keyFile: this.githubAppKeyFile ?? ctx.env[GITHUB_APP_AUTH_KEY_FILE] ?? '',
            installationId: this.githubAppInstallationId ?? ctx.env[GITHUB_APP_INSTALLATION_ID],
            setupTimeoutMs: this.githubAppSetupTimeoutMs === undefined
              ? undefined
              : Number.parseInt(this.githubAppSetupTimeoutMs, 10)
          });
          runtime = appSession;
        } else {
          runtime = createGitHubSourceAuthRuntime({
            env: ctx.env,
            http: http ?? new NodeHttpClient()
          });
        }
        const prepared = await prepareHubSourceAuthentication(
          ctx,
          configPath,
          this.verbose,
          runtime
        );
        sourcePreflight = prepared.report;
        if (prepared.errors.length > 0) {
          const preflightResult: HubConfigFileValidationResult = {
            file: configPath,
            valid: false,
            errors: prepared.errors,
            warnings: []
          };
          formatOutput({
            ctx,
            command: 'hub.validate',
            output: fmt,
            status: 'error',
            data: {
              ...preflightResult,
              sourcePreflight
            },
            warnings: preflightResult.warnings,
            textRenderer: renderHubValidationText
          });
          return 1;
        }
        sourceAuthentication = prepared.sourceAuthentication;
      }
      const result = await validateHubConfigFile(ctx.fs, configPath, this.checkSources
        ? {
          deep: true,
          onProgress: this.verbose
            ? (event) => renderHubValidationProgress(ctx, event)
            : undefined,
          sourceAdapterDeps: {
            fs: ctx.fs,
            clock: ctx.clock,
            httpClient: http ?? new NodeHttpClient(),
            processRunner: new NodeProcessRunner(),
            fallbackTokenProviders: tokens === undefined
              ? [defaultTokenProvider(ctx.env)]
              : [tokens],
            sourceAuthentication
          }
        }
        : undefined);
      const validationData = sourcePreflight === undefined
        ? result
        : { ...result, sourcePreflight };

      formatOutput({
        ctx,
        command: 'hub.validate',
        output: fmt,
        status: result.valid ? (result.warnings?.length ? 'warning' : 'ok') : 'error',
        data: validationData,
        warnings: result.warnings,
        textRenderer: renderHubValidationText
      });
      return result.valid ? 0 : 1;
    } finally {
      await appSession?.cleanup();
    }
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
      Usage: ai-primitives-hub hub sync [<hub-id>]

      Examples:
        $ ai-primitives-hub hub sync          # sync active hub
        $ ai-primitives-hub hub sync my-hub   # sync specific hub
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
          hint: 'Run `ai-primitives-hub hub use <id>` or pass the hub id directly.'
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
      Usage: ai-primitives-hub hub refresh

      Examples:
        $ ai-primitives-hub hub refresh   # same as: hub sync (active)
    `
  });

  public async execute() {
    const { ctx, http, tokens } = this.commandContext;
    const fmt = (this.output ?? 'text') as OutputFormat;
    const mgr = createHubManager({ ctx, http, tokens });

    const active = await mgr.getActiveHub();
    if (!active) {
      renderError(new RegistryError({
        code: 'HUB.NOT_FOUND',
        message: 'hub refresh: no active hub',
        hint: 'Run `ai-primitives-hub hub use <id>` first.'
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
