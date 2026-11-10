/* eslint-disable @typescript-eslint/member-ordering -- public use cases precede acquisition helpers. */
/**
 * Marketplace acquisition and lifecycle over the same target session as CLI.
 * Installed state always comes from scope lockfiles, never RegistryStorage.
 */
import {
  type Bundle,
  type BundleExtractor,
  compareVersions,
  extractBundleIdentity,
  type InstallOptions,
  instanceKey,
  parseGitHubOwnerRepo,
  type RegistrySource,
  type RuntimeApplyResult,
  type RuntimeInstallation,
  type RuntimeOperation,
  type RuntimePayloadInput,
  type RuntimeProjectionPlan,
  type RuntimeTargetScope,
  type SourceAdapter,
  type TargetType,
  validateManifest,
} from '@ai-primitives-hub/core';
import {
  resolveInstallationBundle,
  type ResolveInstallationBundlePorts,
} from '../registry/resolve-installation-bundle';
import {
  RuntimeTargetError,
  type RuntimeTargetSession,
} from './session';

export interface RuntimeRegistryCatalog extends ResolveInstallationBundlePorts {
  getAdapter(source: RegistrySource): Pick<SourceAdapter, 'downloadBundle'>;
}
export interface RuntimeRegistryFacadeOptions {
  sessionFactory(workspaceRoot?: string): RuntimeTargetSession;
  extractor: BundleExtractor;
  catalog: RuntimeRegistryCatalog;
  onMcpServersChanged?: (
    action: 'install' | 'update' | 'uninstall',
    installation: RuntimeInstallation
  ) => Promise<void>;
  onLocalOnlyPathsChanged?: (
    workspaceRoot: string,
    added: string[],
    removed: string[],
    hasLocalOnlyInstallations: boolean
  ) => Promise<void>;
}
export interface RuntimeRegistryActionContext {
  workspaceRoot?: string;
  confirm(plan: RuntimeProjectionPlan): Promise<boolean>;
  /** Delivery lifetime, including feature disable/context removal. */
  isCurrent?(): boolean;
}
export interface RuntimeRegistryInstallOptions extends Omit<InstallOptions, 'scope'> {
  scope: RuntimeTargetScope;
  sourceId?: string;
}

export class RuntimeRegistryFacade {
  public constructor(private readonly options: RuntimeRegistryFacadeOptions) {}

  public list(workspaceRoot?: string): Promise<RuntimeInstallation[]> {
    return this.options.sessionFactory(workspaceRoot).listInstallations();
  }

  /**
   * Compatibility for bundle-only callers: ambiguity is an error, never first.
   * @param id
   * @param workspaceRoot
   * @param scope
   */
  public async resolveInstallation(id: string, workspaceRoot?: string, scope?: RuntimeTargetScope): Promise<RuntimeInstallation> {
    const rows = (await this.list(workspaceRoot)).filter((r) =>
      (r.registryRef?.bundleId === id || r.manifestId === id) && (scope === undefined || r.instance.scope === scope));
    if (rows.length !== 1) {
      throw new Error('Choose an exact installed target/scope row; bundle identity is missing or ambiguous.');
    }
    return rows[0];
  }

  public async install(id: string, options: RuntimeRegistryInstallOptions, context: RuntimeRegistryActionContext): Promise<RuntimeInstallation | undefined> {
    if (options.scope !== 'user' && options.scope !== 'repository') {
      throw new Error('Choose repository or user scope.');
    }
    if (options.profileId !== undefined) {
      throw new Error('Profile activation is not supported by direct target-aware installation.');
    }
    const session = this.options.sessionFactory(context.workspaceRoot);
    const type = await this.selected(session, context);
    const payload = await this.acquire(id, options, options.sourceId);
    await this.guard(session, type, context);
    const scoped = session.forScope(options.scope, {
      commitMode: options.scope === 'repository' ? options.commitMode ?? 'commit' : undefined
    });
    const active = (await scoped.getActiveTarget())!;
    const existing = (await scoped.listInstallations()).find((row) =>
      row.sourceId === payload.sourceId && row.manifestId === payload.manifest.id
      && instanceKey(row.instance) === instanceKey(active.instance));
    if (existing?.version === payload.manifest.version && !options.force) {
      throw new Error('This version is already installed in that scope. Choose another scope or update that installation.');
    }
    const op: RuntimeOperation = existing === undefined
      ? { kind: 'install', payload }
      : { kind: 'update', payload, installationId: existing.installationId };
    const applied = await this.execute(scoped, type, op, context);
    if (applied !== undefined && options.scope === 'repository' && options.commitMode === 'local-only') {
      await this.syncLocalOnlyPaths(session, context.workspaceRoot, applied);
    }
    if (applied === undefined) {
      return undefined;
    }
    const installed = await session.getInstallation(applied.receipts[0]);
    if (installed !== undefined && options.scope === 'repository') {
      installed.commitMode = options.commitMode ?? installed.commitMode ?? 'commit';
    }
    if (installed !== undefined) {
      await this.syncMcpServers(op.kind, installed);
    }
    return installed;
  }

