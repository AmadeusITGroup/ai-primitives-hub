/**
 * `prompt-registry init` — zero-friction project bootstrap.
 *
 * Creates a target and optionally imports a hub in a single step,
 * replacing the 6-command manual sequence a new user previously needed.
 *
 * Interactive wizard mode: prompts for IDE, target, and hub connection.
 * Non-interactive mode: accepts flags for all values so it works well in CI.
 *
 * Usage:
 *   prompt-registry init
 *   prompt-registry init --target-name copilot --target-type copilot-cli --hub owner/repo --yes
 */
import * as path from 'node:path';
import {
  resolveUserConfigPaths,
} from '@prompt-registry/app';
import {
  HttpClient,
  TARGET_TYPES,
  type TargetType,
} from '@prompt-registry/core';
import type {
  TokenProvider,
} from '@prompt-registry/infra';
import {
  addTarget,
  addTargetToPath,
  findProjectConfigPath,
  getEnabledDefaultHubs,
  readTargets,
  writeLockfile,
  writeTargets,
} from '@prompt-registry/infra';
import inquirer from 'inquirer';
import {
  Command,
  type CommandDefinition,
  type Context,
  createHubManager,
  defineCommand,
  formatOutput,
  Option,
  type OutputFormat,
  RegistryError,
  renderError,
} from '../framework';

type TargetScope = 'user' | 'repository';
type HubType = 'github' | 'local' | 'url';

const DEFAULT_TARGET_NAME = 'copilot';
const DEFAULT_TARGET_TYPE: TargetType = 'copilot-cli';

/**
 * Get human-readable display name for a target type.
 * @param type Target type.
 * @returns Display name.
 */
function getTargetTypeDisplayName(type: TargetType): string {
  const displayNames: Record<TargetType, string> = {
    vscode: 'Visual Studio Code',
    'vscode-insiders': 'Visual Studio Code Insiders',
    'copilot-cli': 'GitHub Copilot CLI',
    kiro: 'Kiro IDE',
    windsurf: 'Windsurf Editor',
    'claude-code': 'Anthropic Claude Code'
  };
  return displayNames[type];
}

/** Options for the init command (programmatic API + test seam). */
export interface InitOptions {
  /** Output format (default: text). */
  output?: string;
  /** Target name (default: 'copilot'). */
  targetName?: string;
  /** Target type (default: 'copilot-cli'). */
  targetType?: string;
  /** Target scope (default: 'user'). */
  scope?: TargetScope;
  /** Hub location ref (e.g. owner/repo or file:./hub-config.yml). */
  hub?: string;
  /** Hub type override (default: auto-detect from ref). */
  hubType?: HubType;
  /** Skip confirmation prompt. */
  yes?: boolean;
  /** Verbose output with file paths and verification commands. */
  verbose?: boolean;
  /** HTTP client seam for testing. */
  http?: HttpClient;
  /** Token provider seam for testing. */
  tokens?: TokenProvider;
}

/**
 * Build the `init` command (defineCommand variant for test compatibility).
 * @param opts Command options.
 * @returns CommandDefinition.
 */
export const createInitCommand = (
  opts: InitOptions = {}
): CommandDefinition =>
  defineCommand({
    path: ['init'],
    description: 'Bootstrap a project: add a target and optionally import a hub.',
    category: 'Getting Started',
    run: async ({ ctx }: { ctx: Context }): Promise<number> => {
      return runInit(ctx, opts);
    }
  });

/**
 * Init command class (clipanion variant).
 */
export class InitCommand extends Command {
  public static readonly paths = [['init']];

  public static readonly usage = Command.Usage({
    description: 'Bootstrap a project: add a target and optionally import a hub.',
    category: 'Getting Started',
    details: `
      Usage: prompt-registry init [options]

      Creates a target in prompt-registry.yml and optionally imports a hub,
      replacing the manual multi-step setup sequence.

      Examples:
        prompt-registry init
        prompt-registry init --target-name my-copilot --target-type copilot-cli --yes
        prompt-registry init --hub owner/repo --yes
        prompt-registry init --hub file:./hub-config.yml --hub-type local --yes
    `
  });

