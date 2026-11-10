/**
 * RuntimeTargetSession — shared target-management session.
 * Owns selection, payload snapshots, projection receipts, planning and
 * guarded apply over injected storage/store/fs ports. Every public method
 * rereads durable state; no cross-operation state cache.
 * @module runtime-target/session
 */
import {
  createHash,
} from 'node:crypto';
import * as path from 'node:path';
import {
  analyzePlannedWrite,
  analyzeRemoval,
  collectionKey,
  decodeLockfileV3,
  expandPath,
  findUnsupportedPayloadContent,
  instanceKey,
  isSafeAbsolutePath,
  requireSafeId,
  resolvePathTokens,
  runtimeFileModesEqual,
  runtimePayloadId,
  runtimeReceiptId,
  selectProjectionPayloads,
  TARGET_TYPES,
  UNSUPPORTED_CAPABILITY_KINDS,
  validateRuntimePayload,
  validateSelectionInput,
} from '@ai-primitives-hub/core';
import type {
  AppStorage,
  ExtractedFiles,
  LayoutConfigLoader,
  RepositoryCommitMode,
  RuntimeActiveTarget,
  RuntimeApplyResult,
  RuntimeAvailableCollection,
  RuntimeCollectionId,
  RuntimeImportedCollection,
  RuntimeInstallation,
  RuntimeInstalledCollection,
  RuntimeMultiTargetLockfile,
  RuntimeOperation,
  RuntimePlanConflict,
  RuntimeProjectionFileSystem,
  RuntimeProjectionPlan,
  RuntimeProjectionReceipt,
  RuntimeSelection,
  RuntimeTargetCatalogEntry,
  RuntimeTargetInstance,
  RuntimeTargetScope,
  RuntimeTargetSelectionInput,
  RuntimeTargetState,
  RuntimeTargetStore,
  RuntimeVerification,
  Target,
  TargetLayoutsConfig,
  TargetType,
  ValidatedManifest,
} from '@ai-primitives-hub/core';
import {
  defaultLayouts,
} from '@ai-primitives-hub/infra';
import {
  resolveLayoutFromLayers,
} from '../install/layout-resolver';
import {
  writeBundleSafely,
} from '../install/target-write';
import {
  TransformerRegistry,
} from '../transform/transformer-registry';
import {
  FileTreeTargetWriter,
} from '../writers/file-tree-writer';
import {
  applyLegacyMigration,
  hasLegacyLockfile,
  type LegacyMigrationPlan,
  type LegacyMigrationResult,
  planLegacyLockfileMigration,
} from './legacy-migration';
import {
  RecordingWriterFs,
} from './recording-writer-fs';

export class RuntimeTargetError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'RuntimeTargetError';
  }
}

export interface RuntimeSessionOptions {
  storage: AppStorage;
  store: RuntimeTargetStore;
  fs: RuntimeProjectionFileSystem;
  env: Readonly<Record<string, string | undefined>>;
  /** Canonical workspace root; required for repository-scope operations. */
  workspaceRoot?: string;
  layoutLoader: LayoutConfigLoader;
  /** Ephemeral invocation-scope for forScope child sessions; never persisted. */
  ephemeral?: { scope: RuntimeTargetScope; path?: string; commitMode?: RepositoryCommitMode };
  /** Per-invocation harness override; never persisted. */
  targetOverride?: TargetType;
  /** Allow MCP declarations only when the delivery wires an MCP config adapter. */
  allowMcpServers?: boolean;
}

const sha256 = (bytes: Uint8Array | string): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const now = (): string => new Date().toISOString();

const hasMcpDeclarations = (manifest: ValidatedManifest): boolean => {
  const servers = (manifest as Record<string, unknown>).mcpServers;
  return servers !== null && typeof servers === 'object' && Object.keys(servers).length > 0;
};

const isMcpSupportFile = (bundlePath: string): boolean => {
  const lower = bundlePath.toLowerCase();
  return lower === 'mcp.json' || lower.startsWith('mcp/');
};

/* eslint-disable @typescript-eslint/member-ordering -- public API kept above private helpers. */
export class RuntimeTargetSession {
  public constructor(private readonly opts: RuntimeSessionOptions) {}

  private async load(): Promise<RuntimeTargetState> {
    return this.opts.store.load();
  }

  /**
   * Installation row for a receipt; a missing payload snapshot yields a
   * minimal manifest view and `payloadAvailable: false`.
   * @param state
   * @param r
   */
  private installationRow(state: RuntimeTargetState, r: RuntimeProjectionReceipt): RuntimeInstallation {
    const snapshot = state.payloads[r.payloadId];
    return {
      installationId: r.receiptId,
      sourceId: r.collection.sourceId,
      manifestId: r.collection.manifestId,
      instance: r.instance,
      version: r.version,
      installedAt: r.installedAt,
      payloadId: r.payloadId,
      manifest: snapshot?.manifest ?? { id: r.collection.manifestId, version: r.version, name: r.collection.manifestId },
      payloadAvailable: snapshot !== undefined,
      ...(r.source === undefined ? {} : { source: r.source }),
      ...(r.contextRoot === undefined ? {} : { contextRoot: r.contextRoot }),
      ...(r.commitMode === undefined ? {} : { commitMode: r.commitMode }),
      ...(r.registryRef === undefined ? {} : { registryRef: r.registryRef })
    };
  }