  public async update(installationId: string, version: string | undefined, context: RuntimeRegistryActionContext): Promise<RuntimeInstallation | undefined> {
    const session = this.options.sessionFactory(context.workspaceRoot);
    const type = await this.selected(session, context);
    const row = await this.requireRow(session, installationId);
    const source = (await this.options.catalog.listSources()).find((s) => s.id === row.sourceId);
    if (source === undefined) {
      throw new Error(`Source ${row.sourceId} is unavailable; this exact installation can still be removed.`);
    }
    const id = extractBundleIdentity(row.registryRef?.bundleId ?? row.manifestId, source.type);
    const payload = await this.acquire(id, { scope: row.instance.scope, version: version ?? 'latest' }, row.sourceId);
    if (payload.sourceId !== row.sourceId || payload.manifest.id !== row.manifestId) {
      throw new Error('Acquired update does not match the selected source-qualified collection.');
    }
    await this.guard(session, type, context);
    const scoped = this.forRow(session, row);
    const applied = await this.execute(scoped, type, { kind: 'update', payload, installationId }, context);
    if (applied !== undefined && row.commitMode === 'local-only' && row.contextRoot !== undefined) {
      await this.syncLocalOnlyPaths(session, row.contextRoot, applied);
    }
    const updated = applied === undefined ? undefined : await session.getInstallation(installationId);
    if (updated !== undefined) {
      await this.syncMcpServers('update', updated);
    }
    return updated;
  }

  public async uninstall(installationId: string, context: RuntimeRegistryActionContext): Promise<RuntimeApplyResult | undefined> {
    const session = this.options.sessionFactory(context.workspaceRoot);
    const type = await this.selected(session, context);
    const row = await this.requireRow(session, installationId);
    const applied = await this.execute(this.forRow(session, row), type, {
      kind: 'uninstall', installationId, sourceId: row.sourceId, manifestId: row.manifestId
    }, context);
    if (applied !== undefined && row.commitMode === 'local-only' && row.contextRoot !== undefined) {
      await this.syncLocalOnlyPaths(session, row.contextRoot, applied);
    }
    if (applied !== undefined) {
      await this.syncMcpServers('uninstall', row);
    }
    return applied;
  }

  private forRow(session: RuntimeTargetSession, row: RuntimeInstallation): RuntimeTargetSession {
    return session.forScope(row.instance.scope, {
      path: row.instance.scope === 'repository' ? row.contextRoot : row.instance.root,
      commitMode: row.commitMode
    });
  }

  private async syncLocalOnlyPaths(
    session: RuntimeTargetSession,
    workspaceRoot: string | undefined,
    applied: RuntimeApplyResult
  ): Promise<void> {
    if (workspaceRoot === undefined || this.options.onLocalOnlyPathsChanged === undefined) {
      return;
    }
    const remaining = await session.listInstallations();
    const hasLocalOnlyInstallations = remaining.some((row) =>
      row.instance.scope === 'repository' && row.commitMode === 'local-only'
    );
    await this.options.onLocalOnlyPathsChanged(
      workspaceRoot, applied.written, applied.removed, hasLocalOnlyInstallations
    );
  }

  private async syncMcpServers(
    action: 'install' | 'update' | 'uninstall',
    installation: RuntimeInstallation
  ): Promise<void> {
    await this.options.onMcpServersChanged?.(action, installation);
  }

  private async requireRow(session: RuntimeTargetSession, id: string): Promise<RuntimeInstallation> {
    const row = (await session.listInstallations()).find((candidate) => candidate.installationId === id);
    if (row === undefined) {
      throw new Error('Installation is not present for this target/context. Refresh and choose an exact installed row.');
    }
    return row;
  }

