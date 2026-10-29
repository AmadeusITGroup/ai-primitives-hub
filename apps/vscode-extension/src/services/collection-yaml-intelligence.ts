/**
 * CollectionYamlIntelligence — Live VS Code YAML editor integration for
 * `*.collection.yml` and `*.collection.yaml` files.
 *
 * Provides:
 * - On-the-fly `DiagnosticCollection` squiggles (schema, domain, missing files,
 *   kind-route mismatch, plugin manifests, and cross-collection duplicates)
 * - Inline ghost-text `TextEditorDecorationType` hints
 * - `CodeLensProvider` inline action buttons
 * - `CodeActionProvider` quick fixes (`Ctrl+.`)
 */
import * as path from 'node:path';
import type {
  CollectionDocumentInspection,
  CollectionEditorService,
} from '@ai-primitives-hub/app';
import * as vscode from 'vscode';

const COLLECTION_FILE_PATTERN = /\.collection\.ya?ml$/i;

export class CollectionYamlIntelligence implements vscode.CodeLensProvider, vscode.CodeActionProvider, vscode.Disposable {
  private readonly diagnosticCollection: vscode.DiagnosticCollection;
  private readonly decorationType: vscode.TextEditorDecorationType;
  private readonly inspectionsByUri = new Map<string, CollectionDocumentInspection>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  private readonly _onDidInspectDocument = new vscode.EventEmitter<{
    uri: vscode.Uri;
    content: string;
    inspection: CollectionDocumentInspection;
  }>();

  public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
  public readonly onDidInspectDocument = this._onDidInspectDocument.event;

  constructor(private readonly editorService: CollectionEditorService) {
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection('promptRegistryCollection');
    this.decorationType = vscode.window.createTextEditorDecorationType({
      after: {
        margin: '0 0 0 1.5rem',
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        fontStyle: 'italic'
      },
      isWholeLine: true
    });
  }

  private toVsCodeSeverity(severity: 'error' | 'warning' | 'info'): vscode.DiagnosticSeverity {
    switch (severity) {
      case 'error': {
        return vscode.DiagnosticSeverity.Error;
      }
      case 'warning': {
        return vscode.DiagnosticSeverity.Warning;
      }
      case 'info': {
        return vscode.DiagnosticSeverity.Information;
      }
    }
  }

  private resolveWorkspaceRoot(filePath: string): string | undefined {
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (wsFolder && filePath.startsWith(wsFolder)) {
      return wsFolder;
    }
    const parent = path.dirname(filePath);
    if (path.basename(parent) === 'collections') {
      return path.dirname(parent);
    }
    return wsFolder ?? parent;
  }

  private applyDecorationsToVisibleEditors(uri: vscode.Uri, inspection: CollectionDocumentInspection): void {
    const editors = vscode.window.visibleTextEditors ?? [];
    for (const editor of editors) {
      if (
        editor.document.uri.fsPath !== uri.fsPath
        || (editor.document.uri.scheme && editor.document.uri.scheme !== 'file' && editor.document.uri.scheme !== 'untitled')
      ) {
        continue;
      }
      const options: vscode.DecorationOptions[] = inspection.inlineDecorations
        .filter((d) => d.line >= 0 && d.line < editor.document.lineCount)
        .map((d) => {
          const line = editor.document.lineAt(d.line);
          return {
            range: line.range,
            renderOptions: {
              after: {
                contentText: `  # ${d.text}`
              }
            }
          };
        });
      if (typeof editor.setDecorations === 'function') {
        editor.setDecorations(this.decorationType, options);
      }
    }
  }

  public isCollectionDocument(document: vscode.TextDocument): boolean {
    if (document.uri.scheme && document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') {
      return false;
    }
    return COLLECTION_FILE_PATTERN.test(document.fileName || document.uri.fsPath);
  }

