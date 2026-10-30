/**
 * CollectionEditorCommands — VS Code command handlers for the Collection
 * Contributor Workflow, Dedicated Collections Tree View, and Visual Collection Editor.
 *
 * Enforces the domain constraint that only GitHub-backed collection sources
 * (`github`, `awesome-copilot`, or local GitHub checkouts) qualify for
 * contribution; Artifactory sources are read-only replicas populated by the
 * promotion pipeline and do not expose contribution actions.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CollectionContributionWorkflowService,
  type CollectionEditorService,
} from '@ai-primitives-hub/app';
import {
  generateSanitizedId,
  isContributableCollectionSource,
  type RegistrySource,
  resolveCollectionIdFromBundle,
} from '@ai-primitives-hub/core';
import {
  CompositeTokenProvider,
  GhCliTokenProvider,
  GitHubCollaborationClient,
  GitWorkspaceAdapter,
  NodeFileSystem,
  NodeHttpClient,
  NodeProcessExecutor,
  SystemClock,
} from '@ai-primitives-hub/infra';
import * as vscode from 'vscode';
import {
  VsCodeSessionTokenProvider,
} from '../adapters/vscode-session-token-provider';
import type {
  CollectionYamlIntelligence,
} from '../services/collection-yaml-intelligence';
import type {
  RegistryManager,
} from '../services/registry-manager';
import {
  CollectionCustomEditorProvider,
  type CollectionVisualEditorFocusTarget,
} from '../ui/collection-custom-editor';
import type {
  CollectionTreeProvider,
} from '../ui/collection-tree-provider';
import {
  ensureGitHubAccountSelection,
  promptGitHubAccountSelection,
} from '../utils/github-account-prompt';
import {
  Logger,
} from '../utils/logger';

export class CollectionEditorCommands {
  private readonly logger: Logger;
  private readonly workflowService: CollectionContributionWorkflowService;
  private readonly githubClient: GitHubCollaborationClient;
  private readonly fsAdapter = new NodeFileSystem();
  private readonly clockAdapter = new SystemClock();
  private readonly httpClient = new NodeHttpClient();
  private readonly promptingTokenProvider: CompositeTokenProvider;
  private readonly silentTokenProvider: CompositeTokenProvider;
  private readonly inFlightContextByWorkspace = new Map<string, Promise<unknown>>();
  private watcherDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  private hasAutoOpenedSessionTarget = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly registryManager: RegistryManager,
    private readonly editorService: CollectionEditorService,
    private readonly treeProvider: CollectionTreeProvider,
    private readonly yamlIntelligence: CollectionYamlIntelligence,
    private readonly customEditorProvider?: CollectionCustomEditorProvider
  ) {
    this.logger = Logger.getInstance();

    const ghCliTokenProvider = new GhCliTokenProvider();
    this.promptingTokenProvider = new CompositeTokenProvider([
      new VsCodeSessionTokenProvider(true),
      ghCliTokenProvider
    ]);
    this.silentTokenProvider = new CompositeTokenProvider([
      new VsCodeSessionTokenProvider(false),
      ghCliTokenProvider
    ]);

    const processExecutor = new NodeProcessExecutor();
    this.githubClient = new GitHubCollaborationClient(this.httpClient, {
      tokenProvider: this.promptingTokenProvider
    });
    const gitAdapter = new GitWorkspaceAdapter(processExecutor, this.promptingTokenProvider);
    const sessionStorePath = path.join(context.globalStorageUri.fsPath, 'collection-contribution-sessions.json');

    this.workflowService = new CollectionContributionWorkflowService({
      fs: this.fsAdapter,
      clock: this.clockAdapter,
      github: this.githubClient,
      git: gitAdapter,
      sessionStorePath
    });

    this.customEditorProvider?.setContributionContextProvider((workspaceDir) =>
      this.getDeduplicatedContributionContext(workspaceDir)
    );

    this.registerListeners();
  }

  private getDeduplicatedContributionContext(workspaceDir: string): ReturnType<
    CollectionContributionWorkflowService['getWorkspaceContributionContext']
  > {
    const key = path.resolve(workspaceDir);
    const existing = this.inFlightContextByWorkspace.get(key) as ReturnType<
      CollectionContributionWorkflowService['getWorkspaceContributionContext']
    > | undefined;
    if (existing) {
      return existing;
    }

    const promise = this.workflowService.getWorkspaceContributionContext(workspaceDir).finally(() => {
      this.inFlightContextByWorkspace.delete(key);
    });
    this.inFlightContextByWorkspace.set(key, promise);
    return promise;
  }

  private registerListeners(): void {
    this.yamlIntelligence.onDidInspectDocument(({ uri, content, inspection }) => {
      this.treeProvider.updateFromContent(uri.fsPath, content, inspection);
    });

    if (vscode.workspace && typeof vscode.workspace.createFileSystemWatcher === 'function') {
      const watcher = vscode.workspace.createFileSystemWatcher('**/*.collection.{yml,yaml}');
      const scheduleRefresh = (): void => {
        if (this.watcherDebounceTimer) {
          clearTimeout(this.watcherDebounceTimer);
        }
        this.watcherDebounceTimer = setTimeout(() => {
          this.watcherDebounceTimer = undefined;
          this.editorService.clearWorkspaceCache();
          void this.refreshCollectionWorkspaceContext();
          void this.customEditorProvider?.refreshOpenWebviews();
        }, 250);
      };
      this.context.subscriptions.push(
        watcher,
        watcher.onDidCreate(scheduleRefresh),
        watcher.onDidDelete(scheduleRefresh)
      );
    }
  }

  private resolveWorkspaceRoot(uriArg?: vscode.Uri): string | undefined {
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (wsFolder) {
      return wsFolder;
    }
    if (uriArg?.fsPath) {
      const parent = path.dirname(uriArg.fsPath);
      return path.basename(parent) === 'collections' ? path.dirname(parent) : parent;
    }
    return this.treeProvider.getWorkspaceRoot();
  }

  private resolveTargetDocumentUri(uriOrItem?: unknown): vscode.Uri | undefined {
    if (uriOrItem instanceof vscode.Uri && uriOrItem.fsPath) {
      return uriOrItem;
    }
    if (uriOrItem && typeof uriOrItem === 'object') {
      const rec = uriOrItem as { fsPath?: unknown; data?: { filePath?: unknown } };
      if (typeof rec.fsPath === 'string' && rec.fsPath.length > 0) {
        return vscode.Uri.file(rec.fsPath);
      }
      if (typeof rec.data?.filePath === 'string' && rec.data.filePath.length > 0) {
        return vscode.Uri.file(rec.data.filePath);
      }
    }
    const activeDoc = vscode.window.activeTextEditor?.document;
    if (activeDoc && this.yamlIntelligence.isCollectionDocument(activeDoc)) {
      return activeDoc.uri;
    }
    const treePath = this.treeProvider.getActiveFilePath();
    if (treePath && fs.existsSync(treePath)) {
      return vscode.Uri.file(treePath);
    }
    return undefined;
  }

  private async hasGitHubAuthentication(): Promise<boolean> {
    return (await this.silentTokenProvider.getToken('github.com')) !== undefined;
  }

  private async ensureRepositoryAccess(repositorySlug: string): Promise<boolean> {
    await ensureGitHubAccountSelection(() => this.hasGitHubAuthentication());
    const [owner, repo] = repositorySlug.split('/');
    if (!owner || !repo) {
      return false;
    }

    try {
      await this.githubClient.getRepository(owner, repo);
      return true;
    } catch {
      const choice = await vscode.window.showWarningMessage(
        `Your current GitHub session cannot access '${repositorySlug}'. Would you like to switch GitHub accounts in VS Code?`,
        'Switch GitHub Account',
        'Cancel'
      );
      if (choice !== 'Switch GitHub Account') {
        return false;
      }
      await promptGitHubAccountSelection();
      await this.githubClient.getRepository(owner, repo);
      return true;
    }
  }

  private async resolveContributionSourceAndBundle(arg?: unknown): Promise<{
    source: RegistrySource;
    bundleId?: string;
    displayName: string;
  } | null> {
    const sources = await this.registryManager.listSources();

    // Case 1: Passed { bundleId, sourceId? } or string bundleId (e.g. from Marketplace tile or Bundle Details)
    if (typeof arg === 'string' && arg.length > 0) {
      const cachedBundles = await this.registryManager.searchBundles({ cacheOnly: true });
      const bundle = cachedBundles.find((b) => b.id === arg);
      if (bundle) {
        const src = sources.find((s) => s.id === bundle.sourceId);
        if (src) {
          return { source: src, bundleId: bundle.id, displayName: bundle.name || bundle.id };
        }
      }
    }

    if (arg && typeof arg === 'object') {
      const obj = arg as {
        bundleId?: unknown;
        sourceId?: unknown;
        type?: unknown;
        data?: Record<string, unknown>;
      };

      // Direct { bundleId, sourceId } payload
      if (typeof obj.bundleId === 'string' && obj.bundleId.length > 0) {
        const cachedBundles = await this.registryManager.searchBundles({ cacheOnly: true });
        const matchedBundle = cachedBundles.find((b) => b.id === obj.bundleId);
        const targetSourceId = typeof obj.sourceId === 'string' ? obj.sourceId : matchedBundle?.sourceId;
        const src = sources.find((s) => s.id === targetSourceId);
        if (src) {
          return {
            source: src,
            bundleId: obj.bundleId,
            displayName: matchedBundle?.name || obj.bundleId
          };
        }
      }

      // RegistryTreeItem from Registry Explorer
      if (obj.data && typeof obj.data === 'object') {
        const data = obj.data;
        // Source item
        if (obj.type === 'source' && typeof data.id === 'string' && typeof data.type === 'string') {
          return {
            source: data as unknown as RegistrySource,
            displayName: typeof data.name === 'string' ? data.name : data.id
          };
        }
        // Profile bundle item ({ profile, bundle, profileBundle })
        if (data.bundle && typeof data.bundle === 'object') {
          const b = data.bundle as { id?: string; name?: string; sourceId?: string };
          const src = sources.find((s) => s.id === b.sourceId);
          if (src && b.id) {
            return {
              source: src,
              bundleId: b.id,
              displayName: b.name || b.id
            };
          }
        }
        // InstalledBundle or Bundle item
        const bundleId = typeof data.bundleId === 'string'
          ? data.bundleId
          : (typeof data.id === 'string' ? data.id : undefined);
        const sourceId = typeof data.sourceId === 'string' ? data.sourceId : undefined;
        if (bundleId) {
          let src = sourceId ? sources.find((s) => s.id === sourceId) : undefined;
          if (!src) {
            const cachedBundles = await this.registryManager.searchBundles({ cacheOnly: true });
            const matched = cachedBundles.find((b) => b.id === bundleId);
            if (matched) {
              src = sources.find((s) => s.id === matched.sourceId);
            }
          }
          if (src) {
            return {
              source: src,
              bundleId,
              displayName: typeof data.name === 'string' ? data.name : bundleId
            };
          }
        }
      }
    }

    // Case 2: Prompt user to pick a collection or collection source
    const allBundles = await this.registryManager.searchBundles({ cacheOnly: true });
    const sourceById = new Map(sources.map((s) => [s.id, s]));

    interface PickOption extends vscode.QuickPickItem {
      source: RegistrySource;
      bundleId?: string;
    }

    const pickItems: PickOption[] = [];
    for (const bundle of allBundles) {
      const src = sourceById.get(bundle.sourceId);
      if (!src || !isContributableCollectionSource(src).contributable) {
        continue;
      }
      const resolved = resolveCollectionIdFromBundle(bundle.id, src);
      pickItems.push({
        label: `$(package) ${bundle.name}`,
        description: `${src.name} (${resolved?.collectionFilePath ?? bundle.id})`,
        detail: bundle.description,
        source: src,
        bundleId: bundle.id
      });
    }

    for (const src of sources) {
      if (!isContributableCollectionSource(src).contributable) {
        continue;
      }
      pickItems.push({
        label: `$(repo) ${src.name} (All Collections)`,
        description: src.url,
        detail: `Contribute to collection repository (${src.type})`,
        source: src
      });
    }

    if (pickItems.length === 0) {
      await vscode.window.showInformationMessage(
        'No GitHub-connected collection sources found. Import a Hub or add a GitHub / Awesome-Copilot collection source first.'
      );
      return null;
    }

    const selected = await vscode.window.showQuickPick(pickItems, {
      title: 'Contribute to Collection (Fork, Clone & Open Visual Editor)',
      placeHolder: 'Select a collection or collection repository to collaborate on',
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true
    });
    if (!selected) {
      return null;
    }

    return {
      source: selected.source,
      bundleId: selected.bundleId,
      displayName: selected.label.replace(/^\$\([^)]+\)\s*/, '')
    };
  }

  public registerCommands(): vscode.Disposable[] {
    if (!vscode.commands || !vscode.commands.registerCommand) {
      return [];
    }

    const disposables = [
      vscode.commands.registerCommand(
        'promptregistry.contributeToCollection',
        (arg?: unknown) => this.contributeToCollection(arg)
      ),
      vscode.commands.registerCommand(
        'promptregistry.openCollectionVisualEditor',
        (uriOrItem?: unknown, focus?: CollectionVisualEditorFocusTarget) =>
          this.openCollectionVisualEditor(uriOrItem, focus)
      ),
      vscode.commands.registerCommand(
        'promptregistry.openCollectionYamlBeside',
        (uriOrItem?: unknown) => this.openCollectionYamlBeside(uriOrItem)
      ),
      vscode.commands.registerCommand(
        'promptregistry.createNewCollectionVisual',
        () => this.createNewCollectionVisual()
      ),
      vscode.commands.registerCommand(
        'promptregistry.duplicateCollectionVisual',
        (itemOrUri?: unknown) => this.duplicateCollectionVisual(itemOrUri)
      ),
      vscode.commands.registerCommand(
        'promptregistry.deleteCollectionVisual',
        (itemOrUri?: unknown) => this.deleteCollectionVisual(itemOrUri)
      ),
      vscode.commands.registerCommand(
        'promptregistry.addCollectionItemVisual',
        (uriOrItem?: unknown) => this.addCollectionItemVisual(uriOrItem)
      ),
      vscode.commands.registerCommand(
        'promptregistry.scaffoldMissingCollectionFile',
        (uriArg?: vscode.Uri, relPath?: string, kind?: string) =>
          this.scaffoldMissingCollectionFile(uriArg, relPath, kind)
      ),
      vscode.commands.registerCommand(
        'promptregistry.openCollectionItemFile',
        (uriOrItem?: unknown, relPath?: string) => this.openCollectionItemFile(uriOrItem, relPath)
      ),
      vscode.commands.registerCommand(
        'promptregistry.bumpCollectionVersion',
        (uriArg?: vscode.Uri, bump?: 'patch' | 'minor' | 'major') =>
          this.bumpCollectionVersion(uriArg, bump)
      ),
      vscode.commands.registerCommand(
        'promptregistry.submitCollectionPullRequest',
        (uriArg?: vscode.Uri) => this.submitCollectionPullRequest(uriArg)
      ),
      vscode.commands.registerCommand(
        'promptregistry.refreshCollectionPullRequestStatus',
        () => this.refreshCollectionPullRequestStatus()
      ),
      vscode.commands.registerCommand(
        'promptregistry.openCollectionPullRequest',
        (urlOrItem?: unknown) => this.openCollectionPullRequest(urlOrItem)
      )
    ];

    this.context.subscriptions.push(...disposables);
    return disposables;
  }

  /**
   * Detect collections in the current workspace, update `CollectionTreeProvider`
   * and `promptRegistry.collectionWorkspaceActive`, and auto-open the focused
   * collection when restoring a `CollectionContributionSession`.
   */
  public async refreshCollectionWorkspaceContext(): Promise<boolean> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      await vscode.commands.executeCommand('setContext', 'promptRegistry.collectionWorkspaceActive', false);
      this.treeProvider.refreshWorkspace(undefined);
      return false;
    }

    try {
      // 1. Immediately detect collections and populate the Tree View & context key
      //    without waiting on external git child processes.
      const initialOverview = this.treeProvider.refreshWorkspace(workspaceRoot, 'collections');
      const hasDefaultCollections = Boolean(initialOverview && initialOverview.collections.length > 0);
      if (hasDefaultCollections) {
        await vscode.commands.executeCommand('setContext', 'promptRegistry.collectionWorkspaceActive', true);
      }

      // 2. Resolve git remotes/branch/session context asynchronously (deduplicated).
      const contribContext = await this.getDeduplicatedContributionContext(workspaceRoot);
      const overview = contribContext.collectionsPath === 'collections'
        ? initialOverview
        : this.treeProvider.refreshWorkspace(workspaceRoot, contribContext.collectionsPath);
      this.treeProvider.setContributionContext(contribContext);

      const isCollectionWorkspace = Boolean(
        contribContext.isCollectionWorkspace || (overview && overview.collections.length > 0)
      );
      await vscode.commands.executeCommand(
        'setContext',
        'promptRegistry.collectionWorkspaceActive',
        isCollectionWorkspace
      );

      if (
        !this.hasAutoOpenedSessionTarget
        && contribContext.session?.targetCollectionPath
        && fs.existsSync(contribContext.session.targetCollectionPath)
      ) {
        this.hasAutoOpenedSessionTarget = true;
        if (!this.customEditorProvider?.hasOpenWebview(contribContext.session.targetCollectionPath)) {
          await this.openCollectionVisualEditor(vscode.Uri.file(contribContext.session.targetCollectionPath));
        }
      }

      return isCollectionWorkspace;
    } catch (error) {
      this.logger.warn('Failed to refresh collection workspace context', error);
      await vscode.commands.executeCommand('setContext', 'promptRegistry.collectionWorkspaceActive', false);
      return false;
    }
  }

  /**
   * Bootstrap the end-to-end Collection Contributor Workflow from a Marketplace
   * collection tile, Bundle Details view, Registry Explorer item, or QuickPick:
   * `Fork -> Clone -> Branch -> Open Target .collection.yml in Visual Editor`.
   * @param arg Optional bundle ID, `{ bundleId, sourceId }`, or `RegistryTreeItem`.
   */
  public async contributeToCollection(arg?: unknown): Promise<void> {
    try {
      const target = await this.resolveContributionSourceAndBundle(arg);
      if (!target) {
        return;
      }

      const eligibility = await this.workflowService.evaluateSourceForContribution(
        target.source,
        target.bundleId
      );
      if (!eligibility.contributable || !eligibility.repositorySlug) {
        await vscode.window.showWarningMessage(
          `Cannot contribute to "${target.displayName}": ${
            eligibility.reason
            ?? 'Only GitHub-connected collection sources support contributions. Artifactory sources are read-only replicas populated by promotion.'
          }`
        );
        return;
      }

      const repositorySlug = eligibility.repositorySlug;
      const repoName = repositorySlug.split('/')[1] || 'collections';
      const targetRelFile = eligibility.targetCollectionFilePath;

      // Check if current workspace already contains this collection repository
      const matchingWorkspaceFolder = (vscode.workspace.workspaceFolders ?? []).find((folder) => {
        if (targetRelFile && fs.existsSync(path.join(folder.uri.fsPath, targetRelFile))) {
          return true;
        }
        return fs.existsSync(path.join(folder.uri.fsPath, eligibility.collectionsPath));
      });

      if (matchingWorkspaceFolder) {
        const useExistingChoice = await vscode.window.showQuickPick(
          [
            {
              label: `$(edit) Open in current workspace (${matchingWorkspaceFolder.name})`,
              description: targetRelFile ?? matchingWorkspaceFolder.uri.fsPath,
              action: 'existing' as const
            },
            {
              label: `$(repo-forked) Fork / Clone ${repositorySlug} to a folder...`,
              description: 'Set up or sync a local fork & feature branch',
              action: 'clone' as const
            }
          ],
          {
            title: `Contribute to Collection (${target.displayName})`,
            placeHolder: 'Collections are already present in your workspace. How would you like to proceed?'
          }
        );
        if (!useExistingChoice) {
          return;
        }
        if (useExistingChoice.action === 'existing') {
          const candidatePath = targetRelFile
            ? path.join(matchingWorkspaceFolder.uri.fsPath, targetRelFile)
            : this.treeProvider.getActiveFilePath();
          await (candidatePath && fs.existsSync(candidatePath) ? this.openCollectionVisualEditor(vscode.Uri.file(candidatePath)) : this.refreshCollectionWorkspaceContext());
          return;
        }
      }

      const hasAccess = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Verifying GitHub access to ${repositorySlug}...`,
          cancellable: false
        },
        async () => this.ensureRepositoryAccess(repositorySlug)
      );
      if (!hasAccess) {
        return;
      }

      const folderUris = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Select Parent Directory for Collection Repository Clone',
        title: `Select where to clone ${repositorySlug}`
      });
      if (!folderUris || folderUris.length === 0) {
        return;
      }

      const selectedDir = folderUris[0].fsPath;
      const targetDir = path.basename(selectedDir) === repoName
        || fs.existsSync(path.join(selectedDir, eligibility.collectionsPath))
        ? selectedDir
        : path.join(selectedDir, repoName);

      const defaultBranchName = eligibility.targetCollectionId
        ? `feat/collection-${eligibility.targetCollectionId}`
        : 'feat/update-collections';
      const branchName = await vscode.window.showInputBox({
        title: 'Collection Contribution Feature Branch',
        prompt: 'Enter the feature branch name to create or check out from upstream',
        value: defaultBranchName,
        ignoreFocusOut: true,
        validateInput: (val) => (val && val.trim().length > 0 ? null : 'Branch name is required')
      });
      if (!branchName) {
        return;
      }

      const session = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Preparing Collection Contribution Workspace (${repositorySlug})`,
          cancellable: false
        },
        async (progress) => {
          progress.report({ message: 'Forking repository, configuring remotes, and checking out branch...' });
          return this.workflowService.bootstrapContributionWorkspace({
            source: target.source,
            bundleId: target.bundleId,
            targetDir,
            branchName
          });
        }
      );

      const currentRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (currentRoot && path.resolve(currentRoot) === path.resolve(session.workspaceDir)) {
        await this.refreshCollectionWorkspaceContext();
        if (session.targetCollectionPath && fs.existsSync(session.targetCollectionPath)) {
          await this.openCollectionVisualEditor(vscode.Uri.file(session.targetCollectionPath));
        }
        return;
      }

      const openChoice = await vscode.window.showInformationMessage(
        `Forked & cloned ${session.upstreamSlug} (branch '${session.branchName}') at ${session.workspaceDir}.`,
        'Open Workspace Now',
        'Open in New Window',
        'Open Visual Editor Here'
      );

      if (openChoice === 'Open Workspace Now') {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(session.workspaceDir), false);
      } else if (openChoice === 'Open in New Window') {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(session.workspaceDir), true);
      } else if (session.targetCollectionPath && fs.existsSync(session.targetCollectionPath)) {
        await this.openCollectionVisualEditor(vscode.Uri.file(session.targetCollectionPath));
      }
    } catch (error) {
      this.logger.error('Failed to bootstrap collection contribution workspace', error as Error);
      await vscode.window.showErrorMessage(`Collection contribution setup failed: ${(error as Error).message}`);
    }
  }

  /**
   * Open a `.collection.yml` file in the Visual Collection Custom Editor.
   * @param uriOrItem Optional URI or tree item.
   * @param focus Optional initial section/item to focus.
   */
  public async openCollectionVisualEditor(
    uriOrItem?: unknown,
    focus?: CollectionVisualEditorFocusTarget
  ): Promise<void> {
    const targetUri = this.resolveTargetDocumentUri(uriOrItem);
    if (!targetUri) {
      await vscode.window.showInformationMessage(
        'No collection file found in the current workspace. Use "Contribute to Collection" or "Create New Collection" first.'
      );
      return;
    }

    if (focus && this.customEditorProvider) {
      this.customEditorProvider.setPendingFocusTarget(focus, targetUri);
    }

    await vscode.commands.executeCommand(
      'vscode.openWith',
      targetUri,
      CollectionCustomEditorProvider.viewType
    );
  }

  /**
   * Open the raw `.collection.yml` YAML text editor beside the Visual Editor.
   * @param uriOrItem Optional URI or tree item.
   */
  public async openCollectionYamlBeside(uriOrItem?: unknown): Promise<void> {
    const targetUri = this.resolveTargetDocumentUri(uriOrItem);
    if (!targetUri) {
      return;
    }
    const doc = await vscode.workspace.openTextDocument(targetUri);
    await (this.customEditorProvider
      ? this.customEditorProvider.revealSelectionInYamlEditor(
        doc,
        { section: 'metadata' },
        { openBeside: true }
      )
      : vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside }));
  }

  /**
   * Create a new `.collection.yml` manifest (with starter README) and open it
   * in the Visual Collection Editor.
   */
  public async createNewCollectionVisual(): Promise<void> {
    const workspaceRoot = this.resolveWorkspaceRoot();
    if (!workspaceRoot) {
      await vscode.window.showErrorMessage('Open a workspace folder before creating a collection.');
      return;
    }

    const rawId = await vscode.window.showInputBox({
      title: 'Create New Collection',
      prompt: 'Collection ID (lowercase letters, numbers, and hyphens)',
      placeHolder: 'python-development',
      ignoreFocusOut: true,
      validateInput: (val) => {
        if (!val || !val.trim()) {
          return 'Collection ID is required';
        }
        if (!/^[a-z0-9-]+$/.test(val.trim())) {
          return 'Collection ID must contain only lowercase letters, numbers, and hyphens';
        }
        return null;
      }
    });
    if (!rawId) {
      return;
    }

    const id = generateSanitizedId(rawId.trim());
    const defaultName = id
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ') + ' Collection';

    const name = await vscode.window.showInputBox({
      title: 'Create New Collection — Display Name',
      prompt: 'Human-readable name for the collection',
      value: defaultName,
      ignoreFocusOut: true
    });
    if (name === undefined) {
      return;
    }

    const description = await vscode.window.showInputBox({
      title: 'Create New Collection — Description',
      prompt: 'Describe what this collection provides',
      value: `Curated prompts, instructions, agents, and skills for ${name || defaultName}.`,
      ignoreFocusOut: true
    });
    if (description === undefined) {
      return;
    }

    try {
      const created = this.editorService.createCollectionFile(workspaceRoot, {
        id,
        name: name || defaultName,
        description,
        createReadme: true
      });
      await this.refreshCollectionWorkspaceContext();
      await this.openCollectionVisualEditor(vscode.Uri.file(created.filePath), { section: 'metadata' });
      void vscode.window.showInformationMessage(`Created collection '${id}' and opened Visual Collection Editor.`);
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to create collection: ${(error as Error).message}`);
    }
  }

  /**
   * Duplicate an existing collection under a new ID and open it in the Visual Editor.
   * @param itemOrUri Collection tree item or URI.
   */
  public async duplicateCollectionVisual(itemOrUri?: unknown): Promise<void> {
    const targetUri = this.resolveTargetDocumentUri(itemOrUri);
    const workspaceRoot = this.resolveWorkspaceRoot(targetUri);
    if (!targetUri || !workspaceRoot) {
      return;
    }

    const baseId = path.basename(targetUri.fsPath).replace(/\.collection\.ya?ml$/i, '');
    const newId = await vscode.window.showInputBox({
      title: `Duplicate Collection (${baseId})`,
      prompt: 'Enter the new Collection ID (lowercase, numbers, hyphens)',
      value: `${baseId}-copy`,
      ignoreFocusOut: true,
      validateInput: (val) => (val && /^[a-z0-9-]+$/.test(val.trim()) ? null : 'Use lowercase letters, numbers, and hyphens')
    });
    if (!newId) {
      return;
    }

    try {
      const duplicated = this.editorService.duplicateCollectionFile(workspaceRoot, targetUri.fsPath, newId.trim());
      await this.refreshCollectionWorkspaceContext();
      await this.openCollectionVisualEditor(vscode.Uri.file(duplicated.filePath), { section: 'metadata' });
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to duplicate collection: ${(error as Error).message}`);
    }
  }

  /**
   * Delete a collection file after confirmation.
   * @param itemOrUri Collection tree item or URI.
   */
  public async deleteCollectionVisual(itemOrUri?: unknown): Promise<void> {
    const targetUri = this.resolveTargetDocumentUri(itemOrUri);
    const workspaceRoot = this.resolveWorkspaceRoot(targetUri);
    if (!targetUri || !workspaceRoot) {
      return;
    }

    const fileName = path.basename(targetUri.fsPath);
    const confirm = await vscode.window.showWarningMessage(
      `Delete collection manifest '${fileName}'? Referenced primitive files on disk will be kept.`,
      { modal: true },
      'Delete Collection'
    );
    if (confirm !== 'Delete Collection') {
      return;
    }

    try {
      this.editorService.deleteCollectionFile(workspaceRoot, targetUri.fsPath);
      await this.refreshCollectionWorkspaceContext();
      void vscode.window.showInformationMessage(`Deleted collection '${fileName}'.`);
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to delete collection: ${(error as Error).message}`);
    }
  }

  /**
   * Open the Visual Collection Editor focused on the "Create or Add Primitive" wizard.
   * @param uriOrItem Collection URI or tree item.
   */
  public async addCollectionItemVisual(uriOrItem?: unknown): Promise<void> {
    const targetUri = this.resolveTargetDocumentUri(uriOrItem);
    if (!targetUri) {
      return;
    }
    await this.openCollectionVisualEditor(targetUri, { section: 'new-primitive' });
  }

  /**
   * Scaffold a missing referenced item or README file on disk from template.
   * @param uriArg Target `.collection.yml` URI.
   * @param relPath Repo-relative path to create.
   * @param kind Primitive kind (`prompt`, `instruction`, `agent`, `skill`, `plugin`, `readme`, etc.).
   */
  public async scaffoldMissingCollectionFile(
    uriArg?: vscode.Uri,
    relPath?: string,
    kind = 'prompt'
  ): Promise<void> {
    let targetUri = uriArg;
    let targetRelPath = relPath;
    let targetKind = kind;

    if (uriArg && !(uriArg instanceof vscode.Uri) && typeof uriArg === 'object' && 'data' in uriArg) {
      const data = (uriArg as { data?: { filePath?: string; itemPath?: string; kind?: string } }).data;
      if (data?.filePath) {
        targetUri = vscode.Uri.file(data.filePath);
      }
      if (data?.itemPath) {
        targetRelPath = data.itemPath;
      }
      if (data?.kind) {
        targetKind = data.kind;
      }
    }

    const resolvedUri = this.resolveTargetDocumentUri(targetUri);
    const workspaceRoot = this.resolveWorkspaceRoot(resolvedUri);
    if (!resolvedUri || !workspaceRoot || !targetRelPath) {
      return;
    }

    try {
      const doc = await vscode.workspace.openTextDocument(resolvedUri);
      const res = await this.editorService.scaffoldPrimitiveForCollection(
        workspaceRoot,
        doc.getText(),
        {
          kind: targetKind,
          name: path.basename(targetRelPath).replace(/\..*$/, '') || 'Example',
          customRelPath: targetRelPath,
          addToCollection: false
        },
        { filePath: resolvedUri.fsPath }
      );

      if (res.updatedCollectionContent !== doc.getText()) {
        const lastLine = Math.max(0, doc.lineCount - 1);
        const fullRange = new vscode.Range(0, 0, lastLine, doc.lineAt(lastLine).text.length);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, fullRange, res.updatedCollectionContent);
        await vscode.workspace.applyEdit(edit);
      }

      this.yamlIntelligence.publishInspection(doc.uri, res.updatedCollectionContent, res.inspection);
      this.treeProvider.updateFromContent(doc.uri.fsPath, res.updatedCollectionContent, res.inspection);
      await this.customEditorProvider?.refreshOpenWebviews();
      void vscode.window.showInformationMessage(`Created ${res.createdFileRelPath}`);
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to scaffold file: ${(error as Error).message}`);
    }
  }

  /**
   * Open a collection item's referenced primitive file beside the active editor.
   * @param uriOrItem Collection URI or tree item.
   * @param relPathArg Optional repo-relative file path.
   */
  public async openCollectionItemFile(uriOrItem?: unknown, relPathArg?: string): Promise<void> {
    let targetUri = this.resolveTargetDocumentUri(uriOrItem);
    let relPath = relPathArg;

    if (!relPath && uriOrItem && typeof uriOrItem === 'object' && 'data' in uriOrItem) {
      const data = (uriOrItem as { data?: { filePath?: string; itemPath?: string } }).data;
      if (data?.filePath) {
        targetUri = vscode.Uri.file(data.filePath);
      }
      if (data?.itemPath) {
        relPath = data.itemPath;
      }
    }

    const workspaceRoot = this.resolveWorkspaceRoot(targetUri);
    if (!workspaceRoot || !relPath) {
      return;
    }

    const absPath = path.join(workspaceRoot, relPath);
    if (!fs.existsSync(absPath)) {
      await vscode.window.showWarningMessage(`Referenced file does not exist yet: ${relPath}`);
      return;
    }

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
  }

  /**
   * Bump the collection's semantic version (`patch`, `minor`, or `major`).
   * @param uriArg Target `.collection.yml` URI.
   * @param bumpArg Optional bump type; prompts via QuickPick if omitted.
   */
  public async bumpCollectionVersion(
    uriArg?: vscode.Uri,
    bumpArg?: 'patch' | 'minor' | 'major'
  ): Promise<void> {
    const targetUri = this.resolveTargetDocumentUri(uriArg);
    if (!targetUri) {
      return;
    }

    let bump = bumpArg;
    if (!bump) {
      const picked = await vscode.window.showQuickPick(
        [
          { label: 'Patch (1.0.x)', bump: 'patch' as const },
          { label: 'Minor (1.x.0)', bump: 'minor' as const },
          { label: 'Major (x.0.0)', bump: 'major' as const }
        ],
        { title: 'Bump Collection Version', placeHolder: 'Select semantic version increment' }
      );
      if (!picked) {
        return;
      }
      bump = picked.bump;
    }

    const doc = await vscode.workspace.openTextDocument(targetUri);
    const workspaceRoot = this.resolveWorkspaceRoot(targetUri);
    const { updatedContent, inspection } = this.editorService.applyMutation(
      doc.getText(),
      { kind: 'bump-version', bump },
      { filePath: doc.uri.fsPath, workspaceRoot }
    );
    const lastLine = Math.max(0, doc.lineCount - 1);
    const fullRange = new vscode.Range(0, 0, lastLine, doc.lineAt(lastLine).text.length);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, fullRange, updatedContent);
    await vscode.workspace.applyEdit(edit);
    this.yamlIntelligence.publishInspection(doc.uri, updatedContent, inspection);
    this.treeProvider.updateFromContent(doc.uri.fsPath, updatedContent, inspection);
  }

  /**
   * Validate collections, stage all modified/created `.collection.yml` and
   * primitive files, commit, push, and create a Pull Request against upstream.
   * @param uriArg Optional collection URI.
   */
  public async submitCollectionPullRequest(uriArg?: vscode.Uri): Promise<void> {
    try {
      const targetUri = this.resolveTargetDocumentUri(uriArg);
      const workspaceDir = this.resolveWorkspaceRoot(targetUri);
      if (!workspaceDir) {
        await vscode.window.showWarningMessage('Open a collection repository workspace before submitting a Pull Request.');
        return;
      }

      // Save all dirty documents in the workspace before staging
      for (const doc of (vscode.workspace.textDocuments ?? [])) {
        if (doc.isDirty && doc.uri.fsPath.startsWith(workspaceDir)) {
          await doc.save();
        }
      }

      const context = await this.workflowService.getWorkspaceContributionContext(workspaceDir);
      if (!context.upstreamSlug) {
        await vscode.window.showErrorMessage('Workspace does not have a GitHub upstream or origin remote.');
        return;
      }

      const hasAccess = await this.ensureRepositoryAccess(context.upstreamSlug);
      if (!hasAccess) {
        return;
      }

      const prTitle = await vscode.window.showInputBox({
        title: `Submit Collection Pull Request to ${context.upstreamSlug}`,
        prompt: 'Pull Request title (leave default or customize)',
        placeHolder: 'feat(collection): update collections',
        ignoreFocusOut: true
      });
      if (prTitle === undefined) {
        return;
      }

      const pr = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Submitting Collection Pull Request to ${context.upstreamSlug}...`,
          cancellable: false
        },
        async () =>
          this.workflowService.submitPullRequest({
            workspaceDir,
            collectionsPath: context.collectionsPath,
            commitMessage: prTitle.trim() || undefined,
            prTitle: prTitle.trim() || undefined
          })
      );

      const updatedContext = await this.getDeduplicatedContributionContext(workspaceDir);
      this.treeProvider.setContributionContext(updatedContext);
      await this.customEditorProvider?.refreshOpenWebviews({ forceContributionRefresh: true });

      const action = await vscode.window.showInformationMessage(
        `Pull Request #${pr.number} (${pr.title}) is ${pr.state.toUpperCase()} on ${pr.upstreamFullName}.`,
        'Open Pull Request in Browser',
        'Refresh Status'
      );
      if (action === 'Open Pull Request in Browser') {
        await vscode.env.openExternal(vscode.Uri.parse(pr.htmlUrl));
      } else if (action === 'Refresh Status') {
        await this.refreshCollectionPullRequestStatus();
      }
    } catch (error) {
      this.logger.error('Failed to submit collection pull request', error as Error);
      await vscode.window.showErrorMessage(`Pull Request submission failed: ${(error as Error).message}`);
    }
  }

  /**
   * Refresh open Pull Request and CI check status for the active collection workspace.
   */
  public async refreshCollectionPullRequestStatus(): Promise<void> {
    const workspaceDir = this.resolveWorkspaceRoot();
    if (!workspaceDir) {
      return;
    }

    try {
      const status = await this.workflowService.refreshPullRequestStatus(workspaceDir);
      const updatedContext = await this.getDeduplicatedContributionContext(workspaceDir);
      this.treeProvider.setContributionContext(updatedContext);
      await this.customEditorProvider?.refreshOpenWebviews({ forceContributionRefresh: true });

      if (status) {
        const checksMsg = status.checks
          ? ` • Checks: ${status.checks.state} (${status.checks.passingCount}/${status.checks.totalCount} passing)`
          : '';
        await vscode.window.showInformationMessage(
          `PR #${status.number}: ${status.state.toUpperCase()}${checksMsg}`
        );
      }
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to refresh PR status: ${(error as Error).message}`);
    }
  }

  /**
   * Open a Pull Request or Upstream repository URL in the external browser.
   * @param urlOrItem URL string or tree item carrying `data.url`.
   */
  public async openCollectionPullRequest(urlOrItem?: unknown): Promise<void> {
    let url: string | undefined;
    if (typeof urlOrItem === 'string') {
      url = urlOrItem;
    } else if (urlOrItem && typeof urlOrItem === 'object' && 'data' in urlOrItem) {
      const data = (urlOrItem as { data?: { url?: string } }).data;
      url = data?.url;
    }

    if (url && /^https?:\/\//i.test(url)) {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }
  }
}