  private async selected(session: RuntimeTargetSession, context: RuntimeRegistryActionContext): Promise<TargetType> {
    if (context.isCurrent?.() === false) {
      throw new RuntimeTargetError('PLAN.STALE', 'Target manager disabled or context changed.');
    }
    const selected = await session.getSelectedTarget();
    if (selected === undefined) {
      throw new Error('Select a target harness before installing from Marketplace.');
    }
    return selected.type;
  }

  private async guard(session: RuntimeTargetSession, type: TargetType, context: RuntimeRegistryActionContext): Promise<void> {
    if (await this.selected(session, context) !== type) {
      throw new RuntimeTargetError('PLAN.STALE', 'Selected target changed. Preview again.');
    }
  }

  private async execute(session: RuntimeTargetSession, type: TargetType, op: RuntimeOperation, context: RuntimeRegistryActionContext): Promise<RuntimeApplyResult | undefined> {
    await this.guard(session, type, context);
    const plan = await session.plan(op);
    if (!plan.canApply) {
      throw new Error(`Nothing applied: ${plan.conflicts.map((c) => `${c.code}: ${c.message}`).join('; ') || 'empty plan'}`);
    }
    if (!await context.confirm(plan)) {
      return undefined;
    }
    await this.guard(session, type, context);
    return session.apply(op, plan.hash);
  }

  private async acquire(id: string, options: InstallOptions, requestedSource?: string): Promise<RuntimePayloadInput> {
    const catalog = this.options.catalog;
    const sources = await catalog.listSources();
    const initial = requestedSource === undefined ? await catalog.getBundleDetails(id) : undefined;
    const sourceId = requestedSource ?? initial!.sourceId;
    const source = sources.find((candidate) => candidate.id === sourceId && candidate.enabled);
    if (source === undefined || source.type === 'local-skills') {
      throw new Error('Source unavailable or requires unsupported direct-symlink installation.');
    }
    const cached = (await catalog.getCachedSourceBundles(sourceId)).filter((b) => b.sourceId === sourceId);
    const details = async (lookupId: string): Promise<Bundle> => {
      // A source may list several versions under one id: the newest wins.
      // A source may list several versions under one id: the newest wins.
      const exact = cached.filter((b) => b.id === lookupId).toSorted((a, b) => compareVersions(b.version, a.version))[0];
      if (exact !== undefined) {
        return exact;
      }
      const identity = extractBundleIdentity(lookupId, source.type);
      const candidates = cached.filter((b) => extractBundleIdentity(b.id, source.type) === identity)
        .toSorted((a, b) => compareVersions(b.version, a.version));
      if (candidates[0] !== undefined) {
        return candidates[0];
      }
      const fallback = await catalog.getBundleDetails(lookupId);
      if (fallback.sourceId !== sourceId) {
        throw new Error('Ambiguous collection lookup crossed source identity.');
      }
      return fallback;
    };
    const bundle = await resolveInstallationBundle(id, options, {
      ...catalog,
      getBundleDetails: details,
      listSources: async () => [source],
      getCachedSourceBundles: async (sid) => sid === sourceId ? cached : [],
      // The legacy global version cache lacks source identity; never borrow it.
      getBundleVersion: (identity, version) => {
        const b = cached.find((candidate) => candidate.version === version
          && extractBundleIdentity(candidate.id, source.type) === identity);
        return b === undefined
          ? undefined
          : {
            bundleId: b.id, version: b.version, publishedAt: b.lastUpdated,
            downloadUrl: b.downloadUrl, manifestUrl: b.manifestUrl
          };
      }
    });
    if (bundle.sourceId !== sourceId || (options.version !== undefined
      && options.version !== 'latest' && bundle.version !== options.version)) {
      throw new Error(`Requested source/version ${sourceId}/${options.version ?? 'latest'} is unavailable.`);
    }
    const files = await this.options.extractor.extract(await catalog.getAdapter(source).downloadBundle(bundle));
    const repo = source.type === 'github' ? parseGitHubOwnerRepo(source.url) : null;
    const manifest = validateManifest(files, {
      expectedId: bundle.id, expectedVersion: bundle.version,
      ...(repo === null ? {} : { sourceRepoSlug: `${repo.owner}/${repo.repo}` })
    });
    return {
      files, manifest, sourceId,
      registryRef: { bundleId: bundle.id, sourceType: source.type },
      source: { type: source.type, url: source.url }
    };
  }
}
