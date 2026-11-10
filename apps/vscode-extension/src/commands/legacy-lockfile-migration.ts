/**
 * Guided legacy lockfile migration UI: detect a v2 lockfile, insist on
 * migrating (Migrate Now / Preview / Later, no permanent dismissal), and run
 * the shared migration with one harness question per ambiguous candidate set.
 * @module commands/legacy-lockfile-migration
 */
import type {
  RuntimeTargetSession,
} from '@ai-primitives-hub/app';
import type {
  TargetType,
} from '@ai-primitives-hub/core';
import * as vscode from 'vscode';
import {
  Logger,
} from '../utils/logger';

export const LEGACY_LOCKFILE_MESSAGE = 'This workspace uses a legacy lockfile (prompt-registry.lock.json, v2). '
  + 'Migrate it to the multi-target format to keep managing installations; installs, updates and uninstalls are blocked until then.';

export interface LegacyLockfileMigrationOptions {
  getRoot(): string | undefined;
  sessionFactory(workspaceRoot?: string): RuntimeTargetSession;
  onChanged(): void;
}

export class LegacyLockfileMigration {
  private readonly logger = Logger.getInstance();

  public constructor(private readonly deps: LegacyLockfileMigrationOptions) {}

  private session(): RuntimeTargetSession | undefined {
    const root = this.deps.getRoot();
    return root === undefined ? undefined : this.deps.sessionFactory(root);
  }

  private async preview(): Promise<void> {
    const plan = await this.session()!.planLegacyMigration();
    const doc = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(plan, null, 1) });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  /** Whether a legacy lockfile is present for the current workspace. */
  public async isLegacy(): Promise<boolean> {
    const session = this.session();
    return session !== undefined && session.hasLegacyLockfile();
  }

  /** Prompt (per session, never permanently dismissed) when a legacy lockfile is present. */
  public async check(): Promise<void> {
    try {
      while (await this.isLegacy()) {
        const choice = await vscode.window.showWarningMessage(LEGACY_LOCKFILE_MESSAGE, 'Migrate Now', 'Preview', 'Later');
        if (choice === 'Migrate Now') {
          await this.migrate();
          return;
        }
        if (choice === 'Preview') {
          await this.preview();
          continue;
        }
        return;
      }
    } catch (error) {
      this.logger.error('Legacy lockfile check failed', error as Error);
    }
  }

  /** Guard for mutations: prompts, then reports whether the workspace is still blocked. */
  public async blocked(): Promise<boolean> {
    if (!await this.isLegacy()) {
      return false;
    }
    await this.check();
    return this.isLegacy();
  }

  /** Command: plan, ask once per ambiguous candidate set, confirm, apply, explain what to commit. */
  public async migrate(): Promise<void> {
    const session = this.session();
    if (session === undefined) {
      void vscode.window.showInformationMessage('Open a workspace folder to migrate its lockfile.');
      return;
    }
    try {
      const plan = await session.planLegacyMigration();
      if (plan.lockfiles.length === 0) {
        void vscode.window.showInformationMessage('No legacy lockfile found in this workspace.');
        return;
      }
      const choices: Record<string, TargetType> = {};
      for (const set of plan.ambiguousSets) {
        const names = plan.entries.filter((e) => e.outcome === 'ambiguous' && e.candidates.join(',') === set.join(',')).map((e) => e.bundleId);
        const picked = await vscode.window.showQuickPick(
          set.map((type) => ({ label: type })),
          { placeHolder: `Select the harness that owns ${names.join(', ')} (files are shared by ${set.join(', ')})`, title: 'Migrate lockfile: choose harness' }
        );
        if (picked === undefined) {
          return;
        }
        choices[set.join(',')] = picked.label;
      }
      const migrating = plan.entries.filter((e) => e.outcome !== 'skipped');
      const skipped = plan.entries.filter((e) => e.outcome === 'skipped');
      const lines = [
        `Migrate ${migrating.length} entr${migrating.length === 1 ? 'y' : 'ies'} to the multi-target lockfile format?`,
        ...migrating.map((e) => `  • ${e.bundleId}@${e.version} → ${e.outcome === 'ready' ? e.candidates[0] : choices[e.candidates.join(',')]}`),
        ...(skipped.length === 0 ? [] : ['', 'Left untouched and not managed (reinstall them later):', ...skipped.map((e) => `  • ${e.bundleId}: ${e.reason}`)]),
        '', 'The original v2 file is backed up first.'
      ];
      const confirmed = await vscode.window.showWarningMessage(lines.join('\n'), { modal: true }, 'Migrate');
      if (confirmed !== 'Migrate') {
        return;
      }
      const result = await session.applyLegacyMigration(plan, choices);
      const summary = [`Migrated ${result.migrated.length} entries. The original v2 lockfile is backed up at ${result.backup}.`];
      if (result.commitGuidance !== undefined) {
        summary.push(result.commitGuidance);
      }
      void vscode.window.showInformationMessage(summary.join(' '));
      if (result.skipped.length > 0) {
        void vscode.window.showInformationMessage(`Not migrated: ${result.skipped.map((s) => `${s.bundleId} (${s.reason})`).join('; ')}`);
      }
      this.deps.onChanged();
    } catch (error) {
      this.logger.error('Lockfile migration failed', error as Error);
      void vscode.window.showErrorMessage(`Lockfile migration failed: ${(error as Error).message}`);
    }
  }
}
