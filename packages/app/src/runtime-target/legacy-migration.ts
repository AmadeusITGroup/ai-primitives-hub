/**
 * Guided migration of legacy v2 repository lockfiles to the multi-target v3
 * records. A v2 entry knows its files and checksums but not its harness, so the
 * harness is proposed by matching recorded paths against each harness's
 * repository layout; shared paths need an explicit choice. Only files whose
 * bytes still match their recorded checksum become owned records; modified or
 * missing files are reported and left untouched.
 * @module runtime-target/legacy-migration
 */
import {
  createHash,
} from 'node:crypto';
import * as path from 'node:path';
import {
  runtimeReceiptId,
  TARGET_TYPES,
} from '@ai-primitives-hub/core';
import type {
  RuntimeProjectionReceipt,
  Target,
  TargetType,
} from '@ai-primitives-hub/core';
import {
  resolveLayoutFromLayers,
} from '../install/layout-resolver';
import type {
  RuntimeSessionOptions,
} from './session';

const COMMIT_FILE = 'prompt-registry.lock.json';
const LOCAL_FILE = 'prompt-registry.local.lock.json';
const MIGRATIONS_DIR = 'migrations';
const JOURNAL_FILE = 'migrations.json';

export type LegacyFileStatus = 'match' | 'modified' | 'missing';

export interface LegacyFilePlan {
  path: string;
  status: LegacyFileStatus;
}

export interface LegacyEntryPlan {
  lockfile: 'commit' | 'local-only';
  bundleId: string;
  version: string;
  sourceId: string;
  sourceType: string;
  installedAt: string;
  files: LegacyFilePlan[];
  candidates: TargetType[];
  /** `ready`: one harness; `ambiguous`: a choice is needed; `skipped`: not migrated (see reason). */
  outcome: 'ready' | 'ambiguous' | 'skipped';
  reason?: string;
}

export interface LegacyMigrationPlan {
  workspaceRoot: string;
  lockfiles: { kind: 'commit' | 'local-only'; path: string; version: string }[];
  entries: LegacyEntryPlan[];
  /** Distinct candidate sets that need one choice each. */
  ambiguousSets: TargetType[][];
}

export interface LegacyMigrationResult {
  backup: string;
  backups: string[];
  migrated: { bundleId: string; harness: TargetType; lockfile: 'commit' | 'local-only' }[];
  skipped: { bundleId: string; reason: string }[];
  commitGuidance?: string;
}

interface V2Entry {
  version?: unknown;
  sourceId?: unknown;
  sourceType?: unknown;
  installedAt?: unknown;
  files?: unknown;
}

interface V2Lockfile {
  version?: unknown;
  bundles?: Record<string, V2Entry>;
  sources?: Record<string, { type?: unknown; url?: unknown }>;
}

export const candidateSetKey = (set: readonly TargetType[]): string => set.join(',');

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const toPosix = (value: string): string => value.split(path.sep).join('/');

async function readV2(opts: RuntimeSessionOptions, file: string): Promise<{ text: string; doc: V2Lockfile } | undefined> {
  if (!await opts.fs.exists(file)) {
    return undefined;
  }
  const text = await opts.fs.readFile(file);
  let doc: V2Lockfile;
  try {
    doc = JSON.parse(text) as V2Lockfile;
  } catch {
    return undefined;
  }
  return typeof doc.version === 'string' && doc.version.startsWith('2.') ? { text, doc } : undefined;
}

/**
 * Whether the workspace still holds a legacy v2 lockfile.
 * @param opts
 * @param workspaceRoot
 */
export async function hasLegacyLockfile(opts: Pick<RuntimeSessionOptions, 'fs'>, workspaceRoot: string): Promise<boolean> {
  for (const name of [COMMIT_FILE, LOCAL_FILE]) {
    if (await readV2(opts as RuntimeSessionOptions, path.join(workspaceRoot, name)) !== undefined) {
      return true;
    }
  }
  return false;
}

/**
 * Harnesses whose repository layout owns `relativePath` (workspace-relative, POSIX).
 * @param relativePath
 * @param layouts
 */
function harnessesOwning(relativePath: string, layouts: Map<TargetType, string[]>): TargetType[] {
  return TARGET_TYPES.filter((type) => (layouts.get(type) ?? []).some((dir) => relativePath.startsWith(`${dir}/`)));
}