  public targetName = Option.String('--target-name');
  public targetType = Option.String('--target-type');
  public scope = Option.String('--scope');
  public hub = Option.String('--hub');
  public hubType = Option.String('--hub-type');
  public yes = Option.Boolean('-y,--yes', false);
  public output = Option.String('-o,--output');
  public verbose = Option.Boolean('-v,--verbose', false);
  public commandContext!: { ctx: Context; http?: HttpClient; tokens?: TokenProvider };

  public async execute(): Promise<number> {
    const { ctx, http, tokens } = this.commandContext;
    return runInit(ctx, {
      output: (this.output ?? 'text'),
      targetName: this.targetName,
      targetType: this.targetType,
      scope: this.scope as TargetScope | undefined,
      hub: this.hub,
      hubType: this.hubType as HubType | undefined,
      yes: this.yes,
      verbose: this.verbose,
      http,
      tokens
    });
  }
}

/**
 * Build hub choices for the wizard.
 * Amadeus hub is always placed first.
 * @param _ctx CLI context.
 * @param _opts Init options.
 * @returns Array of hub choices.
 */
function buildHubChoices(
  _ctx: Context,
  _opts: InitOptions
): { name: string; value: string }[] {
  const defaultHubs = getEnabledDefaultHubs();
  const hubChoices: { name: string; value: string }[] = [];

  // Separate Amadeus from other hubs
  const amadeusHub = defaultHubs.find((h) => h.name === 'Amadeus');
  const otherHubs = defaultHubs.filter((h) => h.name !== 'Amadeus');

  // Build choices with Amadeus first
  if (amadeusHub) {
    hubChoices.push({
      name: `${amadeusHub.icon} ${amadeusHub.name}${amadeusHub.recommended ? ' ⭐' : ''}`,
      value: amadeusHub.name
    });
  }

  for (const hub of otherHubs) {
    hubChoices.push({
      name: `${hub.icon} ${hub.name}${hub.recommended ? ' ⭐' : ''}`,
      value: hub.name
    });
  }

  return hubChoices;
}

/**
 * Run interactive wizard to collect init options.
 * @param ctx CLI context.
 * @param _opts Init options.
 * @returns Wizard answers.
 */
