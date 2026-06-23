/**
 * `doctor` subcommand.
 *
 * `prompt-registry doctor` performs a self-check and reports findings
 * via the formatter. It exercises every framework slice:
 * Context (fs / env / cwd), formatOutput, and (on failure) RegistryError.
 *
 * Current scope: report Node version, cwd accessibility, and presence of
 * the framework's required env vars. Future iterations will add domain-specific
 * checks (index path writable, hub reachability, etc.) as those
 * components materialize.
 *
 * This is also the *first leaf command* — the canary for the
 * "leaf commands never import clipanion / node:fs / process directly"
 * invariant. The implementation only imports from the
 * framework barrel.
 *
 * NOTE: Option support (--output) is a future feature. For current
 * testing, the output format is set via the factory parameter.
 */
import {
  resolveUserConfigPaths,
} from '@prompt-registry/app';
import {
  ActiveHubStore,
  defaultTokenProvider,
  findProjectConfigPath,
  HubStore,
  NodeHttpClient,
  readTargets,
} from '@prompt-registry/infra';
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
  type OutputStatus,
} from '../framework';

/**
 * Doctor check result.
 */
interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

/**
 * Doctor result summary.
 */
interface DoctorResult {
  checks: DoctorCheck[];
  summary: { ok: number; warn: number; fail: number };
}

/**
 * Command context for doctor command.
 */
interface DoctorContext {
  ctx: Context;
}

/**
 * Base class for doctor command.
 */
abstract class BaseDoctorCommand extends Command {
  public commandContext: DoctorContext = { ctx: null as any };
}

/**
 * Native clipanion class command for doctor.
 */
export class DoctorCommand extends BaseDoctorCommand {
  public static readonly paths = [['doctor']];

  public static readonly usage = Command.Usage({
    description: 'Run environment self-checks and print a health report.',
    category: 'Configure & Debug',
    details: `
      Usage: prompt-registry doctor [options]

      Checks Node version, project config, install targets, GitHub auth, and API reachability.

      Options:
        -o, --output <format>  Output format (text, json, yaml, ndjson)

      Examples:
        prompt-registry doctor
        prompt-registry doctor -o json
    `
  });

  public output = Option.String('-o', '--output') as OutputFormat | undefined;

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const fmt = (this.output ?? 'text');
    const result = await runDoctorChecks(ctx);
    const statusValue = result.summary.warn > 0 ? 'warning' : 'ok';
    const status: OutputStatus = result.summary.fail > 0 ? 'error' : statusValue;
    formatOutput({
      ctx,
      command: 'doctor',
      output: fmt,
      status,
      data: result,
      textRenderer: renderDoctorText
    });
    return result.summary.fail > 0 ? 1 : 0;
  }
}

/**
 * Create a CommandDefinition wrapper for the doctor command class.
 * This adapts native clipanion classes to the framework's CommandDefinition pattern.
 * @param ctx CLI context.
 * @param defaultOutput Default output format (optional).
 * @returns CommandClass.
 */
const createDoctorCommandDefinition = (
  ctx: Context,
  defaultOutput?: string
): typeof DoctorCommand => {
  class ConfiguredCommand extends DoctorCommand {
    public execute(): Promise<number> {
      this.commandContext = { ctx };
      if (defaultOutput !== undefined && !this.output) {
        this.output = defaultOutput as OutputFormat;
      }

      return super.execute();
    }
  }
  copyCommandPrototype(DoctorCommand, ConfiguredCommand);

  return ConfiguredCommand;
};

/**
 * Factory function to create a configured doctor command class.
 * @param ctx CLI context.
 * @param defaultOutput Default output format (optional).
 * @returns CommandClass.
 */
export const createDoctorCommandClass = (
  ctx: Context,
  defaultOutput?: string
): typeof DoctorCommand => {
  return createDoctorCommandDefinition(ctx, defaultOutput);
};

/**
 * Build the `doctor` command. Caller controls the output format so the
 * same handler runs under text mode for humans and JSON mode for CI.
 * @param opts - Command options
 * @param opts.output - Output format to use (default 'text').
 * @returns CommandDefinition wired to the framework adapter.
 */
export const createDoctorCommand = (opts: { output?: OutputFormat } = {}): CommandDefinition =>
  defineCommand({
    path: ['doctor'],
    description: 'Run environment self-checks and print a health report.',
    category: 'Configure & Debug',
    run: async ({ ctx }: { ctx: Context }): Promise<number> => {
      const result = await runDoctorChecks(ctx);
      const statusValue = result.summary.warn > 0 ? 'warning' : 'ok';
      const status: OutputStatus = result.summary.fail > 0 ? 'error' : statusValue;
      formatOutput({
        ctx,
        command: 'doctor',
        output: opts.output ?? 'text',
        status,
        data: result,
        textRenderer: renderDoctorText
      });
      return result.summary.fail > 0 ? 1 : 0;
    }
  });

