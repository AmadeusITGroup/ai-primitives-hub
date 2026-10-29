/**
 * CollectionCustomEditorProvider — Visual Master-Detail Custom Text Editor
 * for `*.collection.yml` and `*.collection.yaml` files.
 *
 * Synchronizes bidirectionally with `vscode.TextDocument` via comment-preserving
 * `CollectionYamlMutation` edits so users can switch between or split the Visual
 * Collection Editor and raw YAML editor at any time with native Undo/Redo support,
 * while also providing integrated visual editing and 1-click scaffolding for
 * referenced primitive files (`prompts/`, `instructions/`, `agents/`, `skills/`,
 * `plugins/`, `hooks/`, and `README.md`).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  CollectionDocumentInspection,
  CollectionEditorService,
  CollectionWorkspaceContributionContext,
  PrimitiveVisualContent,
  ScaffoldPrimitiveForCollectionInput,
} from '@ai-primitives-hub/app';
import {
  PRIMITIVE_KINDS,
  type SourceRange,
} from '@ai-primitives-hub/core';
import type {
  CollectionYamlMutation,
} from '@ai-primitives-hub/infra';
import * as vscode from 'vscode';
import type {
  CollectionYamlIntelligence,
} from '../services/collection-yaml-intelligence';
import {
  Logger,
} from '../utils/logger';
import type {
  CollectionTreeProvider,
} from './collection-tree-provider';

export interface CollectionVisualEditorFocusTarget {
  section: 'metadata' | 'display' | 'readme' | 'item' | 'mcp' | 'new-primitive';
  index?: number;
  subKey?: string;
}

const CONTRIBUTION_CONTEXT_CACHE_TTL_MS = 5000;

export class CollectionCustomEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'promptregistry.collectionEditor';

  private readonly activeWebviews = new Map<string, Set<vscode.WebviewPanel>>();
  private readonly isPostingByPath = new Set<string>();
  private readonly cachedContributionContextByWorkspace = new Map<
    string,
    { context: CollectionWorkspaceContributionContext | undefined; fetchedAt: number }
  >();

  private readonly inFlightContributionContextByWorkspace = new Map<
    string,
    Promise<CollectionWorkspaceContributionContext | undefined>
  >();

  private pendingFocusTarget: CollectionVisualEditorFocusTarget | undefined;
  private contributionContextProvider?: (workspaceDir: string) => Promise<CollectionWorkspaceContributionContext | undefined>;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly editorService: CollectionEditorService,
    private readonly yamlIntelligence: CollectionYamlIntelligence,
    private readonly treeProvider: CollectionTreeProvider
  ) {}

  private resolveWorkspaceRoot(filePath: string): string {
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (wsFolder && filePath.startsWith(wsFolder)) {
      return wsFolder;
    }
    const parent = path.dirname(filePath);
    return path.basename(parent) === 'collections' ? path.dirname(parent) : (wsFolder ?? parent);
  }

  private async refreshContributionContextAsync(
    workspaceRoot: string,
    force = false
  ): Promise<CollectionWorkspaceContributionContext | undefined> {
    if (!this.contributionContextProvider || !workspaceRoot) {
      return undefined;
    }

    const key = path.resolve(workspaceRoot);
    const now = Date.now();
    const cached = this.cachedContributionContextByWorkspace.get(key);
    if (!force && cached && now - cached.fetchedAt < CONTRIBUTION_CONTEXT_CACHE_TTL_MS) {
      return cached.context;
    }

    const existingPromise = this.inFlightContributionContextByWorkspace.get(key);
    if (existingPromise) {
      return existingPromise;
    }

    const promise = (async () => {
      try {
        const contributionContext = await this.contributionContextProvider!(workspaceRoot);
        this.cachedContributionContextByWorkspace.set(key, {
          context: contributionContext,
          fetchedAt: Date.now()
        });
        this.treeProvider.setContributionContext(contributionContext);

        for (const [docPath, panels] of this.activeWebviews.entries()) {
          if (path.resolve(this.resolveWorkspaceRoot(docPath)) === key) {
            for (const panel of panels) {
              void panel.webview.postMessage({
                type: 'contributionContextUpdated',
                contributionContext
              });
            }
          }
        }
        return contributionContext;
      } catch {
        return undefined;
      } finally {
        this.inFlightContributionContextByWorkspace.delete(key);
      }
    })();

    this.inFlightContributionContextByWorkspace.set(key, promise);
    return promise;
  }

  private serializeInspection(inspection: CollectionDocumentInspection): Record<string, unknown> {
    return {
      valid: inspection.valid,
      manifest: inspection.manifest,
      errors: inspection.errors,
      warnings: inspection.warnings,
      diagnostics: inspection.diagnostics,
      inlineDecorations: inspection.inlineDecorations,
      itemStatuses: inspection.itemStatuses,
      readmeExists: inspection.readmeExists,
      unassignedPrimitives: inspection.unassignedPrimitives,
      primitiveKinds: [...PRIMITIVE_KINDS]
    };
  }

  private async applyDocumentMutation(
    document: vscode.TextDocument,
    mutation: CollectionYamlMutation,
    focusTarget?: CollectionVisualEditorFocusTarget
  ): Promise<void> {
    const workspaceRoot = this.resolveWorkspaceRoot(document.uri.fsPath);
    const { updatedContent, inspection } = this.editorService.applyMutation(
      document.getText(),
      mutation,
      {
        filePath: document.uri.fsPath,
        workspaceRoot
      }
    );
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

    if (focusTarget) {
      const panels = this.activeWebviews.get(document.uri.fsPath);
      if (panels) {
        for (const panel of panels) {
          this.postStateToWebview(panel, document, focusTarget, inspection);
        }
      }
    }
  }

  private postStateToWebview(
    panel: vscode.WebviewPanel,
    document: vscode.TextDocument,
    focusTarget?: CollectionVisualEditorFocusTarget,
    precomputedInspection?: CollectionDocumentInspection
  ): void {
    const docPath = document.uri.fsPath;
    if (this.isPostingByPath.has(docPath)) {
      return;
    }

    this.isPostingByPath.add(docPath);
    try {
      const content = document.getText();
      const workspaceRoot = this.resolveWorkspaceRoot(docPath);
      const inspection = precomputedInspection
        ?? this.yamlIntelligence.getLastInspection(docPath)
        ?? this.yamlIntelligence.validateDocument(document);
      this.treeProvider.updateFromContent(docPath, content, inspection);

      const treeOverview = this.treeProvider.getOverview();
      const overview = (treeOverview && path.resolve(treeOverview.workspaceRoot) === path.resolve(workspaceRoot))
        ? treeOverview
        : this.editorService.detectWorkspaceCollections(workspaceRoot);
      const siblingCollections = overview.collections.map((c) => ({
        filePath: c.filePath,
        relPath: c.relPath,
        id: c.id,
        name: c.name,
        version: c.version,
        valid: c.valid
      }));

      const cachedContributionContext = this.cachedContributionContextByWorkspace.get(
        path.resolve(workspaceRoot)
      )?.context;

      let readmeContent: PrimitiveVisualContent | undefined;
      if (inspection.manifest?.readme?.path) {
        try {
          readmeContent = this.editorService.readPrimitiveContent(
            workspaceRoot,
            inspection.manifest.readme.path,
            'readme'
          );
        } catch {
          readmeContent = undefined;
        }
      }

      void panel.webview.postMessage({
        type: 'documentState',
        filePath: docPath,
        workspaceRoot,
        inspection: this.serializeInspection(inspection),
        siblingCollections,
        contributionContext: cachedContributionContext,
        readmeContent,
        focusTarget
      });

      void this.refreshContributionContextAsync(workspaceRoot);
    } finally {
      this.isPostingByPath.delete(docPath);
    }
  }

  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  private resolveHtmlTemplatePath(): string {
    const distPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      'dist',
      'webview',
      'collection-editor',
      'collection-editor.html'
    ).fsPath;
    if (fs.existsSync(distPath)) {
      return distPath;
    }

    const srcFromExtensionUri = vscode.Uri.joinPath(
      this.context.extensionUri,
      'src',
      'ui',
      'webview',
      'collection-editor',
      'collection-editor.html'
    ).fsPath;
    if (fs.existsSync(srcFromExtensionUri)) {
      return srcFromExtensionUri;
    }

    return path.resolve(
      process.cwd(),
      'src',
      'ui',
      'webview',
      'collection-editor',
      'collection-editor.html'
    );
  }

  private getHtmlContent(webview: vscode.Webview): string {
    const toWebviewUri = (uri: vscode.Uri): string => (
      typeof webview.asWebviewUri === 'function'
        ? webview.asWebviewUri(uri).toString()
        : uri.toString()
    );

    const cssUri = toWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'collection-editor', 'collection-editor.css')
    );
    const iconsUri = toWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'fonts', 'icons.css')
    );
    const scriptUri = toWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'collection-editor', 'collection-editor.js')
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

  private resolveSelectionRanges(
    document: vscode.TextDocument,
    target?: CollectionVisualEditorFocusTarget
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

    switch (target.section) {
      case 'item': {
        if (typeof target.index === 'number') {
          anchorSourceRange = nodeRanges.get(`items.${target.index}.path`)
            ?? nodeRanges.get(`items.${target.index}`);
          blockSourceRange = nodeRanges.get(`items.${target.index}`) ?? anchorSourceRange;
        }
        break;
      }
      case 'readme': {
        anchorSourceRange = nodeRanges.get('readme.path') ?? nodeRanges.get('readme') ?? nodeRanges.get('id');
        blockSourceRange = nodeRanges.get('readme') ?? anchorSourceRange;
        break;
      }
      case 'display': {
        anchorSourceRange = nodeRanges.get('display') ?? nodeRanges.get('id');
        blockSourceRange = nodeRanges.get('display') ?? anchorSourceRange;
        break;
      }
      case 'mcp': {
        anchorSourceRange = target.subKey
          ? nodeRanges.get(`mcp.items.${target.subKey}`)
          ?? nodeRanges.get('mcp')
          : nodeRanges.get('mcp') ?? nodeRanges.get('id');
        blockSourceRange = nodeRanges.get('mcp') ?? anchorSourceRange;
        break;
      }
      default: {
        anchorSourceRange = nodeRanges.get('id') ?? nodeRanges.get('name') ?? nodeRanges.get('metadata');
        blockSourceRange = nodeRanges.get('metadata') ?? anchorSourceRange;
        break;
      }
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
   * `metadata`, `display`, `readme`, `item`, or `mcp` block.
   * @param document Target `.collection.yml` text document.
   * @param target Selected visual section and index.
   * @param options Reveal options.
   * @param options.openBeside Whether to open the YAML text editor in a split column.
   */
  public async revealSelectionInYamlEditor(
    document: vscode.TextDocument,
    target?: CollectionVisualEditorFocusTarget,
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

  public hasOpenWebview(fsPath: string): boolean {
    const panels = this.activeWebviews.get(fsPath);
    return Boolean(panels && panels.size > 0);
  }

  public setContributionContextProvider(
    provider: (workspaceDir: string) => Promise<CollectionWorkspaceContributionContext | undefined>
  ): void {
    this.contributionContextProvider = provider;
  }

  public setPendingFocusTarget(
    target: CollectionVisualEditorFocusTarget | undefined,
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
          this.postStateToWebview(panel, doc, target);
        }
      }
      void this.revealSelectionInYamlEditor(doc, target, { openBeside: false });
    }
  }

  public async refreshOpenWebviews(options?: { forceContributionRefresh?: boolean }): Promise<void> {
    const refreshedWorkspaces = new Set<string>();
    for (const [fsPath, panels] of this.activeWebviews.entries()) {
      const doc = (vscode.workspace.textDocuments ?? []).find((d) => d.uri.fsPath === fsPath);
      if (!doc) {
        continue;
      }
      for (const panel of panels) {
        this.postStateToWebview(panel, doc);
      }
      if (options?.forceContributionRefresh) {
        const wsRoot = this.resolveWorkspaceRoot(fsPath);
        if (!refreshedWorkspaces.has(wsRoot)) {
          refreshedWorkspaces.add(wsRoot);
          await this.refreshContributionContextAsync(wsRoot, true);
        }
      }
    }
  }

  public register(): vscode.Disposable {
    const registration = vscode.window.registerCustomEditorProvider(
      CollectionCustomEditorProvider.viewType,
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
    void vscode.commands.executeCommand('setContext', 'promptRegistry.activeCollectionEditorOpen', true);

    const changeDocSub = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.fsPath === document.uri.fsPath) {
        this.postStateToWebview(webviewPanel, document);
      }
    });

    const inspectSub = this.yamlIntelligence.onDidInspectDocument((event) => {
      if (event.uri.fsPath === document.uri.fsPath) {
        this.postStateToWebview(webviewPanel, document, undefined, event.inspection);
      }
    });

    const msgSub = webviewPanel.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
      const workspaceRoot = this.resolveWorkspaceRoot(document.uri.fsPath);

      try {
        switch (msg.type) {
          case 'ready': {
            const focus = this.pendingFocusTarget;
            this.pendingFocusTarget = undefined;
            this.postStateToWebview(webviewPanel, document, focus);
            if (focus) {
              await this.revealSelectionInYamlEditor(document, focus, { openBeside: false });
            }
            break;
          }
          case 'applyMutation': {
            const focus = msg.focusTarget as CollectionVisualEditorFocusTarget | undefined;
            await this.applyDocumentMutation(document, msg.mutation as CollectionYamlMutation, focus);
            break;
          }
          case 'loadPrimitiveContent': {
            if (typeof msg.relPath === 'string' && msg.relPath.length > 0) {
              const content = this.editorService.readPrimitiveContent(
                workspaceRoot,
                msg.relPath,
                typeof msg.kind === 'string' ? msg.kind : undefined
              );
              void webviewPanel.webview.postMessage({
                type: 'primitiveContentLoaded',
                relPath: msg.relPath,
                content
              });
            }
            break;
          }
          case 'savePrimitiveContent': {
            if (typeof msg.relPath === 'string' && msg.relPath.length > 0 && msg.update && typeof msg.update === 'object') {
              const saved = this.editorService.writePrimitiveContent(
                workspaceRoot,
                msg.relPath,
                msg.update
              );
              this.postStateToWebview(webviewPanel, document);
              void webviewPanel.webview.postMessage({
                type: 'primitiveContentLoaded',
                relPath: msg.relPath,
                content: saved,
                savedToast: true
              });
              void vscode.window.showInformationMessage(`Saved content for ${msg.relPath}`);
            }
            break;
          }
          case 'scaffoldPrimitive': {
            if (msg.input && typeof msg.input === 'object') {
              const res = await this.editorService.scaffoldPrimitiveForCollection(
                workspaceRoot,
                document.getText(),
                msg.input as ScaffoldPrimitiveForCollectionInput,
                { filePath: document.uri.fsPath }
              );
              const lastLine = Math.max(0, document.lineCount - 1);
              const fullRange = new vscode.Range(0, 0, lastLine, document.lineAt(lastLine).text.length);
              const edit = new vscode.WorkspaceEdit();
              edit.replace(document.uri, fullRange, res.updatedCollectionContent);
              await vscode.workspace.applyEdit(edit);
              this.yamlIntelligence.publishInspection(document.uri, res.updatedCollectionContent, res.inspection);
              this.treeProvider.updateFromContent(document.uri.fsPath, res.updatedCollectionContent, res.inspection);

              const items = res.inspection.manifest?.items ?? [];
              const matchedIndex = items.findIndex((it) => it.path === res.createdFileRelPath);
              const focusAfter: CollectionVisualEditorFocusTarget = (msg.input as { kind?: string }).kind === 'readme'
                ? { section: 'readme' }
                : {
                  section: 'item',
                  index: matchedIndex === -1 ? Math.max(0, items.length - 1) : matchedIndex
                };
              this.postStateToWebview(webviewPanel, document, focusAfter, res.inspection);

              const loadedContent = this.editorService.readPrimitiveContent(
                workspaceRoot,
                res.createdFileRelPath,
                (msg.input as { kind?: string }).kind
              );
              void webviewPanel.webview.postMessage({
                type: 'primitiveContentLoaded',
                relPath: res.createdFileRelPath,
                content: loadedContent,
                savedToast: true
              });
            }
            break;
          }
          case 'openReferencedFile': {
            if (typeof msg.relPath === 'string' && msg.relPath.length > 0) {
              await vscode.commands.executeCommand(
                'promptregistry.openCollectionItemFile',
                document.uri,
                msg.relPath
              );
            }
            break;
          }
          case 'switchCollection': {
            if (typeof msg.filePath === 'string' && msg.filePath.length > 0) {
              await vscode.commands.executeCommand(
                'promptregistry.openCollectionVisualEditor',
                vscode.Uri.file(msg.filePath),
                { section: 'metadata' }
              );
            }
            break;
          }
          case 'createNewCollection': {
            await vscode.commands.executeCommand('promptregistry.createNewCollectionVisual');
            break;
          }
          case 'validateAll': {
            await vscode.commands.executeCommand('promptRegistry.validateCollections');
            this.postStateToWebview(webviewPanel, document);
            break;
          }
          case 'openExternalUrl': {
            if (typeof msg.url === 'string' && /^https?:\/\//i.test(msg.url)) {
              await vscode.env.openExternal(vscode.Uri.parse(msg.url));
            }
            break;
          }
          case 'refreshPullRequest': {
            await vscode.commands.executeCommand('promptregistry.refreshCollectionPullRequestStatus');
            await this.refreshContributionContextAsync(workspaceRoot, true);
            break;
          }
          case 'submitPullRequest': {
            await vscode.commands.executeCommand('promptregistry.submitCollectionPullRequest', document.uri);
            break;
          }
          case 'selectionChanged': {
            const target = msg.target as CollectionVisualEditorFocusTarget | undefined;
            await this.revealSelectionInYamlEditor(document, target, { openBeside: false });
            break;
          }
          case 'openYamlBeside': {
            const target = msg.target as CollectionVisualEditorFocusTarget | undefined;
            await this.revealSelectionInYamlEditor(document, target, { openBeside: true });
            break;
          }
        }
      } catch (error) {
        Logger.getInstance().error(`Collection editor action '${String(msg.type)}' failed`, error as Error);
        if (msg.type === 'loadPrimitiveContent' && typeof msg.relPath === 'string') {
          void webviewPanel.webview.postMessage({
            type: 'primitiveContentLoaded',
            relPath: msg.relPath,
            content: {
              relPath: msg.relPath,
              absPath: '',
              kind: typeof msg.kind === 'string' ? msg.kind : 'prompt',
              exists: false,
              format: 'raw',
              frontmatter: {},
              body: '',
              rawContent: ''
            }
          });
        }
        void vscode.window.showErrorMessage(`Collection editor: ${(error as Error).message}`);
      }
    });

    webviewPanel.onDidDispose(() => {
      changeDocSub.dispose();
      inspectSub.dispose();
      msgSub.dispose();
      const set = this.activeWebviews.get(document.uri.fsPath);
      if (set) {
        set.delete(webviewPanel);
        if (set.size === 0) {
          this.activeWebviews.delete(document.uri.fsPath);
        }
      }
      if (this.activeWebviews.size === 0) {
        void vscode.commands.executeCommand('setContext', 'promptRegistry.activeCollectionEditorOpen', false);
      }
    });
  }
}
