/**
 * Managed (target-management) lifecycle for the CLI: thin delivery over the
 * shared runtime target session. No ownership, routing or payload rules live
 * here — only flag parsing, harness/override resolution and envelopes.
 * @module commands/target-managed
 */
import * as path from 'node:path';
import {
  type RuntimeInstallation,
  type RuntimeOperation,
  type RuntimePayloadInput,
  type RuntimeProjectionPlan,
  type RuntimeTargetScope,
  TARGET_TYPES,
  type TargetType,
} from '@ai-primitives-hub/core';
import {
  loadExtractedDirectory,
} from '@ai-primitives-hub/infra';
import {
  type Context,
  formatOutput,
  loadTargets,
  type OutputFormat,
} from '../framework';
import {
  createRuntimeSession,
  runtimeTargetGateError,
} from '../framework/runtime-target';

type Session = Awaited<ReturnType<typeof createRuntimeSession>>;

export const MUTATION_NEEDS_SCOPE = '--scope user|repository is required (the harness selection never carries a scope)';

export interface ManagedFlags {
  output: OutputFormat;
  workspaceRoot?: string;
  global?: boolean;
  scope?: string;
  target?: string;
  sourceId?: string;
  dryRun?: boolean;
  applyPlan?: string;
}

/** Remote acquisition seam supplied by `install`, so the CLI keeps one acquisition path. */
export type AcquireBundle = () => Promise<RuntimePayloadInput>;

const fail = (ctx: Context, fmt: OutputFormat, command: string, error: unknown): number => {
  const code = (error as { code?: string }).code ?? 'TARGET.ERROR';
  const message = (error as Error).message;
  formatOutput({ ctx, command, output: fmt, status: 'error', data: null, errors: [{ code, message }] });
  ctx.stderr.write(`${code}: ${message}\n`);
  return 1;
};

const emit = <T>(ctx: Context, fmt: OutputFormat, command: string, data: T, textRenderer?: (d: T) => string): number => {
  formatOutput({ ctx, command, output: fmt, status: 'ok', data, ...(textRenderer === undefined ? {} : { textRenderer }) });
  return 0;
};

/**
 * Resolve a `<type|name>` argument to a harness type plus its configured override, if any.
 * @param ctx
 * @param arg
 */
export async function resolveHarness(ctx: Context, arg: string): Promise<{ type: TargetType; override?: { name: string; path?: string } }> {
  const configured = await loadTargets(ctx).catch(() => []);
  if ((TARGET_TYPES as readonly string[]).includes(arg)) {
    const type = arg as TargetType;
    const same = configured.filter((t) => t.type === type);
    if (same.length > 1) {
      throw new Error(`multiple configured targets for ${type} (${same.map((t) => t.name).join(', ')}); pass the target name instead`);
    }
    return same.length === 1 ? { type, override: { name: same[0].name, path: same[0].path } } : { type };
  }
  const named = configured.find((t) => t.name === arg);
  if (named === undefined) {
    throw new Error(`unknown target "${arg}": use one of ${TARGET_TYPES.join(', ')} or a configured target name`);
  }
  return { type: named.type, override: { name: named.name, path: named.path } };
}

const gated = async (ctx: Context, fmt: OutputFormat, command: string): Promise<number | null> => {
  const gate = await runtimeTargetGateError(ctx);
  return gate === null ? null : fail(ctx, fmt, command, new Error(gate));
};

const scopeOf = (value: string | undefined): RuntimeTargetScope | undefined =>
  value === 'user' || value === 'repository' ? value : undefined;

const conflictMessage = (plan: RuntimeProjectionPlan): string =>
  `plan has conflicts: ${plan.conflicts.map((c) => `${c.code}${c.path === undefined ? '' : ` ${c.path}`}: ${c.message}`).join('; ')}`;

