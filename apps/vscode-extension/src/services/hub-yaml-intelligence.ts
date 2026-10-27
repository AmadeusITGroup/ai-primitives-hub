/**
 * HubYamlIntelligence — Live VS Code YAML editor integration for `hub-config.yml`.
 *
 * Provides:
 * - On-the-fly `DiagnosticCollection` squiggles (static + deep validation)
 * - Inline ghost-text `TextEditorDecorationType` hints
 * - `CodeLensProvider` inline action buttons
 * - `CodeActionProvider` quick fixes (`Ctrl+.`)
 */
import type {
  HubConfigDocumentInspection,
  HubConfigEditorService,
} from '@ai-primitives-hub/app';
import * as vscode from 'vscode';

const HUB_CONFIG_PATTERN = /(?:^|[/\\])hub-config\.ya?ml$/i;

export class HubYamlIntelligence implements vscode.CodeLensProvider, vscode.CodeActionProvider, vscode.Disposable {
  private readonly diagnosticCollection: vscode.DiagnosticCollection;
  private readonly decorationType: vscode.TextEditorDecorationType;
  private readonly inspectionsByUri = new Map<string, HubConfigDocumentInspection>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  private readonly _onDidInspectDocument = new vscode.EventEmitter<{
    uri: vscode.Uri;
    content: string;
    inspection: HubConfigDocumentInspection;
  }>();

  public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
  public readonly onDidInspectDocument = this._onDidInspectDocument.event;

  constructor(private readonly editorService: HubConfigEditorService) {
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection('promptRegistryHubConfig');
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

  private applyDecorationsToVisibleEditors(uri: vscode.Uri, inspection: HubConfigDocumentInspection): void {
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
      editor.setDecorations(this.decorationType, options);
    }
  }

  public isHubConfigDocument(document: vscode.TextDocument): boolean {
    if (document.uri.scheme && document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') {
      return false;
    }
    return HUB_CONFIG_PATTERN.test(document.fileName || document.uri.fsPath);
  }

  /**
   * Register document listeners, CodeLens provider, and CodeAction provider.
   * @param context Extension context.
   */
  public register(context: vscode.ExtensionContext): void {
    const selector: vscode.DocumentSelector = [
      { scheme: 'file', language: 'yaml', pattern: '**/hub-config.{yml,yaml}' },
      { scheme: 'file', pattern: '**/hub-config.{yml,yaml}' }
    ];

    this.disposables.push(
      vscode.languages.registerCodeLensProvider(selector, this),
      vscode.languages.registerCodeActionsProvider(selector, this, {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
      }),
      vscode.workspace.onDidOpenTextDocument((doc) => {
        if (this.isHubConfigDocument(doc)) {
          this.validateDocument(doc);
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.isHubConfigDocument(event.document)) {
          this.validateDocument(event.document);
        }
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (this.isHubConfigDocument(doc)) {
          this.validateDocument(doc);
        }
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && this.isHubConfigDocument(editor.document)) {
          this.validateDocument(editor.document);
        }
      })
    );

    for (const doc of (vscode.workspace.textDocuments ?? [])) {
      if (this.isHubConfigDocument(doc)) {
        this.validateDocument(doc);
      }
    }