async function runInteractiveWizard(ctx: Context, _opts: InitOptions): Promise<{
  targetType: TargetType;
  targetName: string;
  targetScope: TargetScope;
  hubRef?: string;
  hubType?: HubType;
  hubRefParam?: string;
}> {
  interface WizardAnswers {
    ide: string;
    scope?: TargetScope;
    connectHub: boolean;
    hubChoice?: string;
    hubPath?: string;
    useExistingTarget?: boolean;
    newTargetName?: string;
  }

  const defaultHubs = getEnabledDefaultHubs();
  const hubChoices = buildHubChoices(ctx, _opts);

  const baseChoices = hubChoices.length > 0
    ? hubChoices
    : [{ name: 'Local directory', value: 'local' }];

  const allHubChoices = [
    ...baseChoices,
    { name: 'Local directory', value: 'local' },
    { name: 'Skip for now', value: 'skip' }
  ];

  const answers = await inquirer.prompt<WizardAnswers>([
    {
      type: 'list',
      name: 'ide',
      message: 'What IDE are you using?',
      choices: TARGET_TYPES.map((type) => ({
        name: getTargetTypeDisplayName(type),
        value: type
      })),
      default: 'copilot-cli'
    },
    {
      type: 'list',
      name: 'scope',
      message: 'Installation scope:',
      choices: [
        { name: 'User scope (installed in home directory)', value: 'user' },
        { name: 'Project scope (installed in current project)', value: 'repository' }
      ],
      default: 'user'
    },
    {
      type: 'confirm',
      name: 'connectHub',
      message: 'Connect to a hub? (recommended)',
      default: true
    },
    {
      type: 'list',
      name: 'hubChoice',
      message: 'Select hub:',
      choices: allHubChoices,
      default: hubChoices.length > 0 ? hubChoices[0].value : 'skip',
      when: (a: { connectHub: boolean }) => a.connectHub
    },
    {
      type: 'input',
      name: 'hubPath',
      message: 'Enter local hub path:',
      default: './hub-config.yml',
      when: (a: { hubChoice: string }) => a.hubChoice === 'local'
    }
  ]);

  const targetType = answers.ide as TargetType;
  let targetName = DEFAULT_TARGET_NAME;
  const targetScope = answers.scope ?? 'user';

  const currentTargets = await readTargets({ cwd: ctx.cwd(), fs: ctx.fs });
  const targetExists = currentTargets.some((t) => t.name === targetName);

  if (targetExists) {
    const targetAnswers = await inquirer.prompt<WizardAnswers>([
      {
        type: 'confirm',
        name: 'useExistingTarget',
        message: `Target "${targetName}" already exists. Use it anyway?`,
        default: true
      },
      {
        type: 'input',
        name: 'newTargetName',
        message: 'Enter a different target name:',
        default: 'copilot-2',
        when: (a: { useExistingTarget: boolean }) => !a.useExistingTarget
      }
    ]);

    if (!targetAnswers.useExistingTarget) {
      targetName = targetAnswers.newTargetName || targetName;
    }
  }

  let hubRef: string | undefined;
  let hubType: HubType | undefined;
  let hubRefParam: string | undefined;

  if (answers.hubChoice === 'local' && answers.hubPath) {
    hubRef = `file:${answers.hubPath}`;
    hubType = 'local';
  } else if (answers.hubChoice && answers.hubChoice !== 'skip') {
    const hub = defaultHubs.find((h) => h.name === answers.hubChoice);
    if (hub) {
      hubRef = hub.reference.location;
      hubType = hub.reference.type;
      hubRefParam = hub.reference.ref;
    }
  }

  return { targetType, targetName, targetScope, hubRef, hubType, hubRefParam };
}

/**
 * Create or reuse target.
 * @param ctx CLI context.
 * @param targetName Target name.
 * @param targetType Target type.
 * @param targetScope Target scope.
 * @param explicitPath Absolute path to the targets file; bypasses the upward walk when set.
 * @returns Target file path and creation status.
 */
async function createOrReuseTarget(
  ctx: Context,
  targetName: string,
  targetType: TargetType,
  targetScope: 'user' | 'repository',
  explicitPath?: string
): Promise<{ file: string; created?: boolean; updated?: boolean }> {
  const storeOpts = { cwd: ctx.cwd(), fs: ctx.fs };

  if (explicitPath !== undefined) {
    const result = await addTargetToPath(
      explicitPath,
      { name: targetName, type: targetType, scope: targetScope },
      ctx.fs
    );
    return result;
  }

  const currentTargets = await readTargets(storeOpts);
  const existing = currentTargets.find((t) => t.name === targetName);

  if (existing !== undefined) {
    if ((existing.type as string) !== (targetType as string) || existing.scope !== targetScope) {
      const next = currentTargets.map((t) =>
        t.name === targetName ? { ...t, type: targetType, scope: targetScope } : t
      );
      const writeResult = await writeTargets(storeOpts, next);
      return { ...writeResult, updated: true };
    }
    const { file } = await findProjectConfigPath(storeOpts);
    return { file, created: false };
  }

  return await addTarget(
    storeOpts,
    { name: targetName, type: targetType, scope: targetScope }
  );
}

/**
 * Import and sync hub.
 * @param ctx CLI context.
 * @param hubRef Hub reference location.
 * @param hubType Hub reference type.
 * @param hubRefParam Hub reference ref (branch/tag).
 * @param opts Init options.
 * @returns Hub ID or null.
 */
