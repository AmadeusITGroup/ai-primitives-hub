/**
 * Target-management store. Installation records live in scope lockfiles (the
 * installation authority); everything else is kept beside, never inside, them:
 * harness selection and the mutation lock under the XDG state directory,
 * payload snapshots and imports under the XDG data directory.
 *
 * | Data               | Location                                              |
 * | ------------------ | ----------------------------------------------------- |
 * | repository records | `<workspace>/prompt-registry[.local].lock.json`       |
 * | user records       | `<data>/ai-primitives-hub.lock.json`                  |
 * | selection, index   | `<state>/target-selection.json`                       |
 * | payload snapshots  | `<data>/payloads/<payloadId>/`                        |
 * | imports            | `<data>/imports.json`                                 |
 * | mutation lock      | `<state>/mutation.lock`                               |
 * @module runtime-target/scoped-runtime-target-store
 */
/* eslint-disable @typescript-eslint/member-ordering -- private helpers grouped with their public methods. */
import {
  randomUUID,
} from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import * as path from 'node:path';
import {
  type AppStorage,
  decodeLockfileV3,
  emptyRuntimeTargetState,
  encodeLockfileV3,
  inspectLegacyV2,
  LOCKFILE_V3_FILENAME,
  type RuntimeImportRef,
  type RuntimeLockfileRecords,
  type RuntimeMultiTargetLockfile,
  type RuntimePayloadSnapshot,
  type RuntimePlanConflict,
  type RuntimeProjectionReceipt,
  type RuntimeTargetInstance,
  type RuntimeTargetState,
  type RuntimeTargetStore,
  validateRuntimeTargetState,
} from '@ai-primitives-hub/core';
import {
  PayloadStore,
} from './payload-store';

const REPO_FILE = 'prompt-registry.lock.json';
const LOCAL_FILE = 'prompt-registry.local.lock.json';
const SELECTION_FILE = 'target-selection.json';
const IMPORTS_FILE = 'imports.json';
const LOCK_FILE = 'mutation.lock';
const PAYLOADS_DIR = 'payloads';
const SELECTION_KEYS = new Set(['workspaces', 'userDefault', 'revision', 'repositories']);

type Receipt = RuntimeProjectionReceipt;
interface Authority {
  file: string;
  root: string;
  scope: 'user' | 'repository';
  text: string;
  records: RuntimeLockfileRecords;
}
interface View {
  state: RuntimeTargetState;
  user: Receipt[];
  authorities: Map<string, Authority>;
  legacy: Set<string>;
  repositories: string[];
  selectionText?: string;
  importsText?: string;
  /** False when an indexed repository could not be read, so unreferenced payloads must not be pruned. */
  complete: boolean;
  workspace?: string;
}
interface Publication { file: string; root: string; text: string }

const inside = (root: string, target: string): boolean => {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};
const isNotFound = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
const sortedReceipts = (receipts: Receipt[]): Receipt[] => receipts.toSorted((a, b) => a.receiptId.localeCompare(b.receiptId));
const semantic = (receipts: Receipt[]): string => JSON.stringify({
  ...encodeLockfileV3({ receipts: Object.fromEntries(sortedReceipts(receipts).map((r) => [r.receiptId, r])) }, ''),
  generatedAt: ''
});
const sortKeys = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(record).toSorted(([a], [b]) => a.localeCompare(b)));

export interface ScopedRuntimeTargetStoreOptions {
  storage: Pick<AppStorage, 'getPaths'>;
  workspaceRoot?: string;
  /** Tool version recorded in `generatedBy` (`ai-primitives-hub@<version>`). */
  toolVersion?: string;
  /** Native filesystem boundary, injectable for publication-failure tests. */
  fileSystem?: typeof nodeFs;
}

export class ScopedRuntimeTargetStore implements RuntimeTargetStore {
  public readonly statePath: string;
  public readonly lockPath: string;
  public readonly selectionPath: string;
  public readonly importsPath: string;
  private readonly fs: typeof nodeFs;
  private readonly userRoot: string;
  private readonly stateDir: string;
  private readonly payloads: PayloadStore;
  private readonly generatedBy: string;