async function execute(
  ctx: Context,
  command: string,
  session: Session,
  op: RuntimeOperation,
  flags: ManagedFlags
): Promise<number> {
  const fmt = flags.output;
  if (flags.dryRun === true && flags.applyPlan !== undefined) {
    return fail(ctx, fmt, command, new Error('--dry-run and --apply-plan cannot be combined'));
  }
  const plan = await session.plan(op);
  if (flags.dryRun === true) {
    return emit(ctx, fmt, command, plan, (p) => JSON.stringify(p, null, 1));
  }
  if (plan.conflicts.length > 0) {
    return fail(ctx, fmt, command, Object.assign(new Error(conflictMessage(plan)), { code: 'PLAN.CONFLICT' }));
  }
  const result = await session.apply(op, flags.applyPlan ?? plan.hash);
  return emit(ctx, fmt, command, { plan, result }, (d) => `applied: wrote ${d.result.written.length}, removed ${d.result.removed.length}\n`);
}

/**
 * Session for one scoped action, applying a configured user-root override.
 * @param base
 * @param scope
 * @param override
 * @param override.path
 */
function scopedSession(base: Session, scope: RuntimeTargetScope, override?: { path?: string }): Session {
  return scope === 'user' && override?.path !== undefined && path.isAbsolute(override.path)
    ? base.forScope('user', { path: override.path })
    : base.forScope(scope);
}

/**
 * Select the requested harness (or require an existing selection); returns the override for the selected type.
 * @param ctx
 * @param base
 * @param target
 */
async function ensureHarness(ctx: Context, base: Session, target?: string): Promise<{ session: Session; type: TargetType; override?: { name: string; path?: string } }> {
  if (target !== undefined) {
    const resolved = await resolveHarness(ctx, target);
    return { ...resolved, session: base.forTarget(resolved.type) };
  }
  const selected = await base.getSelectedTarget();
  if (selected === undefined) {
    throw new Error('no target harness selected; run `ai-primitives-hub target use <type|name>` first');
  }
  return { ...(await resolveHarness(ctx, selected.type)), session: base };
}

/**
 * `install --from <dir>` / `install <bundle> --source <id>` on the shared session.
 * @param ctx
 * @param flags
 * @param input
 * @param input.from
 * @param input.acquire
 */
export async function runManagedInstall(ctx: Context, flags: ManagedFlags, input: { from?: string; acquire?: AcquireBundle }): Promise<number> {
  const command = 'install';
  const scope = scopeOf(flags.scope);
  if (scope === undefined) {
    return fail(ctx, flags.output, command, new Error(`install: ${MUTATION_NEEDS_SCOPE}`));
  }
  try {
    const base = await createRuntimeSession(ctx, { workspaceRoot: flags.workspaceRoot, global: flags.global });
    const harness = await ensureHarness(ctx, base, flags.target);
    let payload: RuntimePayloadInput;
    if (input.from === undefined) {
      payload = await input.acquire!();
    } else {
      const abs = path.resolve(ctx.cwd(), input.from);
      const { files, manifest } = await loadExtractedDirectory(abs);
      payload = { files, manifest, sourceId: flags.sourceId ?? 'local', source: { type: 'local', url: abs } };
    }
    return await execute(ctx, command, scopedSession(harness.session, scope, harness.override), { kind: 'install', payload }, flags);
  } catch (error) {
    return fail(ctx, flags.output, command, error);
  }
}

async function resolveRow(session: Session, input: { installationId?: string; bundle?: string; scope?: RuntimeTargetScope }): Promise<RuntimeInstallation> {
  const rows = await session.listInstallations();
  if (input.installationId !== undefined) {
    const row = rows.find((r) => r.installationId === input.installationId);
    if (row === undefined) {
      throw new Error(`no installation ${input.installationId} for the selected harness in this workspace`);
    }
    return row;
  }
  const matches = rows.filter((r) => r.instance.scope === input.scope
    && (r.manifestId === input.bundle || r.registryRef?.bundleId === input.bundle));
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? `${input.bundle} is not installed at ${input.scope} scope for the selected harness`
      : `${input.bundle} matches ${matches.length} installations at ${input.scope} scope; pass --installation-id`);
  }
  return matches[0];
}

/**
 * `update --from <dir> (--installation-id <id> | <bundle> --scope <s>)`.
 * @param ctx
 * @param flags
 * @param input
 * @param input.from
 * @param input.bundle
 * @param input.installationId
 */
