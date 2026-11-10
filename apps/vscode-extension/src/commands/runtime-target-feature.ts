/**
 * registerRuntimeTargetFeature — opt-in target management UI.
 *
 * Enabled only by the `promptregistry.experimental.runtimeTargetManagement`
 * application setting (default off). When off: only the configure command
 * exists — no target handlers, sessions or storage IO.
 * @module commands/runtime-target-feature
 */
import * as vscode from 'vscode';
import {
  createRuntimeTargetSessionFactory,
  registerRuntimeTargetCommands,
  RUNTIME_TARGET_CONTEXT_KEY,
  type RuntimeTargetCommands,
  type RuntimeTargetCommandsOptions,
} from './runtime-target-commands';
import {
  watchTargetFiles,
} from './runtime-target-watch';

export const RUNTIME_TARGET_SETTING = 'promptregistry.experimental.runtimeTargetManagement';
export const CONFIGURE_COMMAND_ID = 'promptregistry.configureTargetManagement';

/** Wrapper controlling feature enablement; owns hint/configure/controls. */
export class RuntimeTargetFeature implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private active: RuntimeTargetCommands | undefined;
  private watcher: vscode.Disposable | undefined;
  private enabled = false;
  private disposed = false;

  public constructor(private readonly opts: RuntimeTargetCommandsOptions) {
    this.disposables.push(vscode.commands.registerCommand(CONFIGURE_COMMAND_ID, async () => {
      await vscode.commands.executeCommand('workbench.action.openSettings', `@id:${RUNTIME_TARGET_SETTING}`);
    }), vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(RUNTIME_TARGET_SETTING)) {
        this.reconcile();
      }
    }));
    // Cold start off: explicitly clear a stale context key before reconcile.
    void vscode.commands.executeCommand('setContext', RUNTIME_TARGET_CONTEXT_KEY, false);
    this.reconcile();
  }

  private settingOn(): boolean {
    return vscode.workspace.getConfiguration('promptregistry').get<boolean>('experimental.runtimeTargetManagement', false) === true;
  }

  private reconcile(): void {
    if (this.disposed) {
      return;
    }
    const next = this.settingOn();
    if (next === this.enabled) {
      return;
    }
    this.enabled = next;
    if (next) {
      const local: Pick<vscode.ExtensionContext, 'subscriptions'> = { subscriptions: [] };
      this.active = registerRuntimeTargetCommands(local, this.opts);
      const commands = this.active;
      this.watcher = watchTargetFiles(this.opts.env, () => void commands.refreshFromDisk());
      void commands.checkLegacyLockfile();
      this.opts.registryManager?.setRuntimeTargetManagement?.(
        {
          sessionFactory: this.opts.sessionFactory ?? createRuntimeTargetSessionFactory(this.opts.env),
          getContextRoot: () => this.active!.getContextRoot(),
          hasContext: () => this.active!.hasContext(),
          actionContext: async () => this.active!.actionContext(),
          blockedByLegacy: async () => this.active!.blockedByLegacyLockfile()
        }
      );
    } else {
      this.opts.registryManager?.setRuntimeTargetManagement?.(undefined);
      this.watcher?.dispose();
      this.watcher = undefined;
      this.active?.dispose();
      this.active = undefined;
    }
  }

  /** Current target status text; empty while the feature is off (test-mode observation). */
  public statusText(): string {
    return this.active?.statusText() ?? '';
  }

  /** Re-run startup detection (legacy lockfile prompt). */
  public async runStartupChecks(): Promise<void> {
    await this.active?.checkLegacyLockfile();
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.opts.registryManager?.setRuntimeTargetManagement?.(undefined);
    this.watcher?.dispose();
    this.active?.dispose();
    this.active = undefined;
    void vscode.commands.executeCommand('setContext', RUNTIME_TARGET_CONTEXT_KEY, false);
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

/**
 * Feature registration: always adds the configure command; toggles the
 * command set without restarting.
 * @param context
 * @param opts
 */
export function registerRuntimeTargetFeature(
  context: Pick<vscode.ExtensionContext, 'subscriptions'>,
  opts: RuntimeTargetCommandsOptions
): RuntimeTargetFeature {
  const feature = new RuntimeTargetFeature(opts);
  context.subscriptions.push(feature);
  return feature;
}
