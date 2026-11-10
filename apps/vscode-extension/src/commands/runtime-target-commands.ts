/**
 * registerRuntimeTargetCommands — shared-target UI adaptor. Registered by the
 * feature only while the target-management setting is on. Thin: all domain
 * work delegates to RuntimeTargetController; this file only does
 * QuickPick/dialog/preview glue.
 * @module commands/runtime-target-commands
 */
import * as path from 'node:path';
import {
  createRuntimeTargetSession,
  type RuntimeRegistryActionContext,
  type RuntimeTargetSession,
} from '@ai-primitives-hub/app';
import type {
  RuntimeOperation,
  RuntimeProjectionPlan,
  RuntimeTargetSelectionInput,
} from '@ai-primitives-hub/core';
import {
  FileSystemLayoutConfigLoader,
  loadExtractedDirectory,
  NodeRuntimeProjectionFileSystem,
  resolveUserConfigDir,
  ScopedRuntimeTargetStore,
  XdgAppStorage,
} from '@ai-primitives-hub/infra';
import * as vscode from 'vscode';
import {
  RuntimeTargetController,
} from '../services/runtime-target-controller';
import {
  Logger,
} from '../utils/logger';
import {
  LegacyLockfileMigration,
} from './legacy-lockfile-migration';

export const RUNTIME_TARGET_CONTEXT_KEY = 'promptregistry.targetManagementEnabled';

export interface RuntimeTargetCommandsOptions {
  env: Readonly<Record<string, string | undefined>>;
  controller?: RuntimeTargetController;
  sessionFactory?: (workspaceRoot?: string) => RuntimeTargetSession;
  registryManager?: { setRuntimeTargetManagement(binding?: unknown): void; refreshRuntimeInstallations?(): void };
  onDidChange?: () => void;
}

/**
 * Shared session factory: composed ScopedRuntimeTargetStore per context.
 * @param env
 */
export const createRuntimeTargetSessionFactory = (env: Readonly<Record<string, string | undefined>>) =>
  (workspaceRoot?: string) => {
    const layoutCwd = workspaceRoot ?? env.HOME ?? env.USERPROFILE;
    if (layoutCwd === undefined || !path.isAbsolute(layoutCwd)) {
      throw new Error('runtime-target requires an absolute workspace root or HOME/USERPROFILE for the global context');
    }
    const storage = new XdgAppStorage(env);
    const fs = new NodeRuntimeProjectionFileSystem();
    return createRuntimeTargetSession({
      storage,
      store: new ScopedRuntimeTargetStore({
        storage,
        workspaceRoot,
        toolVersion: vscode.extensions.getExtension('AmadeusITGroup.prompt-registry')?.packageJSON?.version as string | undefined
      }),
      fs,
      env,
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      allowMcpServers: true,
      layoutLoader: new FileSystemLayoutConfigLoader({ cwd: layoutCwd, fs, userConfigDir: resolveUserConfigDir(env) })
    });
  };

interface UiContext {
  kind: 'workspace' | 'global';
  root?: string;
  label: string;
}

/**
 * Composition root: shared session factory honoring the settled global rule.
 * @param env
 */

/* eslint-disable @typescript-eslint/member-ordering -- public API kept above private helpers. */
export class RuntimeTargetCommands implements vscode.Disposable {
  private readonly controller: RuntimeTargetController;
  private readonly legacy: LegacyLockfileMigration;
  private readonly disposables: vscode.Disposable[] = [];
  private context: UiContext | undefined;
  private contextImplicit = true;
  private epoch = 0;
  private readonly statusBar: vscode.StatusBarItem;
  private readonly logger = Logger.getInstance();

  /** Implicit context: 0 folders -> global, exactly 1 -> that workspace; multi-root stays unpicked. */
  private implicitContext(): UiContext | undefined {
    const wsFolders = vscode.workspace.workspaceFolders ?? [];
    if (wsFolders.length === 0) {
      return { kind: 'global', label: 'user-default' };
    }
    if (wsFolders.length === 1) {
      const f = wsFolders[0];
      return { kind: 'workspace', root: f.uri.fsPath, label: `$(folder) ${f.name}` };
    }
    return undefined;
  }