/**
 * Execute every check and aggregate the result.
 * @param ctx Application Context — fs/env/cwd accessed only via this.
 * @returns Aggregated `DoctorResult` (every check is reported regardless of pass/fail).
 */
const runDoctorChecks = async (ctx: Context): Promise<DoctorResult> => {
  const checks: DoctorCheck[] = [
    checkNodeVersion(ctx),
    await checkCwdReadable(ctx),
    checkPathEnvVar(ctx),
    await checkProjectConfig(ctx),
    await checkTargets(ctx),
    // I-008: surface CLI-level state that affects most commands.
    await checkXdgConfig(ctx),
    await checkGitHubAuth(ctx),
    await checkActiveHub(ctx),
    await checkApiReachable(ctx)
  ];
  const summary = checks.reduce(
    (acc, c) => {
      acc[c.status] += 1;
      return acc;
    },
    { ok: 0, warn: 0, fail: 0 }
  );
  return { checks, summary };
};

/**
 * Check Node version.
 * @param ctx CLI context.
 * @returns Doctor check result.
 */
const checkNodeVersion = (ctx: Context): DoctorCheck => {
  const v = ctx.env.NODE_VERSION ?? extractRuntimeNodeVersion();
  const vStripped = v.startsWith('v') ? v.slice(1) : v;
  const major = Number.parseInt(vStripped.split('.')[0] ?? '0', 10);
  if (Number.isFinite(major) && major >= 20) {
    return { name: 'node-version', status: 'ok', detail: `Node ${v} satisfies >=20.` };
  }
  return {
    name: 'node-version',
    status: 'fail',
    detail: `Node ${v} < required minimum 20. See engines.node in package.json.`
  };
};

/**
 * Extract runtime Node version.
 * @returns Node version string.
 */
const extractRuntimeNodeVersion = (): string => {
  // Read process.version once — this is the only allowed touch in
  // command code because there is no cleaner Context surface for the
  // runtime version. Future iterations may add `ctx.runtime` if we add more
  // checks like this.
  return process.version;
};

/**
 * Check if CWD is readable.
 * @param ctx CLI context.
 * @returns Doctor check result.
 */
const checkCwdReadable = async (ctx: Context): Promise<DoctorCheck> => {
  try {
    const cwd = ctx.cwd();
    const ok = await ctx.fs.exists(cwd);
    if (!ok) {
      return {
        name: 'cwd-accessible',
        status: 'fail',
        detail: `Working directory ${cwd} does not exist or is not accessible.`
      };
    }
    return { name: 'cwd-accessible', status: 'ok', detail: `Working directory ${cwd} accessible.` };
  } catch (err) {
    return {
      name: 'cwd-accessible',
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err)
    };
  }
};

// Install-related checks.
/**
 * Check project config.
 * @param ctx CLI context.
 * @returns Doctor check result.
 */
const checkProjectConfig = async (ctx: Context): Promise<DoctorCheck> => {
  try {
    const { file, exists } = await findProjectConfigPath({ cwd: ctx.cwd(), fs: ctx.fs });
    if (!exists) {
      return {
        name: 'project-config',
        status: 'warn',
        detail: `No prompt-registry.yml found from ${ctx.cwd()} upward. Run \`prompt-registry target add ...\` to create one.`
      };
    }
    return {
      name: 'project-config',
      status: 'ok',
      detail: `Project config: ${file}`
    };
  } catch (err) {
    return {
      name: 'project-config',
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err)
    };
  }
};

/**
 * Check install targets.
 * @param ctx CLI context.
 * @returns Doctor check result.
 */
const checkTargets = async (ctx: Context): Promise<DoctorCheck> => {
  try {
    const targets = await readTargets({ cwd: ctx.cwd(), fs: ctx.fs });
    if (targets.length === 0) {
      return {
        name: 'install-targets',
        status: 'warn',
        detail: 'No install targets configured. Add one with `prompt-registry target add <name> --type <kind>`.'
      };
    }
    return {
      name: 'install-targets',
      status: 'ok',
      detail: `${targets.length} target${targets.length === 1 ? '' : 's'}: ${targets.map((t) => t.name + '(' + t.type + ')').join(', ')}`
    };
  } catch (err) {
    return {
      name: 'install-targets',
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err)
    };
  }
};

/**
 * Check PATH environment variable.
 * @param ctx CLI context.
 * @returns Doctor check result.
 */
const checkPathEnvVar = (ctx: Context): DoctorCheck => {
  const p = ctx.env.PATH ?? '';
  if (p.length === 0) {
    return {
      name: 'path-env',
      status: 'warn',
      detail: 'PATH env var is empty; subprocess plugins (PATH-binary discovery) will not work.'
    };
  }
  return { name: 'path-env', status: 'ok', detail: `PATH has ${p.split(':').length} entries.` };
};

// I-008: XDG / hub / token / network checks.