async function importAndSyncHub(
  ctx: Context,
  hubRef: string,
  hubType: HubType | undefined,
  hubRefParam: string | undefined,
  opts: InitOptions
): Promise<string | null> {
  const mgr = createHubManager({ ctx, http: opts.http, tokens: opts.tokens });
  const refType = hubType ?? opts.hubType ?? inferHubType(hubRef);
  const location = refType === 'local' && !path.isAbsolute(hubRef)
    ? path.resolve(ctx.cwd(), hubRef)
    : hubRef;
  const ref = hubRefParam;

  const hubId = await mgr.importHub({ type: refType, location, ref });
  await mgr.syncHub(hubId);
  return hubId;
}

function describeTargetStep(name: string, type: string, file: string, created: boolean, updated: boolean): string {
  if (created) {
    return `target "${name}" (${type}) → ${file}`;
  }
  if (updated) {
    return `target "${name}" updated to type "${type}"`;
  }
  return `target "${name}" already exists`;
}

/**
 * Build text renderer output for init command.
 * @param data Init result data.
 * @param data.steps Initialization steps.
 * @param data.target Target configuration.
 * @param data.target.file
 * @param data.target.name
 * @param data.target.type
 * @param data.hub Hub configuration.
 * @param verbose Verbose flag.
 * @returns Formatted text output.
 */
function buildInitOutput(data: { steps: string[]; target: { file: string; name: string; type: string }; hub: { id: string } | null }, verbose: boolean): string {
  const lines = ['Initialized prompt-registry project:\n'];
  for (const step of data.steps) {
    lines.push(`  ✓ ${step}\n`);
  }

  if (verbose) {
    lines.push('\nConfiguration:\n', `  Config file: ${data.target.file}\n`, `  Target name: ${data.target.name}\n`, `  Target type: ${data.target.type}\n`);
    if (data.hub !== null) {
      lines.push(`  Hub ID: ${data.hub.id}\n`);
    }
    lines.push('\nVerification commands:\n', '  prompt-registry status\n', '  prompt-registry target list\n');
    if (data.hub !== null) {
      lines.push('  prompt-registry hub list\n', '  prompt-registry profile list\n');
    }
  }

  if (data.hub === null) {
    lines.push(
      '\nNext steps:\n',
      '  1. prompt-registry hub add <owner/repo> --yes\n',
      '  2. prompt-registry profile activate <profileId>\n'
    );
  } else {
    if (verbose) {
      lines.push('\nAvailable profiles:\n', '  Run: prompt-registry profile list\n');
    }
    lines.push('\nNext step:\n', '  prompt-registry profile activate <profileId>\n');
  }
  return lines.join('');
}

function classifyInitError(cause: unknown): RegistryError {
  if (cause instanceof RegistryError) {
    return cause;
  }
  const msg = cause instanceof Error ? cause.message : String(cause);
  const err = cause instanceof Error ? cause : undefined;
  if (msg.includes('hub-config.yml not found at')) {
    return new RegistryError({
      code: 'HUB.ACCESS_DENIED',
      message: `Cannot access hub: ${msg}`,
      hint: 'Run `gh auth status` to check which account is active. Use `gh auth switch` to select an account with access, or choose a different hub.',
      cause: err
    });
  }
  const isAuthError = msg.includes('401')
    || msg.includes('403')
    || msg.toLowerCase().includes('unauthorized')
    || msg.toLowerCase().includes('forbidden')
    || msg.toLowerCase().includes('authentication failed');
  if (isAuthError) {
    return new RegistryError({
      code: 'AUTH.ERROR',
      message: `Failed to connect to hub: ${msg}`,
      hint: 'Check your GitHub authentication with `gh auth status` or `gh auth login`',
      cause: err
    });
  }
  return new RegistryError({
    code: 'INTERNAL.UNEXPECTED',
    message: `Failed to initialize project: ${msg}`,
    hint: 'Run `prompt-registry doctor` for diagnostics',
    cause: err
  });
}

/**
 * Core init logic shared by both command variants.
 * @param ctx CLI context.
 * @param opts Init options.
 * @returns Exit code.
 */