async function repositoryLayouts(opts: RuntimeSessionOptions, workspaceRoot: string): Promise<Map<TargetType, { dirs: string[]; baseDir: string }>> {
  const layers = await opts.layoutLoader.load();
  const result = new Map<TargetType, { dirs: string[]; baseDir: string }>();
  for (const type of TARGET_TYPES) {
    const target: Target = { name: 'migration', type, scope: 'repository', rootPath: workspaceRoot };
    const layout = resolveLayoutFromLayers(target, layers);
    if (layout === null) {
      continue;
    }
    const base = toPosix(path.relative(workspaceRoot, layout.baseDir));
    const routes = Object.values(layout.kindRoutes ?? {});
    result.set(type, { baseDir: layout.baseDir, dirs: [...new Set(routes.map((route) => `${base}/${route.replace(/\/+$/, '')}`))] });
  }
  return result;
}

/**
 * Build the reviewable migration plan for a workspace (read-only).
 * @param opts
 */
export async function planLegacyLockfileMigration(opts: RuntimeSessionOptions): Promise<LegacyMigrationPlan> {
  if (opts.workspaceRoot === undefined) {
    throw new Error('lockfile migration needs a workspace');
  }
  const workspaceRoot = await opts.fs.realpath(opts.workspaceRoot);
  const layouts = await repositoryLayouts(opts, workspaceRoot);
  const dirsByType = new Map([...layouts].map(([type, value]) => [type, value.dirs]));
  const plan: LegacyMigrationPlan = { workspaceRoot, lockfiles: [], entries: [], ambiguousSets: [] };
  for (const [kind, name] of [['commit', COMMIT_FILE], ['local-only', LOCAL_FILE]] as const) {
    const file = path.join(workspaceRoot, name);
    const v2 = await readV2(opts, file);
    if (v2 === undefined) {
      continue;
    }
    plan.lockfiles.push({ kind, path: file, version: String(v2.doc.version) });
    for (const [bundleId, entry] of Object.entries(v2.doc.bundles ?? {})) {
      const recorded = Array.isArray(entry.files) ? entry.files as { path?: unknown; checksum?: unknown }[] : [];
      const files: LegacyFilePlan[] = [];
      for (const record of recorded) {
        const relative = typeof record.path === 'string' ? record.path : '';
        const expected = typeof record.checksum === 'string' ? record.checksum.replace(/^sha256:/, '') : '';
        const abs = path.resolve(workspaceRoot, relative);
        let status: LegacyFileStatus = 'missing';
        if (relative !== '' && !path.isAbsolute(relative) && !relative.split('/').includes('..') && await opts.fs.exists(abs)) {
          status = sha(await opts.fs.readFileBytes(abs)) === expected ? 'match' : 'modified';
        }
        files.push({ path: relative, status });
      }
      const candidates = files.length === 0
        ? []
        : TARGET_TYPES.filter((type) => files.every((f) => harnessesOwning(f.path, dirsByType).includes(type)));
      const base: LegacyEntryPlan = {
        lockfile: kind,
        bundleId,
        version: str(entry.version),
        sourceId: str(entry.sourceId),
        sourceType: str(entry.sourceType),
        installedAt: str(entry.installedAt),
        files,
        candidates,
        outcome: 'ready'
      };
      const bad = files.filter((f) => f.status !== 'match');
      if (files.length === 0) {
        plan.entries.push({ ...base, outcome: 'skipped', reason: 'no recorded files' });
      } else if (bad.length > 0) {
        plan.entries.push({ ...base, outcome: 'skipped', reason: bad.map((f) => `${f.status}: ${f.path}`).join(', ') });
      } else if (candidates.length === 0) {
        plan.entries.push({ ...base, outcome: 'skipped', reason: 'files match no harness layout' });
      } else if (candidates.length > 1) {
        plan.entries.push({ ...base, outcome: 'ambiguous' });
        if (!plan.ambiguousSets.some((set) => candidateSetKey(set) === candidateSetKey(candidates))) {
          plan.ambiguousSets.push(candidates);
        }
      } else {
        plan.entries.push(base);
      }
    }
  }
  return plan;
}

/**
 * Resolve each ambiguous entry's harness from one choice per candidate set.
 * @param plan
 * @param choices Candidate-set key (comma-joined harness ids) -> chosen harness.
 */
export function resolveMigrationChoices(plan: LegacyMigrationPlan, choices: Record<string, TargetType>): void {
  for (const set of plan.ambiguousSets) {
    const chosen = choices[candidateSetKey(set)];
    if (chosen === undefined || !set.includes(chosen)) {
      throw new Error(`choose a harness for entries matching ${set.join(', ')}`);
    }
  }
}

const payloadIdOf = (entry: LegacyEntryPlan): string =>
  createHash('sha256').update(JSON.stringify(['legacy-v2', entry.sourceId, entry.bundleId, entry.version, entry.files.map((f) => f.path)])).digest('hex');

/**
 * Apply the plan: back up the exact v2 bytes, then publish v3 records through
 * the scoped store (all-or-nothing), then journal the migration.
 * @param opts
 * @param plan
 * @param choices
 */
