/**
 * HubConfigCustomEditorProvider — Visual Master-Detail Custom Text Editor
 * for `hub-config.yml` files.
 *
 * Synchronizes bidirectionally with `vscode.TextDocument` via comment-preserving
 * `HubYamlMutation` edits so users can switch between or split the Visual Editor
 * and raw YAML editor at any time with native Undo/Redo support.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  HubConfigDocumentInspection,
  HubConfigEditorService,
  WorkspaceContributionContext,
} from '@ai-primitives-hub/app';
import {
  deriveExpectedBundlePrefix,
  type SourceRange,
} from '@ai-primitives-hub/core';
import type {
  HubYamlMutation,
} from '@ai-primitives-hub/infra';
import * as vscode from 'vscode';
import type {
  HubYamlIntelligence,
} from '../services/hub-yaml-intelligence';
import type {
  HubConfigTreeProvider,
} from './hub-config-tree-provider';

export interface HubVisualEditorFocusTarget {
  section: 'metadata' | 'source' | 'profile';
  index?: number;
}

export class HubConfigCustomEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'promptregistry.hubConfigEditor';

  private readonly activeWebviews = new Map<string, Set<vscode.WebviewPanel>>();
  private readonly isPostingByPath = new Set<string>();
  private readonly pendingPostByPath = new Map<
    string,
    { panel: vscode.WebviewPanel; focusTarget?: HubVisualEditorFocusTarget }
  >();

  private pendingFocusTarget: HubVisualEditorFocusTarget | undefined;
  private contributionContextProvider?: (workspaceDir: string) => Promise<WorkspaceContributionContext | undefined>;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly editorService: HubConfigEditorService,
    private readonly yamlIntelligence: HubYamlIntelligence,
    private readonly treeProvider: HubConfigTreeProvider
  ) {}

  private serializeInspection(inspection: HubConfigDocumentInspection): Record<string, unknown> {
    const expectedPrefixBySourceId: Record<string, string> = {};
    for (const source of (inspection.config?.sources ?? [])) {
      if (source?.id) {
        const prefix = deriveExpectedBundlePrefix({
          type: source.type,
          url: source.url,
          repository: (source as unknown as Record<string, unknown>).repository as string | undefined
        });
        if (prefix) {
          expectedPrefixBySourceId[source.id] = prefix;
        }
      }
    }

    return {
      valid: inspection.valid,
      config: inspection.config,
      errors: inspection.errors,
      warnings: inspection.warnings,
      diagnostics: inspection.diagnostics,
      inlineDecorations: inspection.inlineDecorations,
      catalogsBySourceId: inspection.catalogsBySourceId,
      expectedPrefixBySourceId,
      profileCategories: inspection.profileCategories
    };
  }

  private async applyDocumentMutation(
    document: vscode.TextDocument,
    mutation: HubYamlMutation
  ): Promise<void> {
    const { updatedContent, inspection } = this.editorService.applyMutation(document.getText(), mutation);
    const lastLine = Math.max(0, document.lineCount - 1);
    const fullRange = new vscode.Range(
      0,
      0,
      lastLine,
      document.lineAt(lastLine).text.length
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, fullRange, updatedContent);
    await vscode.workspace.applyEdit(edit);
    this.yamlIntelligence.publishInspection(document.uri, updatedContent, inspection);
    this.treeProvider.updateFromContent(document.uri.fsPath, updatedContent, inspection);
  }

  private async postStateToWebview(
    panel: vscode.WebviewPanel,
    document: vscode.TextDocument,
    focusTarget?: HubVisualEditorFocusTarget,
    precomputedInspection?: HubConfigDocumentInspection
  ): Promise<void> {
    const docPath = document.uri.fsPath;
    if (this.isPostingByPath.has(docPath)) {
      const existingPending = this.pendingPostByPath.get(docPath);
      this.pendingPostByPath.set(docPath, {
        panel,
        focusTarget: focusTarget ?? existingPending?.focusTarget
      });
      return;
    }

    this.isPostingByPath.add(docPath);
    try {
      const content = document.getText();
      const inspection = precomputedInspection
        ?? this.yamlIntelligence.getLastInspection(docPath)
        ?? this.yamlIntelligence.validateDocument(document);
      this.treeProvider.updateFromContent(docPath, content, inspection);

      const workspaceFolder = path.dirname(docPath)
        || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const contributionContext = (workspaceFolder && this.contributionContextProvider)
        ? await this.contributionContextProvider(workspaceFolder)
        : undefined;

      void panel.webview.postMessage({
        type: 'documentState',
        filePath: docPath,
        inspection: this.serializeInspection(inspection),
        contributionContext,
        focusTarget
      });
    } finally {
      this.isPostingByPath.delete(docPath);
      const pending = this.pendingPostByPath.get(docPath);
      if (pending) {
        this.pendingPostByPath.delete(docPath);
        void this.postStateToWebview(pending.panel, document, pending.focusTarget);
      }
    }
  }

  /**
   * Generate a nonce for Content Security Policy.
   */
  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  /**
   * Resolve the external `hub-config-editor.html` template path from `dist/webview`
   * (or fallback to `src/ui/webview` in unbundled unit test environments).
   */
  private resolveHtmlTemplatePath(): string {
    const distPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      'dist',
      'webview',
      'hub-config-editor',
      'hub-config-editor.html'
    ).fsPath;
    if (fs.existsSync(distPath)) {
      return distPath;
    }

    const srcFromExtensionUri = vscode.Uri.joinPath(
      this.context.extensionUri,
      'src',
      'ui',
      'webview',
      'hub-config-editor',
      'hub-config-editor.html'
    ).fsPath;
    if (fs.existsSync(srcFromExtensionUri)) {
      return srcFromExtensionUri;
    }

    return path.resolve(
      process.cwd(),
      'src',
      'ui',
      'webview',
      'hub-config-editor',
      'hub-config-editor.html'
    );
  }

  /**
   * Load and populate the external HTML template for the Hub Configuration Visual Editor.
   * @param webview Target webview instance.
   */
  private getHtmlContent(webview: vscode.Webview): string {
    const toWebviewUri = (uri: vscode.Uri): string => (
      typeof webview.asWebviewUri === 'function'
        ? webview.asWebviewUri(uri).toString()
        : uri.toString()
    );

    const cssUri = toWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'hub-config-editor', 'hub-config-editor.css')
    );
    const iconsUri = toWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'fonts', 'icons.css')
    );
    const scriptUri = toWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'hub-config-editor', 'hub-config-editor.js')
    );

    const nonce = this.getNonce();
    const cspOrigin = webview.cspSource || "'self'";
    const cspSource = `default-src 'none'; img-src https: ${cspOrigin}; style-src ${cspOrigin} 'unsafe-inline'; font-src ${cspOrigin}; script-src 'nonce-${nonce}';`;

    const htmlPath = this.resolveHtmlTemplatePath();
    return fs.readFileSync(htmlPath, 'utf8')
      .replace('{{cspSource}}', cspSource)
      .replace('{{iconsUri}}', iconsUri)
      .replace('{{cssUri}}', cssUri)
      .replace('{{nonce}}', nonce)
      .replace('{{scriptUri}}', scriptUri);
  }

  /**
   * Convert a 0-based `SourceRange` into a clamped `vscode.Range` for `document`.
   * @param document Target text document.
   * @param range 0-based source range.
   */
  private toClampedVsCodeRange(document: vscode.TextDocument, range: SourceRange): vscode.Range {
    const maxLine = Math.max(0, document.lineCount - 1);
    const startLine = Math.min(Math.max(0, range.startLine), maxLine);
    const endLine = Math.min(Math.max(startLine, range.endLine), maxLine);
    const startLineText = document.lineAt(startLine).text;
    const endLineText = document.lineAt(endLine).text;
    const startCol = Math.min(Math.max(0, range.startColumn), startLineText.length);
    const endCol = Math.min(Math.max(0, range.endColumn), endLineText.length);
    return new vscode.Range(startLine, startCol, endLine, endCol);
  }

  /**
   * Resolve the anchor (header/`id` line) and block ranges in `hub-config.yml`
   * for a visual selection (`metadata`, `source`, or `profile`).
   * @param document Target `hub-config.yml` text document.
   * @param target Selected section and index.
   */
  private resolveSelectionRanges(
    document: vscode.TextDocument,
    target?: HubVisualEditorFocusTarget
  ): { anchorRange: vscode.Range; blockRange: vscode.Range } | undefined {
    if (!target) {
      return undefined;
    }

    const inspection = this.yamlIntelligence.getLastInspection(document.uri.fsPath)
      ?? this.yamlIntelligence.validateDocument(document);
    const nodeRanges = inspection.nodeRanges;
    if (!nodeRanges) {
      return undefined;
    }

    let anchorSourceRange: SourceRange | undefined;
    let blockSourceRange: SourceRange | undefined;

    if (target.section === 'source' && typeof target.index === 'number') {
      anchorSourceRange = nodeRanges.get(`sources.${target.index}.id`)
        ?? nodeRanges.get(`sources.${target.index}`);
      blockSourceRange = nodeRanges.get(`sources.${target.index}`) ?? anchorSourceRange;
    } else if (target.section === 'profile' && typeof target.index === 'number') {
      anchorSourceRange = nodeRanges.get(`profiles.${target.index}.id`)
        ?? nodeRanges.get(`profiles.${target.index}`);
      blockSourceRange = nodeRanges.get(`profiles.${target.index}`) ?? anchorSourceRange;
    } else if (target.section === 'metadata') {
      anchorSourceRange = nodeRanges.get('metadata.name')
        ?? nodeRanges.get('metadata')
        ?? nodeRanges.get('version');
      blockSourceRange = nodeRanges.get('metadata') ?? anchorSourceRange;
    }

    if (!anchorSourceRange || !blockSourceRange) {
      return undefined;
    }

    return {
      anchorRange: this.toClampedVsCodeRange(document, anchorSourceRange),
      blockRange: this.toClampedVsCodeRange(document, blockSourceRange)
    };
  }

  /**
   * Synchronize any visible split YAML text editor (or open one beside the
   * visual editor when `openBeside` is true) by scrolling to the selected
   * `metadata`, `source`, or `profile` block.
   * @param document Target `hub-config.yml` text document.
   * @param target Selected visual section and index.
   * @param options Reveal options.
   * @param options.openBeside Whether to open the YAML text editor in a split column if not already requested.
   */
  public async revealSelectionInYamlEditor(
    document: vscode.TextDocument,
    target?: HubVisualEditorFocusTarget,
    options: { openBeside?: boolean } = {}
  ): Promise<void> {
    const resolved = this.resolveSelectionRanges(document, target);

    if (options.openBeside) {
      const editor = await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: false,
        ...(resolved ? { selection: resolved.anchorRange } : {})
      });
      if (resolved && editor && typeof editor.revealRange === 'function') {
        editor.revealRange(
          resolved.blockRange,
          vscode.TextEditorRevealType?.InCenter ?? 2
        );
      }
      return;
    }

    if (!resolved) {
      return;
    }

    const visibleEditors = (vscode.window.visibleTextEditors ?? []).filter(
      (editor) => editor.document.uri.fsPath === document.uri.fsPath
    );
    for (const editor of visibleEditors) {
      editor.selection = new vscode.Selection(
        resolved.anchorRange.start.line,
        resolved.anchorRange.start.character,
        resolved.anchorRange.end.line,
        resolved.anchorRange.end.character
      );
      if (typeof editor.revealRange === 'function') {
        editor.revealRange(
          resolved.blockRange,
          vscode.TextEditorRevealType?.InCenter ?? 2
        );
      }
    }
  }

  public setContributionContextProvider(
    provider: (workspaceDir: string) => Promise<WorkspaceContributionContext | undefined>
  ): void {
    this.contributionContextProvider = provider;
  }

  public setPendingFocusTarget(
    target: HubVisualEditorFocusTarget | undefined,
    targetUri?: vscode.Uri
  ): void {
    this.pendingFocusTarget = target;
    if (!target || !targetUri) {
      return;
    }

    const panels = this.activeWebviews.get(targetUri.fsPath);
    const doc = (vscode.workspace.textDocuments ?? []).find((d) => d.uri.fsPath === targetUri.fsPath);
    if (doc) {
      if (panels && panels.size > 0) {
        this.pendingFocusTarget = undefined;
        for (const panel of panels) {
          void this.postStateToWebview(panel, doc, target);
        }
      }
      void this.revealSelectionInYamlEditor(doc, target, { openBeside: false });
    }
  }

  public async refreshOpenWebviews(): Promise<void> {
    for (const [fsPath, panels] of this.activeWebviews.entries()) {
      const doc = (vscode.workspace.textDocuments ?? []).find((d) => d.uri.fsPath === fsPath);
      if (!doc) {
        continue;
      }
      for (const panel of panels) {
        await this.postStateToWebview(panel, doc);
      }
    }
  }

  public notifySourceDiscoveryFinished(
    targetUri: vscode.Uri,
    result: { sourceId: string; valid: boolean; errors: string[] }
  ): void {
    const panels = this.activeWebviews.get(targetUri.fsPath);
    if (!panels) {
      return;
    }
    for (const panel of panels) {
      void panel.webview.postMessage({
        type: 'discoveryFinished',
        sourceId: result.sourceId,
        valid: result.valid,
        errors: result.errors
      });
    }
  }

  public register(): vscode.Disposable {
    const registration = vscode.window.registerCustomEditorProvider(
      HubConfigCustomEditorProvider.viewType,
      this,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false
      }
    );
    this.context.subscriptions.push(registration);
    return registration;
  }

  public resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel
  ): void {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };
    webviewPanel.webview.html = this.getHtmlContent(webviewPanel.webview);

    const panels = this.activeWebviews.get(document.uri.fsPath) ?? new Set<vscode.WebviewPanel>();
    panels.add(webviewPanel);
    this.activeWebviews.set(document.uri.fsPath, panels);

    const changeDocSub = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.fsPath === document.uri.fsPath) {
        void this.postStateToWebview(webviewPanel, document);
      }
    });

    const inspectSub = this.yamlIntelligence.onDidInspectDocument((event) => {
      if (event.uri.fsPath === document.uri.fsPath) {
        void this.postStateToWebview(webviewPanel, document, undefined, event.inspection);
      }
    });

    const msgSub = webviewPanel.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
      switch (msg.type) {
        case 'ready': {
          const focus = this.pendingFocusTarget;
          this.pendingFocusTarget = undefined;
          await this.postStateToWebview(webviewPanel, document, focus);
          if (focus) {
            await this.revealSelectionInYamlEditor(document, focus, { openBeside: false });
          }
          break;
        }
        case 'applyMutation': {
          await this.applyDocumentMutation(document, msg.mutation as HubYamlMutation);
          break;
        }
        case 'validateDeep': {
          await vscode.commands.executeCommand('promptregistry.validateHubConfig', document.uri);
          break;
        }
        case 'discoverSource': {
          await vscode.commands.executeCommand(
            'promptregistry.discoverHubSourceBundles',
            document.uri,
            Number(msg.index ?? 0),
            Boolean(msg.silent)
          );
          break;
        }
        case 'discoverSourceById': {
          if (typeof msg.sourceId === 'string' && msg.sourceId.length > 0) {
            await vscode.commands.executeCommand(
              'promptregistry.discoverHubSourceBundles',
              document.uri,
              msg.sourceId,
              Boolean(msg.silent)
            );
          }
          break;
        }
        case 'openExternalUrl': {
          if (typeof msg.url === 'string' && /^https?:\/\//i.test(msg.url)) {
            await vscode.env.openExternal(vscode.Uri.parse(msg.url));
          }
          break;
        }
        case 'refreshPullRequest': {
          await vscode.commands.executeCommand('promptregistry.refreshHubPullRequestStatus', document.uri);
          await this.postStateToWebview(webviewPanel, document);
          break;
        }
        case 'revealSelectionInYaml': {
          await this.revealSelectionInYamlEditor(
            document,
            msg.selection as HubVisualEditorFocusTarget | undefined,
            { openBeside: false }
          );
          break;
        }
        case 'openYamlSplit': {
          await this.revealSelectionInYamlEditor(
            document,
            msg.selection as HubVisualEditorFocusTarget | undefined,
            { openBeside: true }
          );
          break;
        }
        case 'submitPullRequest': {
          await vscode.commands.executeCommand('promptregistry.submitHubPullRequest', document.uri);
          break;
        }
      }
    });

    webviewPanel.onDidDispose(() => {
      changeDocSub.dispose();
      inspectSub.dispose();
      msgSub.dispose();
      panels.delete(webviewPanel);
    });
  }
}