async function runInit(ctx: Context, opts: InitOptions): Promise<number> {
  const fmt = (opts.output ?? 'text') as OutputFormat;
  const isInteractive = !opts.yes && process.stdout.isTTY;

  const userPaths = resolveUserConfigPaths(ctx.env);
  let targetName = opts.targetName ?? DEFAULT_TARGET_NAME;
  let targetType = (opts.targetType ?? DEFAULT_TARGET_TYPE) as TargetType;
  let targetScope = (opts.scope as TargetScope) ?? 'user';
  let hubRef = opts.hub;
  let hubType: HubType | undefined = opts.hubType;
  let hubRefParam: string | undefined;

  if (isInteractive) {
    const wizardResult = await runInteractiveWizard(ctx, opts);
    targetType = wizardResult.targetType;
    targetName = wizardResult.targetName;
    targetScope = wizardResult.targetScope;
    hubRef = wizardResult.hubRef;
    hubType = wizardResult.hubType;
    hubRefParam = wizardResult.hubRefParam;
  }

  if (!TARGET_TYPES.includes(targetType)) {
    return failWith(ctx, fmt, new RegistryError({
      code: 'USAGE.MISSING_FLAG',
      message: `init: unknown --target-type "${targetType}"`,
      hint: `Known types: ${[...TARGET_TYPES].toSorted((a, b) => a.localeCompare(b)).join(', ')}`
    }));
  }

  try {
    const configPath = targetScope === 'user' ? userPaths.userTargets : undefined;
    const result = await createOrReuseTarget(ctx, targetName, targetType, targetScope, configPath);
    const updated = result.updated === true;
    const steps: string[] = [
      describeTargetStep(targetName, targetType, result.file, result.created ?? false, updated)
    ];

    const lockfilePath = targetScope === 'user'
      ? userPaths.userLockfile
      : path.join(ctx.cwd(), 'prompt-registry.lock.json');
    if (!(await ctx.fs.exists(lockfilePath))) {
      await writeLockfile(lockfilePath, { schemaVersion: 1, entries: [] }, ctx.fs);
      steps.push(`lockfile initialized: ${path.basename(lockfilePath)}`);
    }

    let hubId: string | null = null;
    if (hubRef !== undefined && hubRef.length > 0) {
      hubId = await importAndSyncHub(ctx, hubRef, hubType, hubRefParam, opts);
      steps.push(`hub "${hubId}" imported and synced`);
    }

    const data = {
      target: {
        name: targetName,
        type: targetType,
        file: result.file,
        created: result.created ?? false
      },
      hub: hubId === null ? null : { id: hubId },
      steps
    };

    formatOutput({
      ctx,
      command: 'init',
      output: fmt,
      status: 'ok',
      data,
      textRenderer: (d) => buildInitOutput(d, opts.verbose ?? false)
    });
    return 0;
  } catch (cause) {
    return failWith(ctx, fmt, classifyInitError(cause));
  }
}

/**
 * Infer hub reference type from the location string.
 * - Starts with `file:` or is an absolute path → local
 * - Starts with `http` → url
 * - Otherwise → github (owner/repo)
 * @param location Hub reference string.
 * @returns Inferred reference type.
 */
function inferHubType(location: string): HubType {
  if (location.startsWith('file:') || path.isAbsolute(location)) {
    return 'local';
  }
  if (location.startsWith('http://') || location.startsWith('https://')) {
    return 'url';
  }
  return 'github';
}

/**
 * Emit error in appropriate format.
 * @param ctx CLI context.
 * @param output Output format.
 * @param err Registry error.
 * @returns Exit code 1.
 */
function failWith(ctx: Context, output: OutputFormat, err: RegistryError): number {
  if (output === 'json' || output === 'yaml' || output === 'ndjson') {
    formatOutput({
      ctx,
      command: 'init',
      output,
      status: 'error',
      data: null,
      errors: [err.toJSON()]
    });
  } else {
    renderError(err, ctx);
  }
  return 1;
}