  public constructor(private readonly options: ScopedRuntimeTargetStoreOptions) {
    const paths = options.storage.getPaths();
    if (paths.state === undefined) {
      throw new Error('target management needs a storage that provides a state directory (XDG_STATE_HOME)');
    }
    this.userRoot = path.resolve(paths.root);
    this.stateDir = path.resolve(paths.state);
    this.statePath = path.join(this.userRoot, LOCKFILE_V3_FILENAME);
    this.lockPath = path.join(this.stateDir, LOCK_FILE);
    this.selectionPath = path.join(this.stateDir, SELECTION_FILE);
    this.importsPath = path.join(this.userRoot, IMPORTS_FILE);
    this.fs = options.fileSystem ?? nodeFs;
    this.payloads = new PayloadStore(path.join(this.userRoot, PAYLOADS_DIR), this.fs);
    this.generatedBy = `ai-primitives-hub@${options.toolVersion ?? 'unknown'}`;
  }

  public async withExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.fs.mkdir(this.stateDir, { recursive: true });
    const token = `${process.pid}.${randomUUID()}`;
    let handle: nodeFs.FileHandle;
    try {
      handle = await this.fs.open(this.lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`target state is locked by another operation at ${this.lockPath}; retry after it completes`);
      }
      throw error;
    }
    // Identity of the lock inode we created — captured while the fd is known
    // valid; cleanup removes the path only if it still refers to that inode.
    let identity: { dev: number; ino: number } | undefined;
    try {
      identity = await handle.stat();
      await handle.writeFile(token);
      await handle.close();
    } catch (initError) {
      try {
        await handle.close();
      } catch {
        // fd may already be closed; preserve the original error (fail closed).
      }
      try {
        const current = await this.fs.lstat(this.lockPath);
        if (identity !== undefined && current.isFile()
          && current.dev === identity.dev && current.ino === identity.ino) {
          await this.fs.rm(this.lockPath, { force: true });
        }
      } catch {
        // Cleanup best-effort; original error propagates.
      }
      throw initError;
    }
    try {
      return await fn();
    } finally {
      // Release only the lock this operation owns.
      try {
        const held = await this.fs.readFile(this.lockPath, 'utf8');
        if (held === token) {
          await this.fs.rm(this.lockPath, { force: true });
        }
      } catch {
        // Lock already gone or unreadable; nothing more to release.
      }
    }
  }

  public async load(): Promise<RuntimeTargetState> {
    return (await this.readView()).state;
  }

  public async listLockfiles(): Promise<{ path: string; scope: 'user' | 'repository'; document: RuntimeMultiTargetLockfile }[]> {
    const view = await this.readView();
    return [...view.authorities.values()]
      .filter((a) => a.scope === 'user' || a.root === view.workspace)
      .map((a) => ({ path: a.file, scope: a.scope, document: JSON.parse(a.text) as RuntimeMultiTargetLockfile }));
  }

  public async getMutationConflicts(instance: RuntimeTargetInstance): Promise<RuntimePlanConflict[]> {
    if (instance.scope === 'user') {
      return [];
    }
    const view = await this.readView();
    if (view.workspace === undefined || !inside(view.workspace, instance.root)) {
      return [{ code: 'LOCKFILE.CONTEXT_MISMATCH', message: 'repository target must belong to the selected workspace context' }];
    }
    if ([REPO_FILE, LOCAL_FILE].some((name) => view.legacy.has(path.join(view.workspace!, name)))) {
      return [{
        code: 'LOCKFILE.LEGACY_UNRESOLVED',
        message: 'Legacy v2 repository records have no target identity. Migrate the lockfile first (run `ai-primitives-hub lockfile migrate` or the Migrate Lockfile command in the extension); it will not be overwritten.'
      }];
    }
    return [];
  }

  public async publishLegacyMigration(input: {
    workspaceRoot: string;
    groups: { kind: 'commit' | 'local-only'; receipts: Receipt[] }[];
  }): Promise<void> {
    const view = await this.readView();
    if (view.workspace === undefined || input.workspaceRoot !== view.workspace) {
      throw new Error('migration must target the store workspace');
    }
    const changes: Publication[] = [];
    for (const group of input.groups) {
      const file = path.join(view.workspace, group.kind === 'local-only' ? LOCAL_FILE : REPO_FILE);
      if (!view.legacy.has(file)) {
        throw new Error(`no legacy lockfile to migrate at ${file}`);
      }
      const merged = [...group.receipts];
      validateRuntimeTargetState({
        ...emptyRuntimeTargetState(),
        receipts: Object.fromEntries(merged.map((r) => [r.receiptId, r]))
      });
      changes.push({ file, root: view.workspace, text: this.serialize(merged) });
    }
    const selectionText = this.selectionText(view.state, [...new Set([...view.repositories, view.workspace])].toSorted());
    if (selectionText !== undefined && selectionText !== view.selectionText) {
      changes.push({ file: this.selectionPath, root: this.stateDir, text: selectionText });
    }
    await this.publish(changes);
  }

  public async save(input: RuntimeTargetState): Promise<void> {
    const state = validateRuntimeTargetState(input);
    const view = await this.readView();
    const groups = new Map<string, Receipt[]>();
    for (const receipt of Object.values(state.receipts)) {
      let file = this.statePath;
      if (receipt.instance.scope === 'repository') {
        if (receipt.contextRoot === undefined || !inside(receipt.contextRoot, receipt.instance.root)) {
          throw new Error('repository receipt lacks a contained canonical context');
        }
        file = path.join(receipt.contextRoot, receipt.commitMode === 'local-only' ? LOCAL_FILE : REPO_FILE);
      }
      const group = groups.get(file) ?? [];
      group.push(receipt);
      groups.set(file, group);
    }
    const changes: Publication[] = [];
    const repositories = new Set(view.repositories);
    const repoFiles = new Set([
      ...[...view.authorities.values()].filter((a) => a.scope === 'repository').map((a) => a.file),
      ...[...groups.keys()].filter((file) => file !== this.statePath)
    ]);
    for (const file of repoFiles) {
      const receipts = groups.get(file) ?? [];
      if (view.legacy.has(file)) {
        throw new Error(`legacy unresolved lockfile is read-only: ${file}`);
      }
      const old = view.authorities.get(file);
      if (old !== undefined && semantic(Object.values(old.records.receipts)) === semantic(receipts)) {
        continue;
      }
      if (old === undefined && receipts.length === 0) {
        continue;
      }
      const root = path.dirname(file);
      if (root !== view.workspace) {
        throw new Error(`cannot mutate another repository's authority: ${file}`);
      }
      repositories.add(root);
      changes.push({ file, root, text: this.serialize(receipts) });
    }
    const userReceipts = groups.get(this.statePath) ?? [];
    if (!view.authorities.has(this.statePath) ? userReceipts.length > 0 : semantic(view.user) !== semantic(userReceipts)) {
      changes.push({ file: this.statePath, root: this.userRoot, text: this.serialize(userReceipts) });
    }

    const selectionText = this.selectionText(state, [...repositories].toSorted());
    if (selectionText !== view.selectionText && !(view.selectionText === undefined && selectionText === undefined)) {
      if (selectionText !== undefined) {
        changes.push({ file: this.selectionPath, root: this.stateDir, text: selectionText });
      }
    }
    const importsText = Object.keys(state.imports).length === 0 && view.importsText === undefined
      ? undefined
      : `${JSON.stringify({ imports: sortKeys(state.imports) }, null, 2)}\n`;
    if (importsText !== undefined && importsText !== view.importsText) {
      changes.push({ file: this.importsPath, root: this.userRoot, text: importsText });
    }

    const referenced = new Set<string>([
      ...Object.values(state.receipts).map((r) => r.payloadId),
      ...Object.values(state.imports).map((i) => i.payloadId)
    ]);
    for (const id of referenced) {
      const snapshot = state.payloads[id];
      if (snapshot !== undefined) {
        await this.payloads.write(snapshot);
      }
    }
    await this.publish(changes);
    if (view.complete) {
      for (const id of await this.payloads.list()) {
        if (!referenced.has(id)) {
          await this.payloads.remove(id);
        }
      }
    }
  }

  private selectionText(state: RuntimeTargetState, repositories: string[]): string | undefined {
    const empty = Object.keys(state.selections.workspaces).length === 0
      && state.selections.userDefault === undefined && state.revision === 0 && repositories.length === 0;
    if (empty) {
      return undefined;
    }
    const doc = {
      workspaces: sortKeys(Object.fromEntries(Object.entries(state.selections.workspaces).map(([k, v]) => [k, { type: v.type }]))),
      ...(state.selections.userDefault === undefined ? {} : { userDefault: { type: state.selections.userDefault.type } }),
      revision: state.revision,
      ...(repositories.length === 0 ? {} : { repositories })
    };
    return `${JSON.stringify(doc, null, 2)}\n`;
  }

  private serialize(receipts: Receipt[]): string {
    const document = encodeLockfileV3({ receipts: Object.fromEntries(receipts.map((r) => [r.receiptId, r])) }, this.generatedBy);
    return `${JSON.stringify(document, null, 2)}\n`;
  }

  private async readText(file: string): Promise<string | undefined> {
    try {
      const stat = await this.fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`state file must be a regular file, not a symlink: ${file}`);
      }
      return await this.fs.readFile(file, 'utf8');
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private async readAuthority(file: string, root: string, scope: Authority['scope']): Promise<Authority | 'legacy' | undefined> {
    const text = await this.readText(file);
    if (text === undefined) {
      return undefined;
    }
    const raw: unknown = JSON.parse(text);
    if ((raw as { version?: unknown } | null)?.version === '2.0.0') {
      inspectLegacyV2(raw);
      return 'legacy';
    }
    const records = decodeLockfileV3(raw, scope === 'repository' ? { repositoryRoot: root } : {});
    for (const receipt of Object.values(records.receipts)) {
      if (receipt.instance.scope !== scope) {
        throw new Error(`scope receipt in wrong authority: ${file}`);
      }
      if (scope === 'repository') {
        if (!inside(root, receipt.instance.root) || (receipt.contextRoot !== undefined && receipt.contextRoot !== root)) {
          throw new Error(`repository receipt escapes its authority context: ${file}`);
        }
        receipt.contextRoot = root;
        receipt.commitMode = path.basename(file) === LOCAL_FILE ? 'local-only' : 'commit';
      }
    }
    return { file, root, scope, text, records };
  }

  private parseSelection(text: string | undefined): { revision: number; selections: RuntimeTargetState['selections']; repositories: string[] } {
    if (text === undefined) {
      return { revision: 0, selections: { workspaces: {} }, repositories: [] };
    }
    const raw = JSON.parse(text) as Record<string, unknown> | null;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`target selection is not an object: ${this.selectionPath}`);
    }
    for (const key of Object.keys(raw)) {
      if (!SELECTION_KEYS.has(key)) {
        throw new Error(`target selection has an unexpected section ${key}: ${this.selectionPath}`);
      }
    }
    return {
      revision: raw.revision as number,
      selections: {
        workspaces: (raw.workspaces ?? {}) as RuntimeTargetState['selections']['workspaces'],
        ...(raw.userDefault === undefined ? {} : { userDefault: raw.userDefault as RuntimeTargetState['selections']['userDefault'] })
      },
      repositories: (raw.repositories ?? []) as string[]
    };
  }

  private parseImports(text: string | undefined): Record<string, RuntimeImportRef> {
    if (text === undefined) {
      return {};
    }
    const raw = JSON.parse(text) as { imports?: Record<string, RuntimeImportRef> } | null;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((k) => k !== 'imports')) {
      throw new Error(`imports file is malformed: ${this.importsPath}`);
    }
    return raw.imports ?? {};
  }

  private async readView(): Promise<View> {
    const authorities = new Map<string, Authority>();
    const legacy = new Set<string>();
    const authority = await this.readAuthority(this.statePath, this.userRoot, 'user');
    if (authority === 'legacy') {
      throw new Error(`legacy unresolved user authority is read-only: ${this.statePath}`);
    }
    if (authority !== undefined) {
      authorities.set(this.statePath, authority);
    }
    const user = authority === undefined ? [] : Object.values(authority.records.receipts);
    const receipts: Record<string, Receipt> = Object.fromEntries(user.map((r) => [r.receiptId, r]));

    const selectionText = await this.readText(this.selectionPath);
    const importsText = await this.readText(this.importsPath);
    const selection = this.parseSelection(selectionText);
    let complete = true;
    const workspace = this.options.workspaceRoot === undefined ? undefined : await this.fs.realpath(this.options.workspaceRoot);
    const roots = new Set([...selection.repositories, ...(workspace === undefined ? [] : [workspace])]);
    for (const root of roots) {
      try {
        if (await this.fs.realpath(root) !== root) {
          throw new Error(`indexed repository root has changed identity: ${root}`);
        }
      } catch (error) {
        if (isNotFound(error)) {
          complete = false;
          continue;
        }
        throw error;
      }
      for (const name of [REPO_FILE, LOCAL_FILE]) {
        const file = path.join(root, name);
        const repo = await this.readAuthority(file, root, 'repository');
        if (repo === 'legacy') {
          legacy.add(file);
        } else if (repo !== undefined) {
          authorities.set(file, repo);
          for (const [id, receipt] of Object.entries(repo.records.receipts)) {
            if (receipts[id] !== undefined) {
              throw new Error(`duplicate installation authority for ${id}`);
            }
            receipts[id] = receipt;
          }
        }
      }
    }

    const payloads: Record<string, RuntimePayloadSnapshot> = {};
    const imports = this.parseImports(importsText);
    const wanted = new Set([...Object.values(receipts).map((r) => r.payloadId), ...Object.values(imports).map((i) => i.payloadId)]);
    for (const id of wanted) {
      const snapshot = await this.payloads.read(id);
      if (snapshot !== undefined) {
        payloads[id] = snapshot;
      }
    }
    // An import whose payload is gone has nothing left to offer.
    const liveImports = Object.fromEntries(Object.entries(imports).filter(([, i]) => payloads[i.payloadId] !== undefined));
    const state = validateRuntimeTargetState({
      ...emptyRuntimeTargetState(),
      revision: selection.revision,
      selections: selection.selections,
      payloads,
      imports: liveImports,
      receipts,
      repositories: selection.repositories
    });
    return { state, user, authorities, legacy, repositories: selection.repositories, selectionText, importsText, complete, workspace };
  }

  private async safeParents(change: Publication): Promise<void> {
    if (!inside(change.root, change.file) || change.root === change.file) {
      throw new Error(`state path escapes its root: ${change.file}`);
    }
    await this.fs.mkdir(change.root, { recursive: true });
    const rel = path.relative(change.root, path.dirname(change.file));
    let current = change.root;
    for (const component of rel === '' ? [] : rel.split(path.sep)) {
      current = path.join(current, component);
      try {
        await this.fs.mkdir(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }
      const stat = await this.fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`state parent is a symlink or not a directory: ${current}`);
      }
    }
    try {
      const stat = await this.fs.lstat(change.file);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`state file is a symlink or not a regular file: ${change.file}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  private async replace(file: string, text: string): Promise<void> {
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await this.fs.writeFile(tmp, text, { flag: 'wx', mode: 0o600 });
      await this.fs.rename(tmp, file);
    } catch (error) {
      try {
        await this.fs.rm(tmp, { force: true });
      } catch {
        // Preserve the publication failure; an unpublished owned temp is safe.
      }
      throw error;
    }
  }

  /**
   * Ordinary exception rollback, not a claim of multi-file crash atomicity.
   * @param changes
   */
  private async publish(changes: Publication[]): Promise<void> {
    const before = new Map<string, string | undefined>();
    const published: { file: string; dev: number; ino: number }[] = [];
    for (const change of changes) {
      await this.safeParents(change);
      try {
        before.set(change.file, await this.fs.readFile(change.file, 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
        before.set(change.file, undefined);
      }
    }
    try {
      for (const change of changes) {
        if (before.get(change.file) === change.text) {
          continue;
        }
        await this.replace(change.file, change.text);
        const stat = await this.fs.lstat(change.file);
        published.push({ file: change.file, dev: stat.dev, ino: stat.ino });
      }
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const identity of published.reverse()) {
        try {
          const stat = await this.fs.lstat(identity.file);
          if (!stat.isFile() || stat.dev !== identity.dev || stat.ino !== identity.ino) {
            throw new Error(`state file changed during rollback: ${identity.file}`);
          }
          const old = before.get(identity.file);
          await (old === undefined ? this.fs.rm(identity.file) : this.replace(identity.file, old));
        } catch (rollbackError) {
          rollbackErrors.push((rollbackError as Error).message);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new Error(`${(error as Error).message}; rollback failed: ${rollbackErrors.join('; ')}`);
      }
      throw error;
    }
  }
}