  private async targetContext(selection: { type: TargetType; scope: RuntimeTargetScope; path?: string }, layers: TargetLayoutsConfig[]) {
    const target: Target = { name: 'runtime', type: selection.type, scope: selection.scope };
    if (selection.scope === 'repository') {
      const workspace = selection.path ?? this.opts.workspaceRoot;
      if (workspace === undefined) {
        throw new RuntimeTargetError('SESSION.NO_WORKSPACE', 'repository scope requires a workspace root');
      }
      target.rootPath = await this.canonRoot(workspace);
    } else if (selection.path !== undefined) {
      target.path = selection.path;
    }
    const layout = resolveLayoutFromLayers(target, layers);
    if (layout === null) {
      throw new RuntimeTargetError('TARGET.NO_LAYOUT', `no layout for ${selection.type}/${selection.scope}`);
    }
    const env = { ...this.opts.env, HOME: this.opts.env.HOME ?? this.opts.env.USERPROFILE };
    if (layout.baseDir.startsWith('~') && !env.HOME) {
      throw new RuntimeTargetError('TARGET.NO_HOME', 'target layout requires an explicit HOME or USERPROFILE');
    }
    const expanded = expandPath(resolvePathTokens(layout.baseDir, env), env);
    if (!isSafeAbsolutePath(expanded)) {
      throw new RuntimeTargetError('TARGET.RELATIVE_BASE', `target base directory must resolve to an absolute path: ${String(expanded)}`);
    }
    const root = await this.canonRoot(expanded);
    const pinned = { ...layout, baseDir: root };
    const writerLayers: TargetLayoutsConfig[] = [{
      layouts: { [selection.type]: { user: pinned, repository: pinned } }
    }];
    return {
      instance: { type: selection.type, scope: selection.scope, root },
      target,
      writerLayers
    };
  }