    context.subscriptions.push(this);
  }

  /**
   * Validate a `hub-config.yml` `TextDocument` and publish diagnostics and
   * inline decorations.
   * @param document Document to validate.
   */
  public validateDocument(document: vscode.TextDocument): HubConfigDocumentInspection {
    const content = document.getText();
    const inspection = this.editorService.inspectDocument(content);
    this.publishInspection(document.uri, content, inspection);
    return inspection;
  }

  /**
   * Publish an already-computed inspection (such as after deep validation)
   * to diagnostics, inline decorations, and listeners.
   * @param uri Document URI.
   * @param content Document text.
   * @param inspection Computed inspection result.
   */
  public publishInspection(
    uri: vscode.Uri,
    content: string,
    inspection: HubConfigDocumentInspection
  ): void {
    this.inspectionsByUri.set(uri.fsPath, inspection);

    const vsDiagnostics: vscode.Diagnostic[] = inspection.diagnostics.map((d) => {
      const range = d.range
        ? new vscode.Range(d.range.startLine, d.range.startColumn, d.range.endLine, d.range.endColumn)
        : new vscode.Range(0, 0, 0, 1);
      const diag = new vscode.Diagnostic(range, d.message, this.toVsCodeSeverity(d.severity));
      diag.code = d.code;
      diag.source = 'AI Primitives Hub';
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

  public getLastInspection(fsPath: string): HubConfigDocumentInspection | undefined {
    return this.inspectionsByUri.get(fsPath);
  }

  public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.isHubConfigDocument(document)) {
      return [];
    }

    const inspection = this.inspectionsByUri.get(document.uri.fsPath) ?? this.validateDocument(document);
    const lenses: vscode.CodeLens[] = [];
    const topRange = new vscode.Range(0, 0, 0, 0);

    lenses.push(
      new vscode.CodeLens(topRange, {
        title: '$(open-preview) Open in Visual Hub Editor',
        command: 'promptregistry.openHubVisualEditor',
        arguments: [document.uri]
      }),
      new vscode.CodeLens(topRange, {
        title: inspection.valid
          ? '$(check-all) Deep Validate Sources & Catalogs'
          : `$(warning) ${inspection.errors.length} Validation Issue(s) — Run Deep Check`,
        command: 'promptregistry.validateHubConfig',
        arguments: [document.uri]
      }),
      new vscode.CodeLens(topRange, {
        title: '$(git-pull-request) Commit & Create Pull Request',
        command: 'promptregistry.submitHubPullRequest',
        arguments: [document.uri]
      })
    );

    const metadataRange = inspection.nodeRanges.get('metadata');
    if (metadataRange) {
      lenses.push(
        new vscode.CodeLens(
          new vscode.Range(metadataRange.startLine, 0, metadataRange.startLine, 0),
          {
            title: '$(clock) Update Timestamp (updatedAt)',
            command: 'promptregistry.touchHubUpdatedAt',
            arguments: [document.uri]
          }
        )
      );
    }

    const sourcesHeader = inspection.nodeRanges.get('sources');
    if (sourcesHeader) {
      lenses.push(
        new vscode.CodeLens(
          new vscode.Range(sourcesHeader.startLine, 0, sourcesHeader.startLine, 0),
          {
            title: '$(add) Add Source',
            command: 'promptregistry.addHubSource',
            arguments: [document.uri]
          }
        )
      );
    }

    const sources = inspection.config?.sources ?? [];
    sources.forEach((source, sIdx) => {
      const range = inspection.nodeRanges.get(`sources.${sIdx}`);
      if (!range) {
        return;
      }
      const lineRange = new vscode.Range(range.startLine, 0, range.startLine, 0);
      lenses.push(
        new vscode.CodeLens(lineRange, {
          title: `$(search) Discover Bundles (${source.id})`,
          command: 'promptregistry.discoverHubSourceBundles',
          arguments: [document.uri, sIdx]
        }),
        new vscode.CodeLens(lineRange, {
          title: '$(edit) Edit in Visual Mode',
          command: 'promptregistry.openHubVisualEditor',
          arguments: [document.uri, { section: 'source', index: sIdx }]
        })
      );
    });

    const profilesHeader = inspection.nodeRanges.get('profiles');
    if (profilesHeader) {
      lenses.push(
        new vscode.CodeLens(
          new vscode.Range(profilesHeader.startLine, 0, profilesHeader.startLine, 0),
          {
            title: '$(add) Add Profile',
            command: 'promptregistry.addHubProfile',
            arguments: [document.uri]
          }
        )
      );
    }

    const profiles = inspection.config?.profiles ?? [];
    profiles.forEach((profile, pIdx) => {
      const range = inspection.nodeRanges.get(`profiles.${pIdx}`);
      if (!range) {
        return;
      }
      const lineRange = new vscode.Range(range.startLine, 0, range.startLine, 0);
      lenses.push(
        new vscode.CodeLens(lineRange, {
          title: `$(add) Add Bundle to ${profile.name || profile.id}`,
          command: 'promptregistry.addHubProfileBundle',
          arguments: [document.uri, pIdx]
        }),
        new vscode.CodeLens(lineRange, {
          title: '$(edit) Edit in Visual Mode',
          command: 'promptregistry.openHubVisualEditor',
          arguments: [document.uri, { section: 'profile', index: pIdx }]
        })
      );
    });

    return lenses;
  }

  public provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection
  ): vscode.CodeAction[] {
    if (!this.isHubConfigDocument(document)) {
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
      if (!diagRange.intersection(range)) {
        continue;
      }

      const action = new vscode.CodeAction(diag.quickFix.title, vscode.CodeActionKind.QuickFix);
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
      action.isPreferred = true;
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
  }
}