export async function applyLegacyMigration(
  opts: RuntimeSessionOptions,
  plan: LegacyMigrationPlan,
  choices: Record<string, TargetType> = {}
): Promise<LegacyMigrationResult> {
  resolveMigrationChoices(plan, choices);
  const store = opts.store;
  if (store.publishLegacyMigration === undefined) {
    throw new Error('this store cannot publish migrated lockfiles');
  }
  const layouts = await repositoryLayouts(opts, plan.workspaceRoot);
  const stateDir = opts.storage.getPaths().state;
  if (stateDir === undefined) {
    throw new Error('migration needs a state directory for its backup');
  }
  const result: LegacyMigrationResult = { backup: '', backups: [], migrated: [], skipped: [] };
  const groups = new Map<'commit' | 'local-only', RuntimeProjectionReceipt[]>();
  const sources = new Map<string, { type: string; url: string }>();
  for (const lockfile of plan.lockfiles) {
    const doc = JSON.parse(await opts.fs.readFile(lockfile.path)) as V2Lockfile;
    for (const [id, src] of Object.entries(doc.sources ?? {})) {
      sources.set(id, { type: str(src.type, 'unknown'), url: str(src.url) });
    }
  }
  for (const entry of plan.entries) {
    if (entry.outcome === 'skipped') {
      result.skipped.push({ bundleId: entry.bundleId, reason: entry.reason ?? 'skipped' });
      continue;
    }
    const harness = entry.outcome === 'ready' ? entry.candidates[0] : choices[candidateSetKey(entry.candidates)];
    const layout = layouts.get(harness);
    if (layout === undefined) {
      result.skipped.push({ bundleId: entry.bundleId, reason: `no layout for ${harness}` });
      continue;
    }
    const root = layout.baseDir;
    const outputs: RuntimeProjectionReceipt['outputs'] = {};
    for (const file of entry.files) {
      outputs[path.join(plan.workspaceRoot, file.path)] = {
        sha256: `sha256:${sha(await opts.fs.readFileBytes(path.join(plan.workspaceRoot, file.path)))}`
      };
    }
    const source = sources.get(entry.sourceId);
    const receipt: RuntimeProjectionReceipt = {
      receiptId: runtimeReceiptId(harness, 'repository', root, entry.sourceId, entry.bundleId, plan.workspaceRoot),
      instance: { type: harness, scope: 'repository', root },
      collection: { sourceId: entry.sourceId, manifestId: entry.bundleId },
      payloadId: payloadIdOf(entry),
      version: entry.version,
      outputs,
      installedAt: entry.installedAt,
      contextRoot: plan.workspaceRoot,
      commitMode: entry.lockfile,
      ...(source === undefined ? {} : { source }),
      registryRef: { bundleId: entry.bundleId, sourceType: entry.sourceType }
    };
    groups.set(entry.lockfile, [...groups.get(entry.lockfile) ?? [], receipt]);
    result.migrated.push({ bundleId: entry.bundleId, harness, lockfile: entry.lockfile });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(stateDir, MIGRATIONS_DIR, stamp);
  await opts.fs.mkdir(backupDir, { recursive: true });
  for (const lockfile of plan.lockfiles) {
    const target = path.join(backupDir, path.basename(lockfile.path));
    await opts.fs.writeFileBytes(target, await opts.fs.readFileBytes(lockfile.path));
    result.backups.push(target);
    if (lockfile.kind === 'commit') {
      result.backup = target;
    }
  }
  if (result.backup === '') {
    result.backup = result.backups[0] ?? '';
  }
  await store.withExclusive(() => store.publishLegacyMigration!({
    workspaceRoot: plan.workspaceRoot,
    groups: plan.lockfiles.map((l) => ({ kind: l.kind, receipts: groups.get(l.kind) ?? [] }))
  }));
  const journalPath = path.join(stateDir, JOURNAL_FILE);
  const journal = await opts.fs.exists(journalPath)
    ? JSON.parse(await opts.fs.readFile(journalPath)) as { migrations: unknown[] }
    : { migrations: [] };
  journal.migrations.push({
    at: new Date().toISOString(), workspace: plan.workspaceRoot, backups: result.backups,
    migrated: result.migrated, skipped: result.skipped
  });
  await opts.fs.writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  const committed = plan.lockfiles.some((l) => l.kind === 'commit') && result.migrated.some((m) => m.lockfile === 'commit');
  if (committed && await opts.fs.exists(path.join(plan.workspaceRoot, '.git'))) {
    result.commitGuidance = 'Commit prompt-registry.lock.json: git add prompt-registry.lock.json '
      + '&& git commit -m "Migrate AI Primitives Hub lockfile to v3". '
      + 'Teammates need a version of the extension or CLI that reads the v3 format.';
  }
  return result;
}
