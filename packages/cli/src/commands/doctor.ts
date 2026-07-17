/**
 * `doctor` subcommand.
 *
 * `ai-primitives-hub doctor` performs a self-check and reports findings
 * via the formatter. It exercises every framework slice:
 * Context (fs / env / cwd), formatOutput, and (on failure) RegistryError.
 * @module commands/doctor
 */
import {
  spawnSync,
} from 'node:child_process';
import * as path from 'node:path';
import {
  resolveUserConfigPaths,
} from '@ai-primitives-hub/app';
import {
  ActiveHubStore,
  defaultTokenProvider,
  findProjectConfigPath,
  HubStore,
  NodeHttpClient,
  readTargets,
  summarizeProxyEnv,
} from '@ai-primitives-hub/infra';
import {
  type DiagnosticsResult,
  getDiagnosticCommandClasses,
  runDiagnostics,
} from '../doctor/diagnostics';
import {
  Command,
  type Context,
  formatOutput,
  Option,
  type OutputFormat,
  type OutputStatus,
} from '../framework';

/**
 * A single log line captured while a check is running.
 */
interface DoctorLogLine {
  /** One of `info`, `input`, `output`, `error`. */
  level: 'info' | 'input' | 'output' | 'error';
  /** Human-readable message. */
  message: string;
}

/**
 * Doctor check result.
 */
interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  /** Detailed log lines emitted while running the check. */
  logs?: DoctorLogLine[];
}

/**
 * Doctor result summary.
 */
interface DoctorResult {
  checks: DoctorCheck[];
  summary: { ok: number; warn: number; fail: number };
  /** True when verbose mode produced per-check logs. */
  verbose?: boolean;
}

/**
 * Base class for doctor commands.
 */
abstract class BaseDoctorCommand extends Command {
  public commandContext!: { ctx: Context };

  public output = Option.String('-o,--output');
  public verbose = Option.Boolean('-v,--verbose', false);
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
      Usage: ai-primitives-hub doctor [options]

      Checks Node version, project config, install targets, GitHub auth, network
      configuration, and API reachability.

      Options:
        -o, --output <format>  Output format (text, json, yaml, ndjson)
        -v, --verbose          Show detailed per-check logs

      Examples:
        ai-primitives-hub doctor
        ai-primitives-hub doctor -v
        ai-primitives-hub doctor -o json
    `
  });

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const fmt = (this.output ?? 'text') as OutputFormat;
    const result = await runDoctorChecks(ctx, this.verbose);
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
 * Native clipanion class command for doctor diagnostics.
 */
export class DoctorDiagnosticsCommand extends BaseDoctorCommand {
  public static readonly paths = [['doctor', 'diagnostics']];

  public static readonly usage = Command.Usage({
    description: 'Run a self-contained end-to-end diagnostic smoke test.',
    category: 'Configure & Debug',
    details: `
      Usage: ai-primitives-hub doctor diagnostics [options]

      Creates an isolated temporary workspace, runs a representative subset of the
      E2E user flow (target add, hub add, sync, profile activate, index build,
      install, uninstall), and reports every step with captured input/output.

      The workspace is always cleaned up before exiting.

      Options:
        -o, --output <format>  Output format (text, json, yaml, ndjson)
        -v, --verbose          Print per-step progress to stderr

