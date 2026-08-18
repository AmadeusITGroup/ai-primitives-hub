/**
 * Primitive search command.
 *
 * The command is intentionally a thin VS Code adapter: ranking, filtering,
 * facets, and persisted-index compatibility are owned by the shared app and
 * infra packages.
 */
import type {
  Primitive,
} from '@ai-primitives-hub/core';
import type {
  SearchHit,
} from '@ai-primitives-hub/infra';
import * as vscode from 'vscode';
import {
  PrimitiveIndexService,
} from '../services/primitive-index-service';
import {
  ErrorHandler,
} from '../utils/error-handler';

interface PrimitivePick extends vscode.QuickPickItem {
  primitive: Primitive;
}

/** Presents shared-index primitive search through a VS Code QuickPick. */
export class PrimitiveSearchCommand {
  public constructor(private readonly indexService: PrimitiveIndexService) {}

  private createPick(hit: SearchHit): PrimitivePick {
    const { primitive } = hit;
    const installed = primitive.bundle.installed;
    return {
      label: `${primitive.title}  ${installed ? '$(check)' : ''}`.trim(),
      description: `${primitive.kind} · ${primitive.bundle.bundleId}@${primitive.bundle.bundleVersion}`,
      detail: [
        primitive.description || primitive.bodyPreview,
        `Source: ${primitive.bundle.sourceId}${installed ? ' · Installed' : ''}`
      ].filter(Boolean).join(' — '),
      primitive
    };
  }

  private async showActions(primitive: Primitive): Promise<void> {
    const action = await vscode.window.showQuickPick([
      ...(primitive.bundle.installed
        ? []
        : [{
          label: '$(cloud-download) Install bundle',
          description: `${primitive.bundle.bundleId}@${primitive.bundle.bundleVersion}`,
          value: 'install'
        }]),
      {
        label: '$(info) Show primitive details',
        description: primitive.path,
        value: 'details'
      }
    ], {
      title: primitive.title,
      placeHolder: 'Choose an action',
      ignoreFocusOut: true
    });

    if (action?.value === 'install') {
      await vscode.commands.executeCommand('promptRegistry.installBundle', primitive.bundle.bundleId);
    } else if (action?.value === 'details') {
      await vscode.window.showInformationMessage(
        `${primitive.title}\n\n${primitive.description || primitive.bodyPreview}\n\n${primitive.path}`
      );
    }
  }

  /** Search indexed primitives and present the matching results. */
  public async search(): Promise<void> {
    try {
      const query = await vscode.window.showInputBox({
        prompt: 'Search indexed primitives',
        placeHolder: 'e.g., review pull requests',
        ignoreFocusOut: true
      });
      if (!query?.trim()) {
        return;
      }

      // Search is read-only. Index construction is handled by the lifecycle
      // scheduler or the explicit rebuild command, never by a search request.
      const result = await this.indexService.search({ q: query.trim(), limit: 50 });
      if (result.hits.length === 0) {
        await vscode.window.showInformationMessage(`No primitives found for "${query.trim()}"`);
        return;
      }

      const selected = await vscode.window.showQuickPick(
        result.hits.map((hit) => this.createPick(hit)),
        {
          title: `Primitive Search (${result.total} matches)`,
          placeHolder: 'Select a primitive',
          matchOnDescription: true,
          matchOnDetail: true,
          ignoreFocusOut: true
        }
      );
      if (selected) {
        await this.showActions(selected.primitive);
      }
    } catch (error) {
      await ErrorHandler.handle(error, {
        operation: 'search primitives',
        showUserMessage: true,
        userMessagePrefix: 'Failed to search primitives'
      });
    }
  }

  /** Rebuild the shared primitive index immediately. */
  public async rebuild(): Promise<void> {
    try {
      const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Rebuilding Primitive Index',
        cancellable: false
      }, async (progress) => {
        progress.report({ message: `Using ${this.indexService.getProfile()}` });
        return this.indexService.rebuild();
      });
      await vscode.window.showInformationMessage(
        `Primitive index rebuilt: ${result.primitives} primitives from ${result.bundles} bundles.`
      );
    } catch (error) {
      await ErrorHandler.handle(error, {
        operation: 'rebuild primitive index',
        showUserMessage: true,
        userMessagePrefix: 'Failed to rebuild primitive index'
      });
    }
  }
}