export async function runManagedUpdate(ctx: Context, flags: ManagedFlags, input: { from?: string; bundle?: string; installationId?: string }): Promise<number> {
  const command = 'update';
  const scope = scopeOf(flags.scope);
  if (input.installationId === undefined && (scope === undefined || input.bundle === undefined)) {
    return fail(ctx, flags.output, command, new Error(`update: pass --installation-id <id>, or <bundle> with ${MUTATION_NEEDS_SCOPE}`));
  }
  if (input.from === undefined) {
    return fail(ctx, flags.output, command, new Error('update: --from <dir> is required for target-managed updates'));
  }
  try {
    const base = await createRuntimeSession(ctx, { workspaceRoot: flags.workspaceRoot, global: flags.global });
    const picked = await ensureHarness(ctx, base, flags.target);
    const row = await resolveRow(picked.session, { installationId: input.installationId, bundle: input.bundle, scope });
    const abs = path.resolve(ctx.cwd(), input.from);
    const { files, manifest } = await loadExtractedDirectory(abs);
    const payload: RuntimePayloadInput = { files, manifest, sourceId: row.sourceId, source: { type: 'local', url: abs } };
    const harness = await resolveHarness(ctx, row.instance.type);
    return await execute(ctx, command, scopedSession(picked.session, row.instance.scope, harness.override),
      { kind: 'update', payload, installationId: row.installationId }, flags);
  } catch (error) {
    return fail(ctx, flags.output, command, error);
  }
}

/**
 * `uninstall (<bundle> --scope <s> | --installation-id <id>)`.
 * @param ctx
 * @param flags
 * @param input
 * @param input.bundle
 * @param input.installationId
 */
export async function runManagedUninstall(ctx: Context, flags: ManagedFlags, input: { bundle?: string; installationId?: string }): Promise<number> {
  const command = 'uninstall';
  const scope = scopeOf(flags.scope);
  if (input.installationId === undefined && (scope === undefined || input.bundle === undefined)) {
    return fail(ctx, flags.output, command, new Error(`uninstall: pass --installation-id <id>, or <bundle> with ${MUTATION_NEEDS_SCOPE}`));
  }
  try {
    const base = await createRuntimeSession(ctx, { workspaceRoot: flags.workspaceRoot, global: flags.global });
    const picked = await ensureHarness(ctx, base, flags.target);
    const row = await resolveRow(picked.session, { installationId: input.installationId, bundle: input.bundle, scope });
    const harness = await resolveHarness(ctx, row.instance.type);
    return await execute(ctx, command, scopedSession(picked.session, row.instance.scope, harness.override),
      { kind: 'uninstall', sourceId: row.sourceId, manifestId: row.manifestId, installationId: row.installationId }, flags);
  } catch (error) {
    return fail(ctx, flags.output, command, error);
  }
}

/**
 * `installed`: scope-spanning rows for the selected harness.
 * @param ctx
 * @param flags
 */
export async function runInstalled(ctx: Context, flags: ManagedFlags): Promise<number> {
  const command = 'installed';
  const off = await gated(ctx, flags.output, command);
  if (off !== null) {
    return off;
  }
  try {
    const base = await createRuntimeSession(ctx, { workspaceRoot: flags.workspaceRoot, global: flags.global });
    const rows = await base.listInstallations();
    return emit(ctx, flags.output, command, rows, (d) => d.length === 0
      ? 'No installations for the selected harness.\n'
      : `${d.map((r) => `${r.manifestId}@${r.version}  ${r.instance.type}/${r.instance.scope}  ${r.installationId}`).join('\n')}\n`);
  } catch (error) {
    return fail(ctx, flags.output, command, error);
  }
}

/**
 * `target use <type|name> [--global]`.
 * @param ctx
 * @param flags
 * @param arg
 */
export async function runTargetUse(ctx: Context, flags: ManagedFlags, arg: string): Promise<number> {
  const command = 'target.use';
  const off = await gated(ctx, flags.output, command);
  if (off !== null) {
    return off;
  }
  try {
    const resolved = await resolveHarness(ctx, arg);
    const base = await createRuntimeSession(ctx, { workspaceRoot: flags.workspaceRoot, global: flags.global });
    const active = await base.selectTarget({ type: resolved.type, userDefault: flags.global === true });
    return emit(ctx, flags.output, command, { type: resolved.type, selection: active.selection, ...(resolved.override === undefined ? {} : { override: resolved.override }) },
      (d) => `Selected ${d.type} (${d.selection})\n`);
  } catch (error) {
    return fail(ctx, flags.output, command, error);
  }
}

