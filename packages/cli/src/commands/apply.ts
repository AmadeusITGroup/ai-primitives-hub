/**
 * `apply` command.
 *
 * Idempotent "make the system match the config" entry point: re-syncs
 * the active hub (unless `--no-sync`) and re-activates whatever profile
 * `ProfileActivationStore` currently records as active, on every
 * configured target.
 *
 * Intended for CI and post-clone developer setup:
 *   ai-primitives-hub apply
 *
 * Reuses `profile.ts`'s `buildHubMgr`/`runProfileActivation` — this
 * command is, in effect, "re-run `profile activate <currentProfileId>`"
 * (see those functions' docs for the write/lockfile/activation-state
 * details). Unlike the reference branch's own `apply.ts`, the "which
 * profile is active" question is answered via `ProfileActivationStore`,
 * not a `lock.useProfile` field — our lockfile schema has no such field
 * (see `stores/json-lockfile-store.ts`'s module doc, and `profile.ts`'s
 * own module doc for why).
 * @module commands/apply
 */
import type {
  HttpClient,
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  Command,
  failWith,
  loadTargets,
  Option,
  requireActiveHubOrFail,
} from '../framework';
import {
  type Context,
  formatOutput,
  type OutputFormat,
  RegistryError,
} from '../framework';
import {
  buildHubMgr,
  runProfileActivation,
} from './profile';

/**
 * Context passed to the apply command's execute method.
 */
interface ApplyCommandContext {
  ctx: Context;
  http?: HttpClient;
  tokens?: TokenProvider;
}

/**
 * `apply` command class.
 */
export class ApplyCommand extends Command {
  public static readonly paths = [['apply']];

  public static readonly usage = Command.Usage({
    description: 'Idempotent: sync active hub and re-activate the currently active profile.',
    category: 'Install & Manage',
    details: `
      Usage: ai-primitives-hub apply [options]

      Options:
        --no-sync                Skip hub sync (useful in offline/CI environments)
        -o, --output <format>     Output format (text, json, yaml, ndjson)

      Examples:
        ai-primitives-hub apply
        ai-primitives-hub apply --no-sync
    `
  });

  public output = Option.String('-o', '--output') as OutputFormat | undefined;
  public noSync = Option.Boolean('--no-sync', false);
  public commandContext!: ApplyCommandContext;

  public async execute(): Promise<number> {
    const { ctx, http, tokens } = this.commandContext;
    const fmt = this.output ?? 'text';
    const built = buildHubMgr(ctx, http, tokens);

    const allActive = await built.activations.listAll();
    const cur = allActive[0];
    if (!cur) {
      return failWith(ctx, fmt, 'apply', new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'apply: no active profile',
        hint: 'Run `ai-primitives-hub profile activate <profileId>` first to activate one.'
      }));
    }

    if (!this.noSync) {
      try {
        await built.mgr.syncHub(cur.hubId);
      } catch {
        ctx.stderr.write(`warn: hub sync failed for "${cur.hubId}", continuing with cached config\n`);
      }
    }

    const active = await requireActiveHubOrFail(built.mgr, cur.hubId, 'apply', ctx, fmt);
    if (typeof active === 'number') {
      return active;
    }
    const profile = active.config.profiles.find((p) => p.id === cur.profileId);
    if (profile === undefined) {
      return failWith(ctx, fmt, 'apply', new RegistryError({
        code: 'BUNDLE.NOT_FOUND',
        message: `apply: profile "${cur.profileId}" not found in hub "${cur.hubId}"`,
        hint: 'Run `ai-primitives-hub profile list` to see available profiles.'
      }));
    }

    const targets = await loadTargets(ctx);
    if (targets.length === 0) {
      return failWith(ctx, fmt, 'apply', new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'apply: no targets configured',
        hint: 'Run `ai-primitives-hub target add <name> --type <kind>` to configure a target.'
      }));
    }

    const { state, written, failures } = await runProfileActivation(ctx, built, cur.hubId, profile, targets);

    const status = failures.length === 0 ? 'ok' : 'warning';
    formatOutput({
      ctx,
      command: 'apply',
      output: fmt,
      status,
      data: {
        hubId: cur.hubId,
        profileId: profile.id,
        synced: !this.noSync,
        state,
        written,
        failures
      },
      warnings: failures.length > 0 ? failures.map((f) => `${f.bundleId} (${f.target}): ${f.reason}`) : undefined,
      textRenderer: (d) => `Applied: hub "${d.hubId}" → profile "${d.profileId}"\n`
        + `  Bundles: ${[...new Set(d.state.syncedBundles)].join(', ')}\n`
        + `  Targets: ${Object.keys(d.written).join(', ')}\n`
        + (d.failures.length > 0
          ? `  Failures:\n${d.failures.map((f) => `    - ${f.bundleId} (${f.target}): ${f.reason}\n`).join('')}`
          : '')
    });
    return failures.length === 0 ? 0 : 1;
  }
}