/**
 * Check XDG config paths.
 * @param ctx CLI context.
 * @returns Doctor check result.
 */
const checkXdgConfig = async (ctx: Context): Promise<DoctorCheck> => {
  try {
    const paths = resolveUserConfigPaths(ctx.env);
    const exists = await ctx.fs.exists(paths.root);
    if (!exists) {
      return {
        name: 'xdg-config',
        status: 'warn',
        detail: `User config dir ${paths.root} does not exist yet (will be created on first hub add).`
      };
    }
    return {
      name: 'xdg-config',
      status: 'ok',
      detail: `User config: ${paths.root}`
    };
  } catch (err) {
    return {
      name: 'xdg-config',
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err)
    };
  }
};

/**
 * Check active hub.
 * @param ctx CLI context.
 * @returns Doctor check result.
 */
const checkActiveHub = async (ctx: Context): Promise<DoctorCheck> => {
  try {
    const paths = resolveUserConfigPaths(ctx.env);
    const exists = await ctx.fs.exists(paths.root);
    if (!exists) {
      return { name: 'active-hub', status: 'warn', detail: 'No user config yet — no active hub.' };
    }
    const active = new ActiveHubStore(paths.activeHub, ctx.fs);
    const id = await active.get();
    if (id === null) {
      return { name: 'active-hub', status: 'warn', detail: 'No active hub. Run `hub use <id>`.' };
    }
    const store = new HubStore(paths.hubs, ctx.fs);
    if (!(await store.has(id))) {
      return {
        name: 'active-hub',
        status: 'fail',
        detail: `Active hub "${id}" pointer is stale (config missing).`
      };
    }
    return { name: 'active-hub', status: 'ok', detail: `Active hub: ${id}` };
  } catch (err) {
    return {
      name: 'active-hub',
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err)
    };
  }
};

/**
 * Check GitHub authentication.
 * @param ctx CLI context.
 * @returns Doctor check result.
 */
const checkGitHubAuth = async (ctx: Context): Promise<DoctorCheck> => {
  try {
    const provider = defaultTokenProvider(ctx.env);
    const token = await provider.getToken('api.github.com');
    if (token === null || token.length === 0) {
      return {
        name: 'github-auth',
        status: 'warn',
        detail: 'No GitHub token resolvable. Set GITHUB_TOKEN/GH_TOKEN or run `gh auth login`. '
          + 'Public hubs work without auth (60 req/hour rate limit).'
      };
    }
    // Never echo the token; just confirm length.
    return {
      name: 'github-auth',
      status: 'ok',
      detail: `GitHub token resolved (${token.length} chars). Token is never logged.`
    };
  } catch (err) {
    return {
      name: 'github-auth',
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err)
    };
  }
};

/**
 * Check GitHub API reachability.
 * @param ctx CLI context.
 * @returns Doctor check result.
 */
const checkApiReachable = async (ctx: Context): Promise<DoctorCheck> => {
  // Use the lib's own HTTP client (so we test the same path users hit).
  // Skip when running offline tests by setting PROMPT_REGISTRY_SKIP_NETWORK=1.
  if (ctx.env.PROMPT_REGISTRY_SKIP_NETWORK === '1') {
    return {
      name: 'github-api',
      status: 'warn',
      detail: 'Skipped (PROMPT_REGISTRY_SKIP_NETWORK=1).'
    };
  }
  try {
    const http = new NodeHttpClient();
    const provider = defaultTokenProvider(ctx.env);
    const token = await provider.getToken('api.github.com');
    const headers: Record<string, string> = {};
    if (token !== null && token.length > 0) {
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await http.fetch({ url: 'https://api.github.com/rate_limit', headers });
    if (res.statusCode >= 200 && res.statusCode < 300) {
      return { name: 'github-api', status: 'ok', detail: 'api.github.com reachable.' };
    }
    return {
      name: 'github-api',
      status: 'warn',
      detail: `api.github.com returned ${String(res.statusCode)}.`
    };
  } catch (err) {
    return {
      name: 'github-api',
      status: 'warn',
      detail: `api.github.com unreachable: ${err instanceof Error ? err.message : String(err)}`
    };
  }
};

/** Status glyphs for text output. */
const STATUS_GLYPHS: Record<DoctorCheck['status'], string> = {
  ok: '[ OK ]',
  warn: '[WARN]',
  fail: '[FAIL]'
};

/**
 * Render doctor result as text.
 * @param result Doctor result.
 * @returns Formatted text output.
 */
const renderDoctorText = (result: DoctorResult): string => {
  const lines: string[] = ['prompt-registry doctor'];
  for (const c of result.checks) {
    lines.push(`  ${STATUS_GLYPHS[c.status]} ${c.name}: ${c.detail}`);
  }
  lines.push(
    '',
    `summary: ${result.summary.ok} ok / ${result.summary.warn} warn / ${result.summary.fail} fail`
  );
  return `${lines.join('\n')}\n`;
};