      Examples:
        ai-primitives-hub doctor diagnostics
        ai-primitives-hub doctor diagnostics -v
    `
  });

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const fmt = (this.output ?? 'text') as OutputFormat;
    const result = await runDiagnostics({
      ctx,
      commandClasses: getDiagnosticCommandClasses(),
      verbose: this.verbose
    });
    const status: OutputStatus = result.ok ? 'ok' : 'error';
    formatOutput({
      ctx,
      command: 'doctor diagnostics',
      output: fmt,
      status,
      data: result,
      textRenderer: renderDiagnosticsText
    });
    return result.ok ? 0 : 1;
  }
}

/**
 * Execute every check and aggregate the result.
 * @param ctx Application Context — fs/env/cwd accessed only via this.
 * @param verbose When true, capture detailed per-check logs.
 * @returns Aggregated `DoctorResult` (every check is reported regardless of pass/fail).
 */
const runDoctorChecks = async (ctx: Context, verbose: boolean): Promise<DoctorResult> => {
  const checks: DoctorCheck[] = [
    checkNodeVersion(ctx, verbose),
    await checkCwdReadable(ctx, verbose),
    checkPathEnvVar(ctx, verbose),
    await checkProjectConfig(ctx, verbose),
    await checkTargets(ctx, verbose),
    checkNetworkConfig(ctx, verbose),
    await checkXdgConfig(ctx, verbose),
    await checkGitHubAuth(ctx, verbose),
    await checkGitHubCli(ctx, verbose),
    await checkActiveHub(ctx, verbose),
    await checkApiReachable(ctx, verbose)
  ];
  const summary = checks.reduce(
    (acc, c) => {
      acc[c.status] += 1;
      return acc;
    },
    { ok: 0, warn: 0, fail: 0 }
  );
  return { checks, summary, verbose };
};

/**
 * Create a log builder that only records lines when verbose is true.
 * @param verbose Whether to record logs.
 * @returns Mutable log buffer.
 */
const createLogger = (verbose: boolean): DoctorLogLine[] => (verbose ? [] : undefined) as unknown as DoctorLogLine[];

/**
 * Append a log line to a log buffer when verbose.
 * @param logs Log buffer.
 * @param level Log level.
 * @param message Log message.
 */
const log = (
  logs: DoctorLogLine[] | undefined,
  level: DoctorLogLine['level'],
  message: string
): void => {
  if (logs !== undefined) {
    logs.push({ level, message });
  }
};

/**
 * Check Node version.
 * @param ctx CLI context.
 * @param verbose Whether to record logs.
 * @returns Doctor check result.
 */
const checkNodeVersion = (ctx: Context, verbose: boolean): DoctorCheck => {
  const logs = createLogger(verbose);
  const v = ctx.env.NODE_VERSION ?? extractRuntimeNodeVersion();
  const execPath = process.execPath;
  log(logs, 'info', `runtime: ${v}`);
  log(logs, 'info', `execPath: ${execPath}`);
  const vStripped = v.startsWith('v') ? v.slice(1) : v;
  const major = Number.parseInt(vStripped.split('.')[0] ?? '0', 10);
  if (Number.isFinite(major) && major >= 20) {
    return { name: 'node-version', status: 'ok', detail: `Node ${v} satisfies >=20.`, logs };
  }
  return {
    name: 'node-version',
    status: 'fail',
    detail: `Node ${v} < required minimum 20. See engines.node in package.json.`,
    logs
  };
};

/**
 * Extract runtime Node version.
 * @returns Node version string.
 */
const extractRuntimeNodeVersion = (): string => process.version;

/**
 * Check if CWD is readable.
 * @param ctx CLI context.
 * @param verbose Whether to record logs.
 * @returns Doctor check result.
 */
const checkCwdReadable = async (ctx: Context, verbose: boolean): Promise<DoctorCheck> => {
  const logs = createLogger(verbose);
  try {
    const cwd = ctx.cwd();
    log(logs, 'input', `cwd: ${cwd}`);
    const ok = await ctx.fs.exists(cwd);
    log(logs, 'output', `exists: ${ok ? 'true' : 'false'}`);
    if (!ok) {
      return {
        name: 'cwd-accessible',
        status: 'fail',
        detail: `Working directory ${cwd} does not exist or is not accessible.`,
        logs
      };
    }
    return { name: 'cwd-accessible', status: 'ok', detail: `Working directory ${cwd} accessible.`, logs };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(logs, 'error', msg);
    return {
      name: 'cwd-accessible',
      status: 'fail',
      detail: msg,
      logs
    };
  }
};

// Install-related checks.
/**
 * Check project config.
 * @param ctx CLI context.
 * @param verbose Whether to record logs.
 * @returns Doctor check result.
 */
const checkProjectConfig = async (ctx: Context, verbose: boolean): Promise<DoctorCheck> => {
  const logs = createLogger(verbose);
  try {
    const cwd = ctx.cwd();
    log(logs, 'input', `cwd: ${cwd}`);
    const { file, exists } = await findProjectConfigPath({ cwd, fs: ctx.fs });
    log(logs, 'output', `file: ${file}, exists: ${exists ? 'true' : 'false'}`);
    if (!exists) {
      return {
        name: 'project-config',
        status: 'warn',
        detail: `No ai-primitives-hub.yml found from ${cwd} upward. Run \`ai-primitives-hub target add ...\` to create one.`,
        logs
      };
    }
    return {
      name: 'project-config',
      status: 'ok',
      detail: `Project config: ${file}`,
      logs
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(logs, 'error', msg);
    return {
      name: 'project-config',
      status: 'fail',
      detail: msg,
      logs
    };
  }
};