  /**
   * Canonicalize a possibly-not-yet-existing root via its nearest existing ancestor.
   * @param p
   */
  private async canonRoot(p: string): Promise<string> {
    let probe = path.resolve(p);
    const missing: string[] = [];
    for (;;) {
      try {
        const real = await this.opts.fs.realpath(probe);
        return path.join(real, ...missing);
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') {
          throw error;
        }
        try {
          if ((await this.opts.fs.lstat(probe)).isSymbolicLink) {
            throw new RuntimeTargetError('PATH.SYMLINK_ESCAPE', `target root contains a broken symlink: ${probe}`);
          }
        } catch (statError) {
          if ((statError as { code?: string }).code !== 'ENOENT') {
            throw statError;
          }
        }
        const parent = path.dirname(probe);
        if (parent === probe) {
          return path.resolve(p);
        }
        missing.unshift(path.basename(probe));
        probe = parent;
      }
    }
  }

  /**
   * Assert a planned/touched path stays within the canonical target root.
   * @param absPath
   * @param root
   */
  private async assertContained(absPath: string, root: string): Promise<void> {
    const rel = path.relative(root, absPath);
    if (rel.length === 0 || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new RuntimeTargetError('PATH.ESCAPE', `planned path escapes target root: ${absPath}`);
    }
    let probe = root;
    const components = ['', ...rel.split(path.sep)];
    for (const component of components) {
      probe = path.join(probe, component);
      try {
        const entry = await this.opts.fs.lstat(probe);
        if (entry.isSymbolicLink) {
          throw new RuntimeTargetError('PATH.SYMLINK_ESCAPE', `symlink may resolve outside target root or alias another owner: ${probe}`);
        }
        if (probe !== absPath && !entry.isDirectory) {
          throw new RuntimeTargetError('PATH.NOT_DIRECTORY', `target ancestor is not a directory: ${probe}`);
        }
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') {
          return;
        }
        throw error;
      }
    }
  }

  private async observed(absPath: string): Promise<{ exists: boolean; isSymlink: boolean; sha256?: string; mode?: number }> {
    let lst;
    try {
      lst = await this.opts.fs.lstat(absPath);
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        return { exists: false, isSymlink: false };
      }
      throw error;
    }
    if (lst.isSymbolicLink || !lst.isFile) {
      return { exists: true, isSymlink: true, mode: lst.mode };
    }
    const bytes = await this.opts.fs.readFileBytes(absPath);
    return { exists: true, isSymlink: false, sha256: sha256(bytes), mode: lst.mode };
  }

  private async selected(state: RuntimeTargetState): Promise<{ selection: RuntimeSelection; source: RuntimeActiveTarget['selection'] } | undefined> {
    if (this.opts.targetOverride !== undefined) {
      return { selection: { type: this.opts.targetOverride }, source: 'workspace' };
    }
    const ws = this.opts.workspaceRoot === undefined ? undefined : await this.canonRoot(this.opts.workspaceRoot);
    if (ws !== undefined) {
      const selWs = state.selections.workspaces[ws];
      if (selWs !== undefined) {
        return { selection: selWs, source: 'workspace' };
      }
    }
    const sel = state.selections.userDefault;
    if (sel === undefined) {
      return undefined;
    }
    return { selection: sel, source: 'user-default' };
  }

  private resolvedScope(): RuntimeTargetScope {
    if (this.opts.ephemeral !== undefined) {
      return this.opts.ephemeral.scope;
    }
    return this.opts.workspaceRoot === undefined ? 'user' : 'repository';
  }

  private async active(state: RuntimeTargetState): Promise<RuntimeActiveTarget | undefined> {
    const selected = await this.selected(state);
    if (selected === undefined) {
      return undefined;
    }
    const scope = this.resolvedScope();
    const context = await this.targetContext(
      {
        type: selected.selection.type,
        scope,
        ...(this.opts.ephemeral?.path === undefined ? {} : { path: this.opts.ephemeral.path })
      },
      await this.opts.layoutLoader.load()
    );
    return { instance: context.instance, selection: selected.source };
  }

  private async requireActive(state: RuntimeTargetState): Promise<RuntimeActiveTarget> {
    const a = await this.active(state);
    if (a === undefined) {
      throw new RuntimeTargetError('SELECTION.NONE', 'no active target; select one with runtime-target use');
    }
    return a;
  }

  public async listTargets(): Promise<RuntimeTargetCatalogEntry[]> {
    return TARGET_TYPES.map((type) => {
      const layout = (defaultLayouts.layouts as Record<string, { user?: { baseDir: string }; repository?: { baseDir: string } }>)[type];
      const scopes = (['user', 'repository'] as const).filter((s) => layout?.[s] !== undefined);
      return {
        type,
        scopes: [...scopes],
        baseDirs: Object.fromEntries(scopes.map((s) => [s, layout[s]!.baseDir])),
        unsupported: UNSUPPORTED_CAPABILITY_KINDS.filter((capability) =>
          !this.opts.allowMcpServers || capability !== 'mcp'
        )
      };
    });
  }

  public async getActiveTarget(): Promise<RuntimeActiveTarget | undefined> {
    return this.active(await this.load());
  }

  /** Persisted selection: harness type + which slot produced it (no scope). */
  public async getSelectedTarget(): Promise<{ type: TargetType; selection: RuntimeActiveTarget['selection'] } | undefined> {
    const selected = await this.selected(await this.load());
    if (selected === undefined) {
      return undefined;
    }
    return { type: selected.selection.type, selection: selected.source };
  }

  /**
   * Ephemeral scope-scoped session: same selection/catalogue, but every
   * invocation resolves the instance for `scope` (optionally `path`/
   * `commitMode`). Nothing about scope is persisted.
   * @param scope
   * @param opts
   * @param opts.path
   * @param opts.commitMode
   */
  public forScope(scope: RuntimeTargetScope, opts?: { path?: string; commitMode?: RepositoryCommitMode }): RuntimeTargetSession {
    if (scope !== 'user' && scope !== 'repository') {
      throw new RuntimeTargetError('SELECTION.INVALID', `unknown scope "${String(scope)}"`);
    }
    return new RuntimeTargetSession({
      ...this.opts,
      ephemeral: { scope, ...(opts?.path === undefined ? {} : { path: opts.path }), ...(opts?.commitMode === undefined ? {} : { commitMode: opts.commitMode }) }
    });
  }

  /** Whether this workspace still holds a legacy v2 lockfile. */
  public async hasLegacyLockfile(): Promise<boolean> {
    return this.opts.workspaceRoot !== undefined && hasLegacyLockfile(this.opts, await this.canonRoot(this.opts.workspaceRoot));
  }

  /** Read-only migration plan for the workspace's legacy lockfiles. */
  public planLegacyMigration(): Promise<LegacyMigrationPlan> {
    return planLegacyLockfileMigration(this.opts);
  }

  /**
   * Apply a migration plan with one harness choice per ambiguous candidate set.
   * @param plan
   * @param choices
   */
  public applyLegacyMigration(plan: LegacyMigrationPlan, choices: Record<string, TargetType> = {}): Promise<LegacyMigrationResult> {
    return applyLegacyMigration(this.opts, plan, choices);
  }

  /**
   * Session that resolves the given harness for this invocation only; the
   * persisted selection is untouched.
   * @param type
   */
  public forTarget(type: TargetType): RuntimeTargetSession {
    return new RuntimeTargetSession({ ...this.opts, targetOverride: type });
  }

  /** Authoritative installation rows spanning scopes for the selected target. */
  public async listInstallations(): Promise<RuntimeInstallation[]> {
    const state = await this.load();
    const selected = await this.selected(state);
    if (selected === undefined) {
      return [];
    }
    const ws = this.opts.workspaceRoot === undefined ? undefined : await this.canonRoot(this.opts.workspaceRoot);
    return Object.values(state.receipts)
      .filter((r) => {
        if (r.instance.type !== selected.selection.type) {
          return false;
        }
        if (r.instance.scope === 'user') {
          return true;
        }
        return ws !== undefined && r.contextRoot === ws;
      })
      .map((r) => this.installationRow(state, r));
  }

  /**
   * Exact read remains valid if selection changes after a completed apply.
   * @param installationId
   */
  public async getInstallation(installationId: string): Promise<RuntimeInstallation | undefined> {
    const state = await this.load();
    const r = state.receipts[installationId];
    if (r === undefined) {
      return undefined;
    }
    if (r.instance.scope === 'repository'
      && (this.opts.workspaceRoot === undefined || r.contextRoot !== await this.canonRoot(this.opts.workspaceRoot))) {
      return undefined;
    }
    return this.installationRow(state, r);
  }

  public async getLockfiles(): Promise<{ path: string; scope: RuntimeTargetScope; document: RuntimeMultiTargetLockfile }[]> {
    if (this.opts.store.listLockfiles !== undefined) {
      return this.opts.store.listLockfiles();
    }
    const document = await this.getLockfile();
    return document === null ? [] : [{ path: this.opts.store.statePath, scope: 'user', document }];
  }

  public async getLockfile(): Promise<RuntimeMultiTargetLockfile | null> {
    try {
      const raw = await this.opts.fs.readJson(this.opts.store.statePath);
      decodeLockfileV3(raw);
      return raw as RuntimeMultiTargetLockfile;
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  public async selectTarget(input: RuntimeTargetSelectionInput): Promise<RuntimeActiveTarget> {
    const err = validateSelectionInput(input, this.opts.workspaceRoot !== undefined);
    if (err !== null) {
      throw new RuntimeTargetError('SELECTION.INVALID', err);
    }
    return this.opts.store.withExclusive(async () => {
      const state = await this.load();
      // Scope is invocation-local: it resolves the returned instance for this
      // call only. The persisted selection stores the harness type alone.
      const scope = input.scope ?? (input.userDefault === true ? 'user' : 'repository');
      const invoked = await this.targetContext(
        { type: input.type, scope, ...(input.path === undefined ? {} : { path: input.path }) },
        await this.opts.layoutLoader.load()
      );
      const persisted: RuntimeSelection = { type: input.type };
      if (input.userDefault === true) {
        state.selections.userDefault = persisted;
      } else {
        if (this.opts.workspaceRoot === undefined) {
          throw new RuntimeTargetError('SESSION.NO_WORKSPACE', 'workspace selection requires a workspace root (or use the user-default slot)');
        }
        state.selections.workspaces[await this.canonRoot(this.opts.workspaceRoot)] = persisted;
      }
      await this.requireActive(state);
      state.revision += 1;
      await this.opts.store.save(state);
      return { instance: invoked.instance, selection: input.userDefault === true ? 'user-default' : 'workspace' };
    });
  }

  private activeReceipts(state: RuntimeTargetState, inst: RuntimeTargetInstance): RuntimeProjectionReceipt[] {
    const key = instanceKey(inst);
    return Object.values(state.receipts).filter((r) => instanceKey(r.instance) === key);
  }

  public async listInstalled(): Promise<RuntimeInstalledCollection[]> {
    const state = await this.load();
    const active = await this.requireActive(state);
    return this.activeReceipts(state, active.instance).map((r) => ({
      ...r.collection,
      version: r.version,
      payloadId: r.payloadId,
      installedAt: r.installedAt,
      outputCount: Object.keys(r.outputs).length
    }));
  }

  public async listAvailableCollections(): Promise<RuntimeAvailableCollection[]> {
    const state = await this.load();
    const active = await this.active(state);
    const importedPayloadIds = new Set(Object.values(state.imports).map((i) => i.payloadId));
    const referencedPayloadIds = new Set(Object.values(state.receipts).map((r) => r.payloadId));
    const activeKey = active === undefined ? null : instanceKey(active.instance);
    const out: RuntimeAvailableCollection[] = [];
    for (const snap of Object.values(state.payloads)) {
      const installedOn = Object.values(state.receipts)
        .filter((r) => r.payloadId === snap.payloadId)
        .map((r) => instanceKey(r.instance));
      const isImported = importedPayloadIds.has(snap.payloadId);
      const isReferenced = referencedPayloadIds.has(snap.payloadId);
      if (!isImported && !isReferenced) {
        continue; // unreferenced history is not a project candidate
      }
      out.push({
        sourceId: snap.sourceId,
        manifestId: snap.manifestId,
        version: snap.version,
        payloadId: snap.payloadId,
        provenance: isImported ? 'imported' : 'installed',
        installedOn,
        current: activeKey !== null && installedOn.includes(activeKey)
      });
    }
    return out;
  }

  public async verify(): Promise<RuntimeVerification[]> {
    const state = await this.load();
    const active = await this.requireActive(state);
    const out: RuntimeVerification[] = [];
    for (const receipt of this.activeReceipts(state, active.instance)) {
      for (const [outPath, expected] of Object.entries(receipt.outputs)) {
        await this.assertContained(outPath, active.instance.root);
        const obs = await this.observed(outPath);
        const modeDrift = obs.mode !== undefined && !runtimeFileModesEqual(obs.mode, expected.mode, this.opts.fs.modeSemantics ?? 'posix');
        out.push({
          collection: receipt.collection,
          path: outPath,
          status: obs.exists ? (obs.sha256 === expected.sha256 && !modeDrift ? 'healthy' : 'modified') : 'missing'
        });
      }
    }
    return out;
  }

  public async importInstalled(input: RuntimeImportedCollection): Promise<RuntimeAvailableCollection> {
    const sourceId = requireSafeId(input.sourceId, 'sourceId');
    const manifest = (await import('@ai-primitives-hub/core')).validateManifest(input.files, {
      ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion })
    });
    const snap = this.snapshot(manifest, input.files, sourceId);
    const unsupported = findUnsupportedPayloadContent(snap.manifest, snap.files, {
      allowMcpServers: this.opts.allowMcpServers
    });
    if (unsupported.length > 0) {
      throw new RuntimeTargetError('PAYLOAD.UNSUPPORTED', `unsupported content: ${unsupported.join('; ')}`);
    }
    return this.opts.store.withExclusive(async () => {
      const state = await this.load();
      state.payloads[snap.payloadId] = snap;
      const importId = `import-${state.revision + 1}-${snap.payloadId.slice(7, 19)}`;
      state.imports[importId] = {
        importId,
        payloadId: snap.payloadId,
        sourceId,
        manifestId: manifest.id,
        provenance: input.provenance,
        ...(input.legacyRef === undefined ? {} : { legacyRef: input.legacyRef }),
        importedAt: now()
      };
      state.revision += 1;
      await this.opts.store.save(state);
      return {
        sourceId,
        manifestId: manifest.id,
        version: manifest.version,
        payloadId: snap.payloadId,
        provenance: 'imported',
        installedOn: [],
        current: false
      };
    });
  }

  private snapshot(manifest: ValidatedManifest, files: ExtractedFiles, sourceId: string) {
    const validated = validateRuntimePayload(files, sourceId, manifest);
    const payloadId = runtimePayloadId(sourceId, validated.manifest, validated.files);
    return {
      payloadId,
      sourceId,
      manifestId: manifest.id,
      version: manifest.version,
      manifest: validated.manifest,
      files: validated.files,
      createdAt: now()
    };
  }

  /**
   * Owners index: absolute path -> owners across ALL receipts.
   * @param state
   */
  private ownersIndex(state: RuntimeTargetState): Map<string, { receiptId: string; sha256: string; mode?: number }[]> {
    const idx = new Map<string, { receiptId: string; sha256: string; mode?: number }[]>();
    for (const r of Object.values(state.receipts)) {
      for (const [p, o] of Object.entries(r.outputs)) {
        const list = idx.get(p) ?? [];
        list.push({ receiptId: r.receiptId, sha256: o.sha256, mode: o.mode });
        idx.set(p, list);
      }
    }
    return idx;
  }

  private async planWrites(target: Target, layers: TargetLayoutsConfig[], files: ExtractedFiles, manifest: ValidatedManifest) {
    const recording = new RecordingWriterFs();
    const registry = TransformerRegistry.withBuiltIns();
    const writer = new FileTreeTargetWriter({
      fs: recording,
      env: { ...this.opts.env },
      transformer: registry.getTransformer(target.type),
      layoutLoader: { load: async () => layers }
    });
    const projectionFiles = this.opts.allowMcpServers && hasMcpDeclarations(manifest)
      ? new Map([...files].filter(([bundlePath]) => !isMcpSupportFile(bundlePath)))
      : files;
    const { result } = await writeBundleSafely(writer, target, projectionFiles, manifest);
    return { recording, result };
  }

  /**
   * Coherent authority identity: hash of the loaded state's revision plus the
   * canonical ordered receipt set for the resolved instance — external edits
   * to authoritative records change the hash regardless of physical location.
   * @param state
   */
  private authorityHash(state: RuntimeTargetState): string {
    const rows = Object.values(state.receipts)
      .toSorted((a, b) => a.receiptId.localeCompare(b.receiptId))
      .map((r) => ({
        ...r,
        outputs: Object.fromEntries(Object.entries(r.outputs).toSorted(([a], [b]) => a.localeCompare(b)))
      }));
    return sha256(JSON.stringify([state.revision, state.selections, rows]));
  }

  private fingerprint(input: object): string {
    return sha256(JSON.stringify(input)).slice(7, 39);
  }

  /**
   * Build the plan for an operation against a given loaded state (read-only;
   * touches the target filesystem only to observe bytes — never writes).
   * @param state
   * @param op
   */
  private async buildPlan(
    state: RuntimeTargetState,
    op: RuntimeOperation
  ): Promise<RuntimeProjectionPlan & { _writes: Map<string, { bytes: Uint8Array; mode?: number }>; _preservedModified: string[]; _receiptMutate: (s: RuntimeTargetState) => void }> {
    const selected = await this.selected(state);
    if (selected === undefined) {
      throw new RuntimeTargetError('SELECTION.NONE', 'no active target; select one with runtime-target use');
    }
    const layers = await this.opts.layoutLoader.load();
    const context = await this.targetContext(
      {
        type: selected.selection.type,
        scope: this.resolvedScope(),
        ...(this.opts.ephemeral?.path === undefined ? {} : { path: this.opts.ephemeral.path })
      },
      layers
    );
    const inst = context.instance;
    const root = inst.root;
    const owners = this.ownersIndex(state);
    const observations = new Map<string, Awaited<ReturnType<RuntimeTargetSession['observed']>>>();
    const observe = async (file: string) => {
      const result = await this.observed(file);
      observations.set(file, result);
      return result;
    };
    const writes = new Map<string, { bytes: Uint8Array; mode?: number; bundlePath: string; sha256: string }>();
    const collectionOutputs = new Map<string, Map<string, { sha256: string; mode?: number }>>();
    const removals: { path: string; sha256: string }[] = [];
    const preserved = new Set<string>();
    const sharedPaths = new Set<string>();
    const modifiedPreserve = new Set<string>();
    const conflicts: RuntimePlanConflict[] = await this.opts.store.getMutationConflicts?.(inst) ?? [];
    const collections: { sourceId: string; manifestId: string; version: string }[] = [];
    const mutateReceipts: ((s: RuntimeTargetState) => void)[] = [];
    const selfReceiptFor = (c: RuntimeCollectionId): RuntimeProjectionReceipt | undefined =>
      this.activeReceipts(state, inst).find((r) => collectionKey(r.collection) === collectionKey(c));

    const payloadsToWrite: { collection: RuntimeCollectionId; version: string; snap: { files: ExtractedFiles; manifest: ValidatedManifest }; selfReceiptId?: string }[] = [];

    if (op.kind === 'install' || op.kind === 'update') {
      const snapshot = this.snapshot(op.payload.manifest, op.payload.files, op.payload.sourceId);
      const unsupported = findUnsupportedPayloadContent(snapshot.manifest, snapshot.files, {
        allowMcpServers: this.opts.allowMcpServers
      });
      if (unsupported.length > 0) {
        throw new RuntimeTargetError('PAYLOAD.UNSUPPORTED', `unsupported content: ${unsupported.join('; ')}`);
      }
      const coll = { sourceId: snapshot.sourceId, manifestId: snapshot.manifestId };
      let existing = selfReceiptFor(coll);
      if (op.kind === 'update' && op.installationId !== undefined) {
        const byId = state.receipts[op.installationId];
        if (byId === undefined || collectionKey(byId.collection) !== collectionKey(coll)
          || instanceKey(byId.instance) !== instanceKey(inst)) {
          conflicts.push({ code: 'COLLECTION.NOT_INSTALLED', message: `installation ${op.installationId} not found for ${coll.manifestId} on this instance` });
          existing = undefined;
        } else {
          existing = byId;
        }
      }
      if (op.kind === 'install' && existing !== undefined) {
        conflicts.push({ code: 'COLLECTION.ALREADY_INSTALLED', message: `${coll.manifestId} is already installed; use update` });
      }
      if (op.kind === 'update' && existing === undefined) {
        conflicts.push({ code: 'COLLECTION.NOT_INSTALLED', message: `${coll.manifestId} is not installed on this target; use install` });
      }
      payloadsToWrite.push({ collection: coll, version: snapshot.version, snap: snapshot, selfReceiptId: existing?.receiptId });
      collections.push({ ...coll, version: snapshot.version });
    } else if (op.kind === 'project') {
      const result = selectProjectionPayloads(state, inst, op.sourceTargetId);
      conflicts.push(...result.conflicts);
      for (const c of result.alreadyProjected) {
        preserved.add(`already projected: ${c.manifestId}`);
      }
      for (const item of result.selected) {
        payloadsToWrite.push({ collection: item.collection, version: item.snapshot.version, snap: item.snapshot });
        collections.push({ ...item.collection, version: item.snapshot.version });
      }
    } else {
      // uninstall
      const coll = { sourceId: requireSafeId(op.sourceId, 'sourceId'), manifestId: requireSafeId(op.manifestId, 'manifestId') };
      let existing = selfReceiptFor(coll);
      if (op.installationId !== undefined) {
        const byId = state.receipts[op.installationId];
        if (byId === undefined || instanceKey(byId.instance) !== instanceKey(inst)
          || collectionKey(byId.collection) !== collectionKey(coll)) {
          conflicts.push({ code: 'COLLECTION.NOT_INSTALLED', message: `installation ${op.installationId} not found for ${coll.manifestId} on this instance` });
          existing = undefined;
        } else {
          existing = byId;
        }
      }
      if (existing === undefined) {
        conflicts.push({ code: 'COLLECTION.NOT_INSTALLED', message: `${coll.manifestId} is not installed on this target` });
      } else {
        collections.push({ ...coll, version: existing.version });
        for (const [p, expected] of Object.entries(existing.outputs)) {
          const others = (owners.get(p) ?? []).filter((o) => o.receiptId !== existing.receiptId);
          await this.assertContained(p, root);
          const obs = await observe(p);
          const verdict = analyzeRemoval(
            {
              receiptId: existing.receiptId,
              sha256: expected.sha256,
              ...(expected.mode === undefined ? {} : { mode: expected.mode })
            },
            obs,
            others,
            this.opts.fs.modeSemantics ?? 'posix'
          );
          switch (verdict.kind) {
            case 'remove': {
              removals.push({ path: p, sha256: expected.sha256 });

              break;
            }
            case 'preserve-modified': {
              preserved.add(p);
              modifiedPreserve.add(p);

              break;
            }
            case 'keep-shared': {
              preserved.add(p);

              break;
            }
            case 'conflict': {
              conflicts.push({ ...verdict.conflict, path: p });

              break;
            }
          // No default
          }
        }
        mutateReceipts.push((s) => {
          delete s.receipts[existing.receiptId];
        });
      }
    }

    // Plan writes for each payload through the real writer (recording fs).
    for (const item of payloadsToWrite) {
      try {
        if ('manifest' in item.snap && 'files' in item.snap) {
          const unsupported = findUnsupportedPayloadContent(item.snap.manifest, item.snap.files, {
            allowMcpServers: this.opts.allowMcpServers
          });
          if (unsupported.length > 0) {
            throw new RuntimeTargetError('PAYLOAD.UNSUPPORTED', `unsupported content: ${unsupported.join('; ')}`);
          }
        }
        const ownOutputs = new Map<string, { sha256: string; mode?: number }>();
        collectionOutputs.set(collectionKey(item.collection), ownOutputs);
        const { recording } = await this.planWrites(
          context.target,
          context.writerLayers,
          item.snap.files,
          item.snap.manifest
        );
        for (const [absPath, w] of recording.getWrites()) {
          await this.assertContained(absPath, root);
          const sha = sha256(w.bytes);
          ownOutputs.set(absPath, { sha256: sha, ...(w.mode === undefined ? {} : { mode: w.mode }) });
          const prevWrite = writes.get(absPath);
          if (prevWrite === undefined) {
            writes.set(absPath, { bytes: w.bytes, mode: w.mode, bundlePath: '', sha256: sha });
          } else {
            const sameMode = runtimeFileModesEqual(prevWrite.mode, w.mode, this.opts.fs.modeSemantics ?? 'posix');
            if (prevWrite.sha256 !== sha || !sameMode) {
              conflicts.push({ path: absPath, code: 'PLAN.DUPLICATE', message: 'two payloads write different bytes/mode to the same destination' });
              continue;
            }
            // identical bytes+mode from another collection in the same batch:
            // one physical write, shared ownership is recorded per collection.
          }
        }
      } catch (error) {
        if (error instanceof RuntimeTargetError) {
          throw error;
        }
        conflicts.push({ code: 'PLAN.WRITE_REJECTED', message: (error as Error).message });
      }
    }

    // Ownership/conflict analysis for every planned write.
    for (const [p, w] of writes) {
      const obs = await observe(p);
      const ownerList = (owners.get(p) ?? []).map((o) => ({ receiptId: o.receiptId, sha256: o.sha256, mode: o.mode }));
      // find which new receipt will own this path: its collection's receipt id
      let selfId: string | undefined;
      for (const item of payloadsToWrite) {
        if (item.selfReceiptId !== undefined && ownerList.some((o) => o.receiptId === item.selfReceiptId)) {
          selfId = item.selfReceiptId;
          break;
        }
      }
      const verdict = analyzePlannedWrite(w.sha256, obs, ownerList, selfId, w.mode, this.opts.fs.modeSemantics ?? 'posix');
      if (verdict.kind === 'conflict') {
        conflicts.push({ ...verdict.conflict, path: p });
      } else if (verdict.kind === 'shared') {
        // Identical bytes+mode already owned by another receipt: only take
        // ownership — never rewrite or chmod another owner's file.
        sharedPaths.add(p);
        preserved.add(p);
      }
    }
    for (const p of sharedPaths) {
      writes.delete(p);
    }

    // For update: superseded outputs of the same receipt not covered by new writes.
    for (const item of payloadsToWrite) {
      if (item.selfReceiptId === undefined) {
        continue;
      }
      const existing = Object.values(state.receipts).find((r) => r.receiptId === item.selfReceiptId);
      if (existing === undefined) {
        continue;
      }
      for (const [p, expected] of Object.entries(existing.outputs)) {
        if (writes.has(p)) {
          continue;
        }
        const others = (owners.get(p) ?? []).filter((o) => o.receiptId !== existing.receiptId);
        await this.assertContained(p, root);
        const obs = await observe(p);
        const verdict = analyzeRemoval(
          {
            receiptId: existing.receiptId,
            sha256: expected.sha256,
            ...(expected.mode === undefined ? {} : { mode: expected.mode })
          },
          obs,
          others,
          this.opts.fs.modeSemantics ?? 'posix'
        );
        switch (verdict.kind) {
          case 'remove': {
            removals.push({ path: p, sha256: expected.sha256 });

            break;
          }
          case 'preserve-modified': {
            preserved.add(p);
            modifiedPreserve.add(p);

            break;
          }
          case 'keep-shared': {
            preserved.add(p);

            break;
          }
          case 'conflict': {
            conflicts.push({ ...verdict.conflict, path: p });

            break;
          }
        // No default
        }
      }
      // Replace the receipt wholesale on apply.
      const writeList = [...writes.entries()];
      mutateReceipts.push((s) => {
        const outputs: RuntimeProjectionReceipt['outputs'] = {};
        for (const [p, w] of writeList) {
          outputs[p] = { sha256: w.sha256, ...(w.mode === undefined ? {} : { mode: w.mode }) };
        }
        // drop old receipt, write new for this collection
        delete s.receipts[existing.receiptId];
      });
      break;
    }

    const authority = this.authorityHash(state);
    const contextRoot = inst.scope === 'repository'
      ? await this.canonRoot(this.opts.ephemeral?.path ?? this.opts.workspaceRoot!)
      : undefined;
    const prior = (op.kind === 'update' || op.kind === 'uninstall') && op.installationId !== undefined
      ? state.receipts[op.installationId]
      : undefined;
    const commitMode = contextRoot === undefined ? undefined : this.opts.ephemeral?.commitMode ?? prior?.commitMode ?? 'commit';
    const planWritesList = [...writes.entries()].map(([p, w]) => ({ path: p, sha256: w.sha256, ...(w.mode === undefined ? {} : { mode: w.mode }), bundlePath: w.bundlePath }));
    const hash = this.fingerprint({
      authority,
      contextRoot,
      commitMode,
      op: op.kind === 'install' || op.kind === 'update'
        ? {
          kind: op.kind,
          registryRef: op.payload.registryRef,
          payloads: payloadsToWrite.map((item) => runtimePayloadId(item.collection.sourceId, item.snap.manifest, item.snap.files)),
          ...(op.kind === 'update' && op.installationId === undefined
            ? {}
            : {
              installationId: (op as { installationId?: string }).installationId,
              expectedReceipt: payloadsToWrite[0]?.selfReceiptId
            })
        }
        : { ...op, expectedReceipt: payloadsToWrite[0]?.selfReceiptId },
      instance: inst,
      layers,
      revision: state.revision,
      writes: planWritesList,
      removals,
      observations: [...observations.entries()].toSorted(([a], [b]) => a.localeCompare(b)),
      preserved: [...preserved].toSorted(),
      conflicts,
      collections
    });

    const receiptsMutate = (s: RuntimeTargetState): void => {
      for (const f of mutateReceipts) {
        f(s);
      }
      if (op.kind === 'install' || op.kind === 'update' || op.kind === 'project') {
        for (const item of payloadsToWrite) {
          const snap = 'manifest' in item.snap ? this.snapshot(item.snap.manifest, item.snap.files, item.collection.sourceId) : undefined;
          if (snap !== undefined) {
            s.payloads[snap.payloadId] = snap;
          }
          const rk = runtimeReceiptId(inst.type, inst.scope, inst.root, item.collection.sourceId, item.collection.manifestId, contextRoot);
          const recordedSource = (op.kind === 'install' || op.kind === 'update' ? op.payload.source : undefined)
            ?? (item.selfReceiptId === undefined ? undefined : state.receipts[item.selfReceiptId]?.source)
            ?? Object.values(state.receipts).find((r) => r.payloadId === snap?.payloadId && r.source !== undefined)?.source;
          const outputs: RuntimeProjectionReceipt['outputs'] = {};
          for (const [p, w] of collectionOutputs.get(collectionKey(item.collection)) ?? []) {
            outputs[p] = { sha256: w.sha256, ...(w.mode === undefined ? {} : { mode: w.mode }) };
          }
          s.receipts[rk] = {
            receiptId: rk,
            instance: inst,
            collection: item.collection,
            payloadId: snap?.payloadId ?? '',
            version: item.version,
            outputs,
            installedAt: now(),
            ...(contextRoot === undefined ? {} : { contextRoot, commitMode }),
            ...(recordedSource === undefined ? {} : { source: recordedSource }),
            ...((op.kind === 'install' || op.kind === 'update') && op.payload.registryRef !== undefined
              ? { registryRef: op.payload.registryRef }
              : (item.selfReceiptId === undefined || state.receipts[item.selfReceiptId]?.registryRef === undefined
                ? {}
                : { registryRef: state.receipts[item.selfReceiptId].registryRef }))
          };
        }
      }
    };

    return {
      hash,
      operation: op.kind,
      instance: inst,
      ...(contextRoot === undefined ? {} : { contextRoot, commitMode }),
      collections,
      writes: planWritesList,
      removals,
      preserved: [...preserved],
      conflicts,
      canApply: conflicts.length === 0 && (writes.size > 0 || removals.length > 0 || sharedPaths.size > 0 || payloadsToWrite.length > 0 || mutateReceipts.length > 0),
      stateRevision: state.revision,
      _writes: new Map([...writes.entries()].map(([p, w]) => [p, { bytes: w.bytes, mode: w.mode }])),
      _preservedModified: [...modifiedPreserve],
      _receiptMutate: receiptsMutate
    };
  }

  public async plan(op: RuntimeOperation): Promise<RuntimeProjectionPlan> {
    const state = await this.load();
    const p = await this.buildPlan(state, op);
    const { _writes, _preservedModified, _receiptMutate, ...pub } = p;
    return pub;
  }

  public async apply(op: RuntimeOperation, expectedPlanHash: string): Promise<RuntimeApplyResult> {
    return this.opts.store.withExclusive(async () => {
      const state = await this.load();
      const p = await this.buildPlan(state, op);
      if (p.hash !== expectedPlanHash) {
        throw new RuntimeTargetError('PLAN.STALE', 'plan fingerprint changed since preview; re-preview before applying');
      }
      if (p.conflicts.length > 0) {
        throw new RuntimeTargetError('PLAN.CONFLICT', `plan has conflicts: ${p.conflicts.map((c) => `${c.code} ${c.path ?? ''}`).join('; ')}`);
      }
      if (!p.canApply) {
        throw new RuntimeTargetError('PLAN.EMPTY', 'plan has no applicable changes');
      }
      const written: string[] = [];
      const removed: string[] = [];
      const preservedModified: string[] = [...(p._preservedModified ?? [])];
      const backups = new Map<string, { bytes: Uint8Array; mode?: number }>();
      const created: string[] = [];
      try {
        for (const [absPath, w] of p._writes) {
          await this.assertContained(absPath, p.instance.root);
          const obs = await this.observed(absPath);
          if (obs.exists && obs.sha256 !== undefined) {
            const bytes = await this.opts.fs.readFileBytes(absPath);
            backups.set(absPath, { bytes, mode: obs.mode });
          } else if (!obs.exists) {
            created.push(absPath);
          }
          await this.opts.fs.mkdir(path.dirname(absPath), { recursive: true });
          await this.opts.fs.writeFileBytes(absPath, w.bytes);
          await this.opts.fs.chmod(absPath, w.mode ?? 0o644);
          const check = await this.opts.fs.readFileBytes(absPath);
          if (sha256(check) !== sha256(w.bytes)) {
            throw new RuntimeTargetError('APPLY.VERIFY_FAILED', `write verification failed for ${absPath}`);
          }
          written.push(absPath);
        }
        for (const rm of p.removals) {
          await this.assertContained(rm.path, p.instance.root);
          const obs = await this.observed(rm.path);
          if (!obs.exists) {
            continue;
          }
          if (obs.sha256 !== rm.sha256) {
            preservedModified.push(rm.path);
            continue;
          }
          backups.set(rm.path, { bytes: await this.opts.fs.readFileBytes(rm.path), mode: obs.mode });
          await this.opts.fs.remove(rm.path);
          removed.push(rm.path);
        }
        p._receiptMutate(state);
        state.revision += 1;
        await this.opts.store.save(state);
      } catch (error) {
        // In-process rollback: restore overwritten files, remove created ones.
        const rollbackErrors: string[] = [];
        for (const c of created) {
          try {
            await this.opts.fs.remove(c);
          } catch (e) {
            rollbackErrors.push(`failed to remove new file ${c}: ${(e as Error).message}`);
          }
        }
        for (const [absPath, b] of backups) {
          try {
            await this.opts.fs.mkdir(path.dirname(absPath), { recursive: true });
            await this.opts.fs.writeFileBytes(absPath, b.bytes);
            if (b.mode !== undefined) {
              await this.opts.fs.chmod(absPath, b.mode);
            }
          } catch (e) {
            rollbackErrors.push(`failed to restore ${absPath}: ${(e as Error).message}`);
          }
        }
        if (rollbackErrors.length > 0) {
          throw new RuntimeTargetError('APPLY.ROLLBACK_FAILED', `${(error as Error).message}; rollback errors: ${rollbackErrors.join('; ')}`);
        }
        throw error;
      }
      return {
        applied: true,
        instance: p.instance,
        written,
        removed,
        preservedModified,
        receipts: this.activeReceipts(state, p.instance)
          .filter((receipt) => p.collections.some((collection) => collectionKey(collection) === collectionKey(receipt.collection)))
          .map((receipt) => receipt.receiptId)
      };
    });
  }
}

/**
 * Factory for the experimental shared target session.
 * @param opts
 */
export function createRuntimeTargetSession(opts: RuntimeSessionOptions): RuntimeTargetSession {
  return new RuntimeTargetSession(opts);
}