/**
 * `target current [-o json]`.
 * @param ctx
 * @param flags
 */
export async function runTargetCurrent(ctx: Context, flags: ManagedFlags): Promise<number> {
  const command = 'target.current';
  const off = await gated(ctx, flags.output, command);
  if (off !== null) {
    return off;
  }
  try {
    const base = await createRuntimeSession(ctx, { workspaceRoot: flags.workspaceRoot, global: flags.global });
    const selected = await base.getSelectedTarget();
    if (selected === undefined) {
      return fail(ctx, flags.output, command, new Error('no target harness selected; run `ai-primitives-hub target use <type|name>`'));
    }
    return emit(ctx, flags.output, command, selected, (d) => `${d.type} (${d.selection})\n`);
  } catch (error) {
    return fail(ctx, flags.output, command, error);
  }
}

/**
 * Gate-on `target list`: the 11 harnesses, the selected marker and configured overrides.
 * @param ctx
 * @param flags
 */
export async function runTargetList(ctx: Context, flags: ManagedFlags): Promise<number> {
  const command = 'target.list';
  try {
    const base = await createRuntimeSession(ctx, { workspaceRoot: flags.workspaceRoot, global: flags.global });
    const selected = await base.getSelectedTarget();
    const configured = await loadTargets(ctx).catch(() => []);
    const rows = TARGET_TYPES.map((type) => {
      const overrides = configured.filter((t) => t.type === type)
        .map((t) => ({ name: t.name, ...(t.path === undefined ? {} : { path: t.path }), ...(t.allowedKinds === undefined ? {} : { allowedKinds: t.allowedKinds }) }));
      return {
        type,
        selected: selected?.type === type,
        configured: overrides,
        ...(overrides.length > 1 ? { warning: `multiple configured targets for ${type}: ${overrides.map((o) => o.name).join(', ')}` } : {})
      };
    });
    const line = (r: (typeof rows)[number]): string => {
      const names = r.configured.length > 0 ? `  [${r.configured.map((c) => c.name).join(', ')}]` : '';
      const warning = r.warning === undefined ? '' : `  WARNING: ${r.warning}`;
      return `${r.selected ? '*' : ' '} ${r.type}${names}${warning}`;
    };
    return emit(ctx, flags.output, command, rows, (d) => `${d.map((r) => line(r)).join('\n')}\n`);
  } catch (error) {
    return fail(ctx, flags.output, command, error);
  }
}

/**
 * `lockfile migrate [--dry-run] [--harness <type>]`: guided v2 to v3 migration.
 * @param ctx
 * @param flags
 * @param input
 * @param input.harness
 */
export async function runLockfileMigrate(ctx: Context, flags: ManagedFlags, input: { harness?: string }): Promise<number> {
  const command = 'lockfile.migrate';
  const off = await gated(ctx, flags.output, command);
  if (off !== null) {
    return off;
  }
  try {
    const base = await createRuntimeSession(ctx, { workspaceRoot: flags.workspaceRoot, global: flags.global });
    const plan = await base.planLegacyMigration();
    if (plan.lockfiles.length === 0) {
      return fail(ctx, flags.output, command, new Error('no legacy v2 lockfile found in this workspace'));
    }
    if (flags.dryRun === true) {
      return emit(ctx, flags.output, command, plan, (p) => JSON.stringify(p, null, 1));
    }
    const choices: Record<string, TargetType> = {};
    for (const set of plan.ambiguousSets) {
      const harness = input.harness as TargetType | undefined;
      if (harness === undefined || !set.includes(harness)) {
        throw new Error(`ambiguous harness for entries matching ${set.join(', ')}: pass --harness <type> with one of these candidates`);
      }
      choices[set.join(',')] = harness;
    }
    const result = await base.applyLegacyMigration(plan, choices);
    return emit(ctx, flags.output, command, result, (r) => `migrated ${r.migrated.length}, skipped ${r.skipped.length}; v2 backup: ${r.backup}\n${r.commitGuidance ?? ''}\n`);
  } catch (error) {
    return fail(ctx, flags.output, command, error);
  }
}