  public constructor(private readonly opts: RuntimeTargetCommandsOptions) {
    const sessionFactory = opts.sessionFactory ?? createRuntimeTargetSessionFactory(opts.env);
    this.controller = opts.controller ?? new RuntimeTargetController({ sessionFactory });
    this.legacy = new LegacyLockfileMigration({
      getRoot: () => this.context?.root,
      sessionFactory,
      onChanged: () => this.notifyChanged()
    });
    // Initialize context immediately so bound services (Marketplace, status)
    // see a ready context without running a command first.
    const initial = this.implicitContext();
    if (initial !== undefined) {
      this.context = initial;
      this.contextImplicit = true;
      this.epoch += 1;
    }
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.statusBar.text = 'Target: none';
    this.statusBar.tooltip = 'Select the target harness. Click to choose.';
    this.statusBar.command = 'promptregistry.runtimeTargetSelect';
    this.statusBar.show();
    this.disposables.push(this.statusBar, vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        void this.refreshStatus();
      }
    }), vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      // Invalidate only when the CHOSEN workspace disappeared; when exactly
      // one folder remains it becomes the explicit context (same rule as
      // startup), otherwise the context is cleared — never switch silently.
      if (this.context?.kind === 'workspace'
        && (e.removed ?? []).some((f) => f.uri.fsPath === this.context?.root)) {
        this.context = this.implicitContext();
        this.contextImplicit = true;
        this.epoch += 1;
      }
      void this.refreshStatus();
    }));
  }

  /** Canonical opened context root (workspace) or undefined for user-default. */
  /** Prompt to migrate when the workspace still has a legacy lockfile. */
  public checkLegacyLockfile(): Promise<void> {
    return this.legacy.check();
  }

  /** True while a legacy lockfile blocks mutations (after prompting). */
  public blockedByLegacyLockfile(): Promise<boolean> {
    return this.legacy.blocked();
  }

  public migrateLockfile(): Promise<void> {
    return this.legacy.migrate();
  }

  public getContextRoot(): string | undefined {
    return this.context?.root;
  }

  public hasContext(): boolean {
    return this.context !== undefined;
  }

  /**
   * Capture an action context for runtime-registry mutations: carries the
   * current epoch/context; confirm() previews the plan, isCurrent() expires
   * it on disable/reselect.
   */
  public actionContext(): RuntimeRegistryActionContext | undefined {
    if (this.context === undefined) {
      return undefined;
    }
    const epoch = this.epoch;
    const ctx = this.context;
    return {
      workspaceRoot: ctx.root,
      confirm: async (plan: RuntimeProjectionPlan) => this.confirmApply(plan),
      isCurrent: () => !this.disposed && this.epoch === epoch && this.context === ctx
    };
  }

  /**
   * Preview + modal confirmation + epoch re-check shared with facade actions.
   * @param plan
   */
  public async confirmApply(plan: RuntimeProjectionPlan): Promise<boolean> {
    await this.showJson('runtime-target plan preview', plan);
    if (plan.conflicts.length > 0) {
      void vscode.window.showWarningMessage(`Plan has ${plan.conflicts.length} conflict(s); nothing applied.`);
      return false;
    }
    if (!plan.canApply) {
      void vscode.window.showInformationMessage('Plan has no applicable changes; nothing applied.');
      return false;
    }
    const epoch = this.epoch;
    const confirm = await vscode.window.showWarningMessage(
      `Apply plan to ${plan.instance.root}?`, { modal: true }, 'Apply Preview'
    );
    if (confirm !== 'Apply Preview') {
      return false;
    }
    if (this.disposed || epoch !== this.epoch) {
      void vscode.window.showErrorMessage('Context changed; re-preview before applying.');
      return false;
    }
    return true;
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.context = undefined;
    this.epoch += 1;
    void vscode.commands.executeCommand('setContext', RUNTIME_TARGET_CONTEXT_KEY, false);
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private async chooseContext(): Promise<UiContext | undefined> {
    const wsFolders = vscode.workspace.workspaceFolders ?? [];
    if (wsFolders.length === 0) {
      return { kind: 'global', label: 'user-default' };
    }
    if (wsFolders.length === 1) {
      const f = wsFolders[0];
      return { kind: 'workspace', root: f.uri.fsPath, label: `$(folder) ${f.name}` };
    }
    const folders = wsFolders.map((f) => ({
      label: `$(folder) ${f.name}`,
      description: f.uri.fsPath,
      root: f.uri.fsPath
    }));
    const pick = await vscode.window.showQuickPick(
      [{ label: '$(globe) User default (global)', description: '' }, ...folders],
      { placeHolder: 'Runtime target context' }
    );
    if (pick === undefined) {
      return undefined;
    }
    if (!('root' in pick) || pick.root === undefined) {
      return { kind: 'global', label: 'user-default' };
    }
    return { kind: 'workspace', root: pick.root, label: pick.label };
  }

  private async ensureContext(): Promise<UiContext | undefined> {
    if (this.disposed) {
      return undefined;
    }
    // Implicit contexts always track the current folders; only an explicit
    // multi-root pick is locked until the folder disappears.
    if (this.contextImplicit) {
      const implicit = this.implicitContext();
      if (implicit !== undefined) {
        if (this.context?.root !== implicit.root || this.context?.kind !== implicit.kind) {
          this.context = implicit;
          this.epoch += 1;
        }
        return this.context;
      }
      if (this.context !== undefined) {
        // Went from implicit single/global to multi-root: require a fresh pick.
        this.context = undefined;
        this.epoch += 1;
      }
    }
    if (this.context === undefined) {
      const epoch = this.epoch;
      const picked = await this.chooseContext();
      if (this.disposed || epoch !== this.epoch) {
        return undefined;
      }
      if (picked !== undefined) {
        this.context = picked;
        this.contextImplicit = false;
        this.epoch += 1;
      }
    }
    return this.context;
  }

  private root(ctx: UiContext): string | undefined {
    return ctx.kind === 'workspace' ? ctx.root : undefined;
  }

  private disposed = false;

  private async refreshStatus(): Promise<void> {
    if (this.disposed) {
      return;
    }
    try {
      const ctx = this.context;
      const epoch = this.epoch;
      if (ctx === undefined) {
        this.statusBar.text = 'Target: none';
        return;
      }
      const active = await this.controller.getActiveTarget(this.root(ctx));
      if (this.disposed || epoch !== this.epoch) {
        return;
      }
      this.statusBar.text = active === undefined
        ? 'Target: none'
        : `Target: ${active.instance.type}`;
      const srcLabel = active === undefined ? 'none' : (active.selection === 'workspace' ? 'workspace' : 'user-default');
      this.statusBar.tooltip = `${ctx.label} (${this.root(ctx) ?? 'user-default'}) · harness ${active?.instance.type ?? 'none'} · selection ${srcLabel} · `
        + `${active?.instance.root ?? ''}`
        + `${ctx.kind === 'workspace' ? ` · repository -> ${this.root(ctx)}` : ''}`;
    } catch (error) {
      this.logger.error('runtime-target status refresh failed', error as Error);
    }
  }

  private async showJson(title: string, data: unknown): Promise<void> {
    const doc = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(data, null, 1) });
    await vscode.window.showTextDocument(doc, { preview: true });
    void title;
  }

  private fail(action: string, error: unknown): void {
    const e = error as { code?: string; message?: string };
    const msg = `${e.code ?? ''} ${e.message ?? String(error)}`.trim();
    this.logger.error(`runtime-target ${action} failed: ${msg}`);
    void vscode.window.showErrorMessage(`Runtime target ${action}: ${msg}`);
  }

  private async runMutation(action: string, buildOp: (ctx: UiContext) => Promise<{ op: RuntimeOperation; invocation?: { scope: 'user' | 'repository' } } | undefined>): Promise<void> {
    const ctx = await this.ensureContext();
    if (ctx === undefined) {
      return; // cancelled at context pick — quiet, not an error
    }
    if (await this.legacy.blocked()) {
      return;
    }
    const root = this.root(ctx);
    const epoch = this.epoch;
    try {
      const built = await buildOp(ctx);
      if (built === undefined) {
        return; // ordinary cancellation
      }
      const { op, invocation } = built;
      const plan = await this.controller.plan(op, root, invocation);
      await this.showJson('runtime-target plan preview', plan);
      if (plan.conflicts.length > 0) {
        void vscode.window.showWarningMessage(`Plan has ${plan.conflicts.length} conflict(s); nothing applied.`);
        return;
      }
      if (!plan.canApply) {
        void vscode.window.showInformationMessage('Plan has no applicable changes; nothing applied.');
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Apply plan to ${plan.instance.root}?`, { modal: true }, 'Apply Preview'
      );
      if (confirm !== 'Apply Preview') {
        return;
      }
      // Re-check after the modal: folder removal/dispose must cancel the apply.
      if (epoch !== this.epoch || this.disposed) {
        void vscode.window.showErrorMessage('Context changed; re-preview before applying.');
        return;
      }
      const result = await this.controller.apply(op, plan.hash, root, invocation);
      await this.refreshStatus();
      this.notifyChanged();
      void vscode.window.showInformationMessage(`Applied: wrote ${result.written.length}, removed ${result.removed.length}, preserved ${result.preservedModified.length}`);
    } catch (error) {
      this.fail(action, error);
    }
  }

  private async pickDir(title: string): Promise<string | undefined> {
    const uri = await vscode.window.showOpenDialog({ title, canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Choose extracted bundle directory' });
    return uri?.[0]?.fsPath;
  }

  private async pickScope(ctx: UiContext): Promise<'user' | 'repository' | undefined> {
    const scopes = ctx.kind === 'workspace' ? ['user', 'repository'] : ['user'];
    if (scopes.length === 1) {
      return 'user';
    }
    const pick = await vscode.window.showQuickPick(scopes, { placeHolder: 'Target scope' });
    return pick === 'user' || pick === 'repository' ? pick : undefined;
  }

  public async select(): Promise<void> {
    if (this.disposed) {
      return;
    }
    // Select always resolves context fresh: implicit for 0/1 folders, an
    // explicit folder pick only when multiple roots are open.
    const ctx = this.implicitContext() ?? await this.chooseContext();
    if (ctx === undefined) {
      return;
    }
    this.context = ctx;
    this.contextImplicit = this.implicitContext() !== undefined;
    this.epoch += 1;
    const epoch = this.epoch;
    const root = this.root(ctx);
    try {
      const catalog = await this.controller.listTargets(root);
      const current = (await this.controller.getActiveTarget(root))?.instance;
      const typePick = await vscode.window.showQuickPick(
        catalog.map((t) => ({ label: t.type, picked: current?.type === t.type })),
        { placeHolder: 'Target type' }
      );
      if (typePick === undefined) {
        return;
      }
      const input: RuntimeTargetSelectionInput = {
        type: typePick.label,
        userDefault: ctx.kind === 'global'
      };
      if (this.disposed || epoch !== this.epoch) {
        void vscode.window.showErrorMessage('Context changed; select again.');
        return;
      }
      await this.controller.selectTarget(input, root);
      this.context = ctx;
      this.epoch += 1;
      await this.refreshStatus();
      this.notifyChanged();
      void vscode.window.showInformationMessage(`Target harness: ${typePick.label} (selection only — no files projected)`);
    } catch (error) {
      this.fail('select', error);
    }
  }

  public async installed(): Promise<void> {
    const ctx = await this.ensureContext();
    if (ctx === undefined) {
      return;
    }
    try {
      const root = this.root(ctx);
      await this.showJson('runtime-target installed', await this.controller.listInstallations(root));
    } catch (error) {
      this.fail('installed', error);
    }
  }

  public async available(): Promise<void> {
    const ctx = await this.ensureContext();
    if (ctx === undefined) {
      return;
    }
    try {
      await this.showJson('runtime-target available', await this.controller.listAvailableCollections(this.root(ctx)));
    } catch (error) {
      this.fail('available', error);
    }
  }

  public async importInstalled(): Promise<void> {
    const ctx = await this.ensureContext();
    if (ctx === undefined) {
      return;
    }
    const epoch = this.epoch;
    try {
      const dir = await this.pickDir('Import extracted bundle directory');
      if (dir === undefined) {
        return;
      }
      const sourceId = await vscode.window.showInputBox({ prompt: 'Source id', value: 'local' });
      if (sourceId === undefined) {
        return;
      }
      const { files } = await loadExtractedDirectory(dir);
      const confirm = await vscode.window.showWarningMessage('Import snapshot into the payload store? (no files projected)', { modal: true }, 'Import Snapshot');
      if (confirm !== 'Import Snapshot') {
        return;
      }
      if (this.disposed || epoch !== this.epoch) {
        return;
      }
      await this.controller.importInstalled({ files, sourceId, provenance: 'directory' }, this.root(ctx));
      void vscode.window.showInformationMessage('Import recorded');
    } catch (error) {
      this.fail('import', error);
    }
  }

  public async install(): Promise<void> {
    await this.runMutation('install', async (ctx) => {
      const dir = await this.pickDir('Install extracted bundle directory');
      if (dir === undefined) {
        return undefined;
      }
      const sourceId = await vscode.window.showInputBox({ prompt: 'Source id', value: 'local' });
      if (sourceId === undefined) {
        return undefined;
      }
      const { files, manifest } = await loadExtractedDirectory(dir);
      const scope = await this.pickScope(ctx);
      if (scope === undefined) {
        return undefined;
      }
      return { op: { kind: 'install', payload: { files, manifest, sourceId, source: { type: 'local', url: dir } } }, invocation: { scope } };
    });
  }

  /**
   * Pick one exact installation row (scope-spanning) for update/uninstall.
   * @param ctx
   * @param placeHolder
   */
  private async pickInstallation(ctx: UiContext, placeHolder: string) {
    const rows = await this.controller.listInstallations(this.root(ctx));
    const pick = await vscode.window.showQuickPick(
      rows.map((row) => ({
        label: `${row.manifestId}@${row.version}`,
        description: `${row.instance.scope} · ${row.instance.root}`,
        installationId: row.installationId,
        row
      })),
      { placeHolder }
    );
    return pick?.row;
  }

  public async update(): Promise<void> {
    await this.runMutation('update', async (ctx) => {
      const row = await this.pickInstallation(ctx, 'Collection to update');
      if (row === undefined) {
        return undefined;
      }
      const dir = await this.pickDir('Update from extracted bundle directory');
      if (dir === undefined) {
        return undefined;
      }
      const sourceId = await vscode.window.showInputBox({ prompt: 'Source id', value: row.sourceId });
      if (sourceId === undefined) {
        return undefined;
      }
      const { files, manifest } = await loadExtractedDirectory(dir);
      return {
        op: { kind: 'update', payload: { files, manifest, sourceId, source: { type: 'local', url: dir } }, installationId: row.installationId },
        invocation: { scope: row.instance.scope }
      };
    });
  }

  public async project(): Promise<void> {
    await this.runMutation('project', async (ctx) => {
      const available = await this.controller.listAvailableCollections(this.root(ctx));
      const sources = [...new Set(available.flatMap((c) => c.installedOn))];
      const pick = await vscode.window.showQuickPick(
        [{ label: '$(all) Union of all installed + imported' }, ...sources.map((s) => ({ label: s }))],
        { placeHolder: 'Projection source' }
      );
      if (pick === undefined) {
        return undefined;
      }
      const scope = await this.pickScope(ctx);
      if (scope === undefined) {
        return undefined;
      }
      return {
        op: pick.label.startsWith('$(') ? { kind: 'project' } : { kind: 'project', sourceTargetId: pick.label },
        invocation: { scope }
      };
    });
  }

  public async uninstall(): Promise<void> {
    await this.runMutation('uninstall', async (ctx) => {
      const row = await this.pickInstallation(ctx, 'Collection to uninstall');
      if (row === undefined) {
        return undefined;
      }
      return {
        op: { kind: 'uninstall', installationId: row.installationId, sourceId: row.sourceId, manifestId: row.manifestId },
        invocation: { scope: row.instance.scope }
      };
    });
  }

  public async verify(): Promise<void> {
    const ctx = await this.ensureContext();
    if (ctx === undefined) {
      return;
    }
    try {
      const root = this.root(ctx);
      const scopes: ('user' | 'repository')[] = ctx.kind === 'workspace' ? ['repository', 'user'] : ['user'];
      const results = await Promise.all(scopes.map((scope) => this.controller.verify(root, scope)));
      await this.showJson('runtime-target verify', results.flat());
    } catch (error) {
      this.fail('verify', error);
    }
  }

  public async lockfile(): Promise<void> {
    const ctx = await this.ensureContext();
    if (ctx === undefined) {
      return;
    }
    try {
      const lf = await this.controller.getLockfile(this.root(ctx));
      const display = lf === null ? { exists: false } : lf;
      await this.showJson('runtime-target lockfile', display);
    } catch (error) {
      this.fail('lockfile', error);
    }
  }

  /** Current target status-bar text (test-mode observation). */
  public statusText(): string {
    return this.statusBar.text;
  }

  /** Tell dependants (Marketplace, Explorer) that selection or installations changed. */
  public notifyChanged(): void {
    this.opts.registryManager?.refreshRuntimeInstallations?.();
    this.opts.onDidChange?.();
  }

  /** Re-read selection and refresh status plus dependants (external CLI change). */
  public async refreshFromDisk(): Promise<void> {
    await this.refreshStatus();
    this.notifyChanged();
  }

  public async refresh(): Promise<void> {
    await this.refreshStatus();
  }

  public registerCommands(): vscode.Disposable[] {
    const cmds: [string, () => Promise<void>][] = [
      ['promptregistry.runtimeTargetSelect', () => this.select()],
      ['promptregistry.runtimeTargetInstalled', () => this.installed()],
      ['promptregistry.runtimeTargetAvailable', () => this.available()],
      ['promptregistry.runtimeTargetImportInstalled', () => this.importInstalled()],
      ['promptregistry.runtimeTargetInstall', () => this.install()],
      ['promptregistry.runtimeTargetUpdate', () => this.update()],
      ['promptregistry.runtimeTargetProject', () => this.project()],
      ['promptregistry.runtimeTargetUninstall', () => this.uninstall()],
      ['promptregistry.runtimeTargetVerify', () => this.verify()],
      ['promptregistry.runtimeTargetLockfile', () => this.lockfile()],
      ['promptregistry.runtimeTargetRefresh', () => this.refresh()],
      ['promptregistry.migrateLockfile', () => this.migrateLockfile()]
    ];
    const disposables = cmds.map(([id, fn]) => vscode.commands.registerCommand(id, fn));
    this.disposables.push(...disposables);
    return disposables;
  }
}

/**
 * Registration: composes the default factory from env and wires commands+status.
 * @param context
 * @param opts
 */
export function registerRuntimeTargetCommands(
  context: Pick<vscode.ExtensionContext, 'subscriptions'>,
  opts: RuntimeTargetCommandsOptions
): RuntimeTargetCommands {
  void vscode.commands.executeCommand('setContext', RUNTIME_TARGET_CONTEXT_KEY, true);
  const commands = new RuntimeTargetCommands(opts);
  commands.registerCommands();
  context.subscriptions.push(commands);
  return commands;
}
