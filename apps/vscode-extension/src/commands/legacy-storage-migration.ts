/**
 * Legacy IDE global storage: detect, insist on migrating (Migrate Now / Later,
 * re-prompted every activation), and copy it into the shared XDG layout. The
 * legacy root is only read; until it is migrated the extension runs on XDG only.
 * @module commands/legacy-storage-migration
 */
import * as path from 'node:path';
import {
  detectLegacyStorage,
  getLegacyStorageConflictNotice,
  type LegacyStorageDeps,
  markLegacyStorageConflictsNotified,
  migrateLegacyStorage,
} from '@ai-primitives-hub/app';
import type {
  AppStorage,
} from '@ai-primitives-hub/core';
import {
  NodeFileSystem,
} from '@ai-primitives-hub/infra';
import * as vscode from 'vscode';
import {
  createExtensionStorage,
} from '../storage/extension-storage';
import {
  Logger,
} from '../utils/logger';

export interface LegacyStorageMigrationOptions {
  /** The IDE's legacy global storage directory (`context.globalStorageUri.fsPath`). */
  legacyRoot: string;
  env?: Record<string, string | undefined>;
  storage?: AppStorage;
  /** Called after a successful migration so caches re-read XDG. */
  onMigrated?: () => Promise<void> | void;
}

export class LegacyStorageMigration {
  private readonly logger = Logger.getInstance();

  public constructor(private readonly options: LegacyStorageMigrationOptions) {}

  private deps() {
    const env = { ...(this.options.env ?? process.env) };
    return { fs: new NodeFileSystem(), storage: this.options.storage ?? createExtensionStorage(env), env };
  }

  private async reportPreviousConflicts(deps: LegacyStorageDeps): Promise<void> {
    const notice = await getLegacyStorageConflictNotice(deps, this.options.legacyRoot);
    if (notice === undefined) {
      return;
    }
    const parts = ['A previous storage migration found conflicts and kept the existing shared XDG data.'];
    if (notice.legacyHubId !== undefined && notice.sharedHubId !== undefined) {
      parts.push(`The legacy IDE selected hub "${notice.legacyHubId}", but shared XDG kept "${notice.sharedHubId}".`);
    }
    if (notice.otherConflicts > 0) {
      parts.push(`${notice.otherConflicts} other conflicting entries also kept the existing shared data.`);
    }
    await vscode.window.showInformationMessage(parts.join(' '));
    await markLegacyStorageConflictsNotified(deps, this.options.legacyRoot);
  }

  /** Prompt when legacy storage still needs migrating; never dismissed permanently. */
  public async check(): Promise<void> {
    try {
      const deps = this.deps();
      const detection = await detectLegacyStorage(deps, this.options.legacyRoot);
      if (detection.completed) {
        await this.reportPreviousConflicts(deps);
        return;
      }
      if (!detection.present) {
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        'Legacy storage found: this IDE still holds AI Primitives Hub data in its legacy location. '
        + 'Migrate it to the shared location used by the CLI and other IDEs (the legacy files are copied, never changed).',
        'Migrate Now',
        'Later'
      );
      if (choice === 'Migrate Now') {
        await this.migrate();
      }
    } catch (error) {
      this.logger.error('Legacy storage check failed', error as Error);
    }
  }

  /** Copy the legacy root into XDG and report merges and conflicts. */
  public async migrate(): Promise<void> {
    try {
      const result = await migrateLegacyStorage(this.deps(), { legacyRoot: this.options.legacyRoot, host: vscode.env.appName });
      await this.options.onMigrated?.();
      const parts = [`Migrated legacy storage: ${result.copied.length} copied, ${result.merged.length} merged.`];
      const activeHubConflict = result.conflicts.find((conflict) => path.basename(conflict.path) === 'active-hub.json');
      if (activeHubConflict !== undefined) {
        parts.push(`Active hub conflict: ${activeHubConflict.reason}.`);
      }
      const otherConflicts = result.conflicts.filter((conflict) => conflict !== activeHubConflict);
      if (otherConflicts.length > 0) {
        parts.push(`${otherConflicts.length} other conflict(s) kept existing shared data: ${
          otherConflicts.map((conflict) => `${path.basename(conflict.path)} (${conflict.reason})`).join('; ')
        }.`);
      }
      await vscode.window.showInformationMessage(parts.join(' '));
      if (result.conflicts.length > 0) {
        await markLegacyStorageConflictsNotified(this.deps(), this.options.legacyRoot);
      }
    } catch (error) {
      this.logger.error('Legacy storage migration failed', error as Error);
      void vscode.window.showErrorMessage(`Legacy storage migration failed: ${(error as Error).message}`);
    }
  }
}