/**
 * Check install targets.
 * @param ctx CLI context.
 * @param verbose Whether to record logs.
 * @returns Doctor check result.
 */
const checkTargets = async (ctx: Context, verbose: boolean): Promise<DoctorCheck> => {
  const logs = createLogger(verbose);
  try {
    const targets = await readTargets({ cwd: ctx.cwd(), fs: ctx.fs });
    log(logs, 'output', `targets: ${targets.map((t) => `${t.name}(${t.type})`).join(', ')}`);
    if (targets.length === 0) {
      return {
        name: 'install-targets',
        status: 'warn',
        detail: 'No install targets configured. Add one with `ai-primitives-hub target add <name> --type <kind>`.',
        logs
      };
    }
    return {
      name: 'install-targets',
      status: 'ok',
      detail: `${targets.length} target${targets.length === 1 ? '' : 's'}: ${targets.map((t) => t.name + '(' + t.type + ')').join(', ')}`,
      logs
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(logs, 'error', msg);
    return {
      name: 'install-targets',
      status: 'fail',
      detail: msg,
      logs
    };
  }
};

/**
 * Check PATH environment variable.
 * @param ctx CLI context.
 * @param verbose Whether to record logs.
 * @returns Doctor check result.
 */
const checkPathEnvVar = (ctx: Context, verbose: boolean): DoctorCheck => {
  const logs = createLogger(verbose);
  const p = ctx.env.PATH ?? '';
  const entries = p.split(path.delimiter);
  log(logs, 'info', `PATH entries: ${entries.length}`);
  if (verbose) {
    entries.forEach((entry, idx) => log(logs, 'info', `  ${idx}: ${entry}`));
  }
  if (p.length === 0) {
    return {
      name: 'path-env',
      status: 'warn',
      detail: 'PATH env var is empty; subprocess plugins (PATH-binary discovery) will not work.',
      logs
    };
  }
  return { name: 'path-env', status: 'ok', detail: `PATH has ${entries.length} entries.`, logs };
};

/**
 * Check network / proxy configuration.
 * @param ctx CLI context.
 * @param verbose Whether to record logs.
 * @returns Doctor check result.
 */
const checkNetworkConfig = (ctx: Context, verbose: boolean): DoctorCheck => {
  const logs = createLogger(verbose);
  const proxy = summarizeProxyEnv(ctx.env);
  log(logs, 'info', `proxyConfigured: ${proxy.configured ? 'true' : 'false'}`);
  if (proxy.source !== undefined) {
    log(logs, 'info', `proxySource: ${proxy.source}`);
  }
  if (proxy.httpProxy !== undefined) {
    log(logs, 'info', `HTTP_PROXY: ${proxy.httpProxy}`);
  }
  if (proxy.httpsProxy !== undefined) {
    log(logs, 'info', `HTTPS_PROXY: ${proxy.httpsProxy}`);
  }
  if (proxy.noProxy !== undefined) {
    log(logs, 'info', `NO_PROXY: ${proxy.noProxy}`);
  }
  if (ctx.env.NODE_EXTRA_CA_CERTS !== undefined) {
    log(logs, 'info', `NODE_EXTRA_CA_CERTS: ${ctx.env.NODE_EXTRA_CA_CERTS}`);
  }
  if (proxy.configured) {
    const parts: string[] = [];
    if (proxy.source === 'git-config' || proxy.source === 'both') {
      parts.push('git config http.proxy');
    }
    if (proxy.source === 'env' || proxy.source === 'both') {
      parts.push([
        proxy.httpProxy === undefined ? '' : 'HTTP_PROXY',
        proxy.httpsProxy === undefined ? '' : 'HTTPS_PROXY',
        proxy.noProxy === undefined ? '' : 'NO_PROXY'
      ].filter(Boolean).join(', '));
    }
    return {
      name: 'network-config',
      status: 'ok',
      detail: `Proxy configured via ${parts.join(' + ')}.`,
      logs
    };
  }
  return {
    name: 'network-config',
    status: 'ok',
    detail: 'No proxy env vars or git config proxy configured.',
    logs
  };
};

/**
 * Check XDG config paths.
 * @param ctx CLI context.
 * @param verbose Whether to record logs.
 * @returns Doctor check result.
 */
const checkXdgConfig = async (ctx: Context, verbose: boolean): Promise<DoctorCheck> => {
  const logs = createLogger(verbose);
  try {
    const paths = resolveUserConfigPaths(ctx.env);
    log(logs, 'output', `root: ${paths.root}`);
    log(logs, 'output', `activeHub: ${paths.activeHub}`);
    log(logs, 'output', `hubs: ${paths.hubs}`);
    const exists = await ctx.fs.exists(paths.root);
    log(logs, 'output', `exists: ${exists ? 'true' : 'false'}`);
    if (!exists) {
      return {
        name: 'xdg-config',
        status: 'warn',
        detail: `User config dir ${paths.root} does not exist yet (will be created on first hub add).`,
        logs
      };
    }
    return {
      name: 'xdg-config',
      status: 'ok',
      detail: `User config: ${paths.root}`,
      logs
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(logs, 'error', msg);
    return {
      name: 'xdg-config',
      status: 'fail',
      detail: msg,
      logs
    };
  }
};

/**
 * Check active hub.
 * @param ctx CLI context.
 * @param verbose Whether to record logs.
 * @returns Doctor check result.
 */
const checkActiveHub = async (ctx: Context, verbose: boolean): Promise<DoctorCheck> => {
  const logs = createLogger(verbose);
  try {
    const paths = resolveUserConfigPaths(ctx.env);
    const legacyRoot = path.join(path.dirname(paths.root), 'prompt-registry');
    const legacyPaths = {
      root: legacyRoot,
      activeHub: path.join(legacyRoot, 'active-hub.json'),
      hubs: path.join(legacyRoot, 'hubs')
    };

    const candidates = [paths, legacyPaths];
    for (const candidate of candidates) {
      const exists = await ctx.fs.exists(candidate.root);
      log(logs, 'output', `userConfigExists (${candidate.root}): ${exists ? 'true' : 'false'}`);
      if (!exists) {
        continue;
      }
      const active = new ActiveHubStore(candidate.activeHub, ctx.fs);
      const id = await active.get();
      log(logs, 'output', `activeHubId (${candidate.root}): ${id ?? '<null>'}`);
      if (id === null) {
        continue;
      }
      const store = new HubStore(candidate.hubs, ctx.fs);
      const hubExists = await store.has(id);
      log(logs, 'output', `hubConfigExists (${candidate.root}): ${hubExists ? 'true' : 'false'}`);
      if (!hubExists) {
        return {
          name: 'active-hub',
          status: 'fail',
          detail: `Active hub "${id}" pointer is stale (config missing).`,
          logs
        };
      }
      return { name: 'active-hub', status: 'ok', detail: `Active hub: ${id}`, logs };
    }

    return { name: 'active-hub', status: 'warn', detail: 'No active hub. Run `hub use <id>`.', logs };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(logs, 'error', msg);
    return {
      name: 'active-hub',
      status: 'fail',
      detail: msg,
      logs
    };
  }
};

/**
 * Check GitHub authentication.
 * @param ctx CLI context.
 * @param verbose Whether to record logs.
 * @returns Doctor check result.
 */
const checkGitHubAuth = async (ctx: Context, verbose: boolean): Promise<DoctorCheck> => {
  const logs = createLogger(verbose);
  try {
    const provider = defaultTokenProvider(ctx.env);
    const token = await provider.getToken('api.github.com');
    log(logs, 'output', `tokenResolved: ${token !== undefined && token.length > 0 ? 'true' : 'false'}`);
    if (token !== undefined && token.length > 0) {
      log(logs, 'output', `tokenLength: ${token.length}`);
      return {
        name: 'github-auth',
        status: 'ok',
        detail: `GitHub token resolved (${token.length} chars). Token is never logged.`,
        logs
      };
    }
    return {
      name: 'github-auth',
      status: 'warn',
      detail: 'No GitHub token resolvable. Set GITHUB_TOKEN/GH_TOKEN or run `gh auth login`. '
        + 'Public hubs work without auth (60 req/hour rate limit).',
      logs
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(logs, 'error', msg);
    return {
      name: 'github-auth',
      status: 'fail',
      detail: msg,
      logs
    };
  }
};

/**
 * Check the GitHub CLI (`gh`) availability and auth status.
 * @param ctx CLI context.
 * @param verbose Whether to record logs.
 * @returns Doctor check result.
 */
const checkGitHubCli = (ctx: Context, verbose: boolean): Promise<DoctorCheck> => {
  const logs = createLogger(verbose);
  try {
    const version = spawnSync('gh', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000
    });
    log(logs, 'input', 'gh --version');
    log(logs, 'output', `status: ${version.status ?? 'null'}`);
    log(logs, 'output', `stdout: ${version.stdout.trim()}`);
    if (version.status !== 0) {
      return Promise.resolve({
        name: 'github-cli',
        status: 'warn',
        detail: '`gh` CLI not found or not working. Install it from https://cli.github.com.',
        logs
      });
    }
    const status = spawnSync('gh', ['auth', 'status'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000
    });
    log(logs, 'input', 'gh auth status');
    log(logs, 'output', `status: ${status.status ?? 'null'}`);
    log(logs, 'output', `stdout: ${status.stdout.trim()}`);
    log(logs, 'output', `stderr: ${status.stderr.trim()}`);
    if (status.status !== 0) {
      return Promise.resolve({
        name: 'github-cli',
        status: 'warn',
        detail: '`gh` CLI is installed but not authenticated. Run `gh auth login`.',
        logs
      });
    }
    return Promise.resolve({
      name: 'github-cli',
      status: 'ok',
      detail: '`gh` CLI installed and authenticated.',
      logs
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(logs, 'error', msg);
    return Promise.resolve({
      name: 'github-cli',
      status: 'warn',
      detail: `Could not verify gh CLI: ${msg}`,
      logs
    });
  }
};

/**
 * Check GitHub API reachability.
 * @param ctx CLI context.
 * @param verbose Whether to record logs.
 * @returns Doctor check result.
 */
const checkApiReachable = async (ctx: Context, verbose: boolean): Promise<DoctorCheck> => {
  const logs = createLogger(verbose);
  // Use the lib's own HTTP client (so we test the same path users hit).
  // Skip when running offline tests by setting AI_PRIMITIVES_HUB_SKIP_NETWORK=1.
  if (ctx.env.AI_PRIMITIVES_HUB_SKIP_NETWORK === '1') {
    log(logs, 'info', 'Skipped (AI_PRIMITIVES_HUB_SKIP_NETWORK=1).');
    return {
      name: 'github-api',
      status: 'warn',
      detail: 'Skipped (AI_PRIMITIVES_HUB_SKIP_NETWORK=1).',
      logs
    };
  }
  try {
    log(logs, 'input', 'GET https://api.github.com/rate_limit');
    const http = new NodeHttpClient();
    const provider = defaultTokenProvider(ctx.env);
    const token = await provider.getToken('api.github.com');
    log(logs, 'output', `tokenPresent: ${token !== undefined && token.length > 0 ? 'true' : 'false'}`);
    const headers: Record<string, string> = {};
    if (token !== undefined && token.length > 0) {
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await http.fetch({ url: 'https://api.github.com/rate_limit', headers });
    log(logs, 'output', `statusCode: ${String(res.statusCode)}`);
    log(logs, 'output', `rateLimit: limit=${res.headers['x-ratelimit-limit'] ?? 'n/a'} remaining=${res.headers['x-ratelimit-remaining'] ?? 'n/a'}`);
    if (res.statusCode >= 200 && res.statusCode < 300) {
      return { name: 'github-api', status: 'ok', detail: 'api.github.com reachable.', logs };
    }
    return {
      name: 'github-api',
      status: 'warn',
      detail: `api.github.com returned ${String(res.statusCode)}.`,
      logs
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
    log(logs, 'error', msg);
    if (cause !== undefined) {
      log(logs, 'error', `cause: ${cause}`);
    }
    const proxy = summarizeProxyEnv(ctx.env);
    const hints: string[] = [];
    if (!proxy.configured) {
      hints.push('No proxy env vars set. If behind a corporate proxy, set HTTPS_PROXY (and optionally HTTP_PROXY/NO_PROXY).');
    }
    if (ctx.env.NODE_EXTRA_CA_CERTS === undefined) {
      hints.push('If TLS errors occur behind a corporate proxy, set NODE_EXTRA_CA_CERTS to your custom CA bundle path.');
    }
    const detailParts = [`api.github.com unreachable: ${cause ?? msg}`];
    if (hints.length > 0) {
      detailParts.push(hints.join(' '));
    }
    return {
      name: 'github-api',
      status: 'warn',
      detail: detailParts.join(' '),
      logs
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
  const lines: string[] = ['ai-primitives-hub doctor'];
  for (const c of result.checks) {
    lines.push(`  ${STATUS_GLYPHS[c.status]} ${c.name}: ${c.detail}`);
    if (result.verbose && c.logs !== undefined && c.logs.length > 0) {
      for (const entry of c.logs) {
        lines.push(`         ${entry.level}: ${entry.message}`);
      }
    }
  }
  lines.push(
    '',
    `summary: ${result.summary.ok} ok / ${result.summary.warn} warn / ${result.summary.fail} fail`
  );
  return `${lines.join('\n')}\n`;
};

/**
 * Render diagnostics result as text.
 * @param result Diagnostics result.
 * @returns Formatted text output.
 */
const renderDiagnosticsText = (result: DiagnosticsResult): string => {
  const lines: string[] = [
    'ai-primitives-hub doctor diagnostics',
    `  workspace: ${result.workspace}`,
    `  ${result.ok ? '[ OK ]' : '[FAIL]'} ${result.summary}`,
    ''
  ];
  for (const step of result.steps) {
    lines.push(
      `  ${step.exitCode === 0 ? '[ OK ]' : '[FAIL]'} ${step.name} (exit ${String(step.exitCode)}, ${String(step.durationMs)}ms)`
    );
    if (step.input !== undefined && Object.keys(step.input).length > 0) {
      for (const [k, v] of Object.entries(step.input)) {
        lines.push(`         input: ${k}=${JSON.stringify(v)}`);
      }
    }
    if (step.output !== undefined && Object.keys(step.output).length > 0) {
      for (const [k, v] of Object.entries(step.output)) {
        lines.push(`         output: ${k}=${JSON.stringify(v)}`);
      }
    }
    if (step.stdout.length > 0) {
      lines.push(`         stdout: ${step.stdout.trim()}`);
    }
    if (step.stderr.length > 0) {
      lines.push(`         stderr: ${step.stderr.trim()}`);
    }
  }
  return `${lines.join('\n')}\n`;
};