  /**
   * Register document listeners, CodeLens provider, and CodeAction provider.
   * @param context Extension context.
   */
  public register(context: vscode.ExtensionContext): void {
    const selector: vscode.DocumentSelector = [
      { scheme: 'file', language: 'yaml', pattern: '**/*.collection.{yml,yaml}' },
      { scheme: 'file', pattern: '**/*.collection.{yml,yaml}' }
    ];

    this.disposables.push(
      vscode.languages.registerCodeLensProvider(selector, this),
      vscode.languages.registerCodeActionsProvider(selector, this, {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
      }),
      vscode.workspace.onDidOpenTextDocument((doc) => {
        if (this.isCollectionDocument(doc)) {
          this.validateDocument(doc);
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.isCollectionDocument(event.document)) {
          this.validateDocument(event.document);
        }
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (this.isCollectionDocument(doc)) {
          this.validateDocument(doc);
        }
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && this.isCollectionDocument(editor.document)) {
          this.validateDocument(editor.document);
        }
      })
    );

    for (const doc of (vscode.workspace.textDocuments ?? [])) {
      if (this.isCollectionDocument(doc)) {
        this.validateDocument(doc);
      }
    }

    context.subscriptions.push(this);
  }

  /**
   * Validate a `.collection.yml` `TextDocument` and publish diagnostics and
   * inline decorations.
   * @param document Document to validate.
   */
  public validateDocument(document: vscode.TextDocument): CollectionDocumentInspection {
    const content = document.getText();
    const workspaceRoot = this.resolveWorkspaceRoot(document.uri.fsPath);
    const inspection = this.editorService.inspectDocument(content, {
      filePath: document.uri.fsPath,
      workspaceRoot
    });
    this.publishInspection(document.uri, content, inspection);
    return inspection;
  }

  /**
   * Publish an already-computed inspection to diagnostics, inline decorations,
   * and listeners.
   * @param uri Document URI.
   * @param content Document text.
   * @param inspection Computed inspection result.
   */
  public publishInspection(
    uri: vscode.Uri,
    content: string,
    inspection: CollectionDocumentInspection
  ): void {
    this.inspectionsByUri.set(uri.fsPath, inspection);

    const vsDiagnostics: vscode.Diagnostic[] = inspection.diagnostics.map((d) => {
      const range = d.range
        ? new vscode.Range(d.range.startLine, d.range.startColumn, d.range.endLine, d.range.endColumn)
        : new vscode.Range(0, 0, 0, 1);
      const diag = new vscode.Diagnostic(range, d.message, this.toVsCodeSeverity(d.severity));
      diag.code = d.code;
      diag.source = 'AI Primitives Hub (Collection)';
      return diag;
    });

    this.diagnosticCollection.set(uri, vsDiagnostics);
    this.applyDecorationsToVisibleEditors(uri, inspection);
    this._onDidChangeCodeLenses.fire();
    this._onDidInspectDocument.fire({ uri, content, inspection });
  }

  public getDiagnostics(uri: vscode.Uri): readonly vscode.Diagnostic[] | undefined {
    return this.diagnosticCollection.get(uri);
  }

  public getLastInspection(fsPath: string): CollectionDocumentInspection | undefined {
    return this.inspectionsByUri.get(fsPath);
  }

  public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.isCollectionDocument(document)) {
      return [];
    }

    const inspection = this.inspectionsByUri.get(document.uri.fsPath) ?? this.validateDocument(document);
    const lenses: vscode.CodeLens[] = [];
    const topRange = new vscode.Range(0, 0, 0, 0);

    lenses.push(
      new vscode.CodeLens(topRange, {
        title: '$(open-preview) Open in Visual Collection Editor',
        command: 'promptregistry.openCollectionVisualEditor',
        arguments: [document.uri]
      }),
      new vscode.CodeLens(topRange, {
        title: inspection.valid
          ? '$(check-all) Validate All Collections'
          : `$(warning) ${inspection.errors.length} Validation Issue(s) — Run Collection Validator`,
        command: 'promptRegistry.validateCollections'
      }),
      new vscode.CodeLens(topRange, {
        title: '$(git-pull-request) Commit & Create Pull Request',
        command: 'promptregistry.submitCollectionPullRequest',
        arguments: [document.uri]
      })
    );

    const versionRange = inspection.nodeRanges.get('version') ?? inspection.nodeRanges.get('id');
    if (versionRange) {
      lenses.push(
        new vscode.CodeLens(
          new vscode.Range(versionRange.startLine, 0, versionRange.startLine, 0),
          {
            title: '$(versions) Bump Version',
            command: 'promptregistry.bumpCollectionVersion',
            arguments: [document.uri]
          }
        )
      );
    }

    const itemsRange = inspection.nodeRanges.get('items');
    if (itemsRange) {
      lenses.push(
        new vscode.CodeLens(
          new vscode.Range(itemsRange.startLine, 0, itemsRange.startLine, 0),
          {
            title: '$(add) Create or Add Primitive Item',
            command: 'promptregistry.addCollectionItemVisual',
            arguments: [document.uri]
          }
        )
      );
    }

    inspection.itemStatuses.forEach((status, idx) => {
      const itemRange = inspection.nodeRanges.get(`items.${idx}`);
      if (!itemRange) {
        return;
      }
      const lineRange = new vscode.Range(itemRange.startLine, 0, itemRange.startLine, 0);
      if (status.exists) {
        lenses.push(
          new vscode.CodeLens(lineRange, {
            title: `$(go-to-file) Open ${status.path}`,
            command: 'promptregistry.openCollectionItemFile',
            arguments: [document.uri, status.path]
          })
        );
      } else if (status.path) {
        lenses.push(
          new vscode.CodeLens(lineRange, {
            title: `$(new-file) Create Missing File (${status.path})`,
            command: 'promptregistry.scaffoldMissingCollectionFile',
            arguments: [document.uri, status.path, status.kind]
          })
        );
      }
    });

    return lenses;
  }

  public provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection
  ): vscode.CodeAction[] {
    if (!this.isCollectionDocument(document)) {
      return [];
    }

    const inspection = this.inspectionsByUri.get(document.uri.fsPath) ?? this.validateDocument(document);
    const actions: vscode.CodeAction[] = [];

    for (const diag of inspection.diagnostics) {
      if (!diag.quickFix || !diag.range) {
        continue;
      }
      const diagRange = new vscode.Range(
        diag.range.startLine,
        diag.range.startColumn,
        diag.range.endLine,
        diag.range.endColumn
      );
      const intersects = diagRange.intersection(range) !== undefined
        || (range.start.line >= diag.range.startLine && range.start.line <= diag.range.endLine);
      if (!intersects) {
        continue;
      }

      const action = new vscode.CodeAction(
        diag.quickFix.title,
        vscode.CodeActionKind.QuickFix
      );
      action.isPreferred = true;

      if (diag.quickFix.kind === 'scaffold-missing-item' && diag.quickFix.filePath) {
        action.command = {
          title: diag.quickFix.title,
          command: 'promptregistry.scaffoldMissingCollectionFile',
          arguments: [document.uri, diag.quickFix.filePath, diag.quickFix.itemKind ?? 'prompt']
        };
      } else if (diag.quickFix.kind === 'scaffold-missing-readme' && diag.quickFix.filePath) {
        action.command = {
          title: diag.quickFix.title,
          command: 'promptregistry.scaffoldMissingCollectionFile',
          arguments: [document.uri, diag.quickFix.filePath, 'readme']
        };
      } else {
        const { updatedContent } = this.editorService.applyMutation(document.getText(), {
          kind: 'apply-quick-fix',
          quickFix: diag.quickFix
        });
        const fullRange = new vscode.Range(
          0,
          0,
          Math.max(0, document.lineCount - 1),
          document.lineAt(Math.max(0, document.lineCount - 1)).text.length
        );
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, fullRange, updatedContent);
        action.edit = edit;
      }

      actions.push(action);
    }

    return actions;
  }

  public dispose(): void {
    this.diagnosticCollection.dispose();
    this.decorationType.dispose();
    this._onDidChangeCodeLenses.dispose();
    this._onDidInspectDocument.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}
