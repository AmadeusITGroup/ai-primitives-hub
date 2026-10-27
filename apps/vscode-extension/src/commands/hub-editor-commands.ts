/**
 * HubEditorCommands — VS Code command handlers for the Hub Contributor
 * Workflow and Visual Hub Configuration Editor.
 *
 * Enforces the domain constraint that only GitHub-connected hubs qualify for
 * contribution and visual editing; Artifactory hubs are read-only replicas
 * populated by the promotion process and do not expose the editor.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type HubConfigEditorService,
  HubContributionWorkflowService,
} from '@ai-primitives-hub/app';
import {
  formatHubBundleId,
  type HubConfig,
  type HubReference,
  type HubSource,
  isContributableHub,
} from '@ai-primitives-hub/core';
import {
  CompositeTokenProvider,
  GhCliTokenProvider,
  GitHubCollaborationClient,
  GitWorkspaceAdapter,
  NodeFileSystem,
  NodeHttpClient,
  NodeProcessExecutor,
  NodeProcessRunner,
  SystemClock,
} from '@ai-primitives-hub/infra';
import * as vscode from 'vscode';
import {
  VsCodeSessionTokenProvider,
} from '../adapters/vscode-session-token-provider';
import type {
  HubManager,
} from '../services/hub-manager';
import type {
  HubYamlIntelligence,
} from '../services/hub-yaml-intelligence';
import {
  HubConfigCustomEditorProvider,
  type HubVisualEditorFocusTarget,
} from '../ui/hub-config-custom-editor';
import type {
  HubConfigTreeProvider,
} from '../ui/hub-config-tree-provider';
import {
  ensureGitHubAccountSelection,
  promptGitHubAccountSelection,
} from '../utils/github-account-prompt';
import {
  Logger,
} from '../utils/logger';

export class HubEditorCommands {
  private readonly logger: Logger;
  private readonly workflowService: HubContributionWorkflowService;
  private readonly githubClient: GitHubCollaborationClient;
  private readonly fsAdapter = new NodeFileSystem();
  private readonly clockAdapter = new SystemClock();
  private readonly httpClient = new NodeHttpClient();
  private readonly processRunner = new NodeProcessRunner();
  private readonly promptingTokenProvider: CompositeTokenProvider;
  private readonly silentTokenProvider: CompositeTokenProvider;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly hubManager: HubManager,
    private readonly editorService: HubConfigEditorService,
    private readonly treeProvider: HubConfigTreeProvider,
    private readonly yamlIntelligence: HubYamlIntelligence,
    private readonly customEditorProvider?: HubConfigCustomEditorProvider
  ) {
    this.logger = Logger.getInstance();

    // Align with the extension's standard authentication chain
    // (see src/adapters/infra-adapter-factory.ts and src/services/hub-manager.ts):
    // 1. VS Code native GitHub authentication session (prompting or silent)
    // 2. GitHub CLI (`gh auth token`) fallback when no VS Code session exists
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
    const sessionStorePath = path.join(context.globalStorageUri.fsPath, 'hub-contribution-sessions.json');

    this.workflowService = new HubContributionWorkflowService({
      fs: this.fsAdapter,
      clock: this.clockAdapter,
      github: this.githubClient,
      git: gitAdapter,
      sessionStorePath
    });

    this.customEditorProvider?.setContributionContextProvider((workspaceDir) =>
      this.workflowService.getWorkspaceContributionContext(workspaceDir)
    );

    this.registerListeners();
  }

  private registerListeners(): void {
    this.hubManager.onActiveHubChanged(() => {
      void this.refreshContributableContext();
    });
    this.hubManager.onHubImported(() => {
      void this.refreshContributableContext();
    });
    this.hubManager.onHubDeleted(() => {
      void this.refreshContributableContext();
    });
    this.yamlIntelligence.onDidInspectDocument(({ uri, content, inspection }) => {
      this.treeProvider.updateFromContent(uri.fsPath, content, inspection);
    });
  }

  private resolveTargetDocumentUri(uriArg?: vscode.Uri): vscode.Uri | undefined {
    if (uriArg && uriArg.fsPath) {
      return uriArg;
    }
    const activeDoc = vscode.window.activeTextEditor?.document;
    if (activeDoc && this.yamlIntelligence.isHubConfigDocument(activeDoc)) {
      return activeDoc.uri;
    }
    const treeFilePath = this.treeProvider.getActiveFilePath();
    if (treeFilePath) {
      return vscode.Uri.file(treeFilePath);
    }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
      const candidate = path.join(workspaceRoot, 'hub-config.yml');
      if (fs.existsSync(candidate)) {
        return vscode.Uri.file(candidate);
      }
    }
    return undefined;
  }

  private async openDocumentAndApplyMutation(
    uriArg: vscode.Uri | undefined,
    mutation: Parameters<HubConfigEditorService['applyMutation']>[1]
  ): Promise<void> {
    const targetUri = this.resolveTargetDocumentUri(uriArg);
    if (!targetUri) {
      await vscode.window.showWarningMessage('No hub-config.yml file is currently open.');
      return;
    }
    const doc = await vscode.workspace.openTextDocument(targetUri);
    const { updatedContent, inspection } = this.editorService.applyMutation(doc.getText(), mutation);
    const lastLine = Math.max(0, doc.lineCount - 1);
    const fullRange = new vscode.Range(0, 0, lastLine, doc.lineAt(lastLine).text.length);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, fullRange, updatedContent);
    await vscode.workspace.applyEdit(edit);
    this.yamlIntelligence.publishInspection(doc.uri, updatedContent, inspection);
    this.treeProvider.updateFromContent(doc.uri.fsPath, updatedContent, inspection);
  }

  private async hasGitHubAuthentication(): Promise<boolean> {
    return (await this.silentTokenProvider.getToken('github.com')) !== undefined;
  }

  /**
   * Ensure a GitHub session is active via VS Code's native authentication and
   * verify that the selected session can access `repositorySlug`. If the current
   * session lacks access (e.g. wrong GitHub account selected in VS Code), offer
   * to switch accounts via VS Code's native account picker.
   * @param repositorySlug Target `owner/repo` slug.
   */
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

  /**
   * Register all Hub Editor & Contributor commands.
   */
  public registerCommands(): vscode.Disposable[] {
    if (!vscode.commands || !vscode.commands.registerCommand) {
      return [];
    }

    const disposables = [
      vscode.commands.registerCommand('promptregistry.contributeToHub', (arg?: unknown) => this.contributeToHub(arg)),
      vscode.commands.registerCommand(
        'promptregistry.openHubVisualEditor',
        (uri?: vscode.Uri, focus?: HubVisualEditorFocusTarget) => this.openHubVisualEditor(uri, focus)
      ),
      vscode.commands.registerCommand('promptregistry.validateHubConfig', (uri?: vscode.Uri) => this.validateHubConfig(uri)),
      vscode.commands.registerCommand('promptregistry.touchHubUpdatedAt', (uri?: vscode.Uri) => this.touchHubUpdatedAt(uri)),
      vscode.commands.registerCommand('promptregistry.addHubSource', (uri?: vscode.Uri) => this.addHubSource(uri)),
      vscode.commands.registerCommand(
        'promptregistry.discoverHubSourceBundles',
        (uri?: vscode.Uri, sourceIndexOrId?: number | string, silent?: boolean) =>
          this.discoverHubSourceBundles(uri, sourceIndexOrId, silent)
      ),
      vscode.commands.registerCommand('promptregistry.addHubProfile', (uri?: vscode.Uri) => this.addHubProfile(uri)),
      vscode.commands.registerCommand(
        'promptregistry.addHubProfileBundle',
        (uri?: vscode.Uri, profileIndex?: number) => this.addHubProfileBundle(uri, profileIndex)
      ),
      vscode.commands.registerCommand('promptregistry.submitHubPullRequest', (uri?: vscode.Uri) => this.submitHubPullRequest(uri)),
      vscode.commands.registerCommand('promptregistry.refreshHubPullRequestStatus', () => this.refreshHubPullRequestStatus()),
      vscode.commands.registerCommand(
        'promptregistry.openHubPullRequest',
        (urlOrItem?: unknown) => this.openHubPullRequest(urlOrItem)
      )
    ];

    this.context.subscriptions.push(...disposables);
    return disposables;
  }

  /**
   * Refresh VS Code context keys (`promptRegistry.activeHubContributable` and
   * `promptRegistry.hubWorkspaceActive`) and auto-load `hub-config.yml` when
   * the current workspace is a hub repository.
   */
  public async refreshContributableContext(): Promise<boolean> {
    let contributable = false;
    try {
      const activeHub = await this.hubManager.getActiveHub();
      if (activeHub) {
        const eligibility = await this.workflowService.evaluateHubForContribution({
          id: 'active',
          config: activeHub.config,
          reference: activeHub.reference
        });
        contributable = eligibility.contributable;
      }
    } catch (error) {
      this.logger.debug('Unable to evaluate active hub contribution eligibility', error);
      contributable = false;
    }

    await vscode.commands.executeCommand('setContext', 'promptRegistry.activeHubContributable', contributable);

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
      const hubConfigPath = path.join(workspaceRoot, 'hub-config.yml');
      const hasHubConfig = fs.existsSync(hubConfigPath);
      await vscode.commands.executeCommand('setContext', 'promptRegistry.hubWorkspaceActive', hasHubConfig);

      if (hasHubConfig) {
        try {
          const content = fs.readFileSync(hubConfigPath, 'utf8');
          const inspection = this.editorService.inspectDocument(content);
          this.treeProvider.updateFromContent(hubConfigPath, content, inspection);
          const contribContext = await this.workflowService.getWorkspaceContributionContext(workspaceRoot);
          this.treeProvider.setContributionContext(contribContext);
        } catch (error) {
          this.logger.warn('Failed to initialize workspace hub-config.yml tree', error);
        }
      }
    } else {
      await vscode.commands.executeCommand('setContext', 'promptRegistry.hubWorkspaceActive', false);
    }

    return contributable;
  }

  /**
   * Start the end-to-end Hub Contributor Workflow from the active hub (or a
   * selected hub tree item):
   * Fork -> Clone (or attach to existing local checkout) -> Branch -> Open Visual Editor.
   *
   * Strictly rejects Artifactory hubs as read-only replicas populated by promotion.
   * @param hubArg Optional hub ID or tree item.
   */
  public async contributeToHub(hubArg?: unknown): Promise<void> {
    try {
      let targetHub: { id: string; config: HubConfig; reference: HubReference } | null = null;

      if (typeof hubArg === 'string') {
        const loaded = await this.hubManager.getHubInfo(hubArg);
        targetHub = { id: loaded.id, config: loaded.config, reference: loaded.reference };
      } else if (hubArg && typeof hubArg === 'object' && 'data' in hubArg) {
        const data = (hubArg as { data?: { id?: string } }).data;
        if (data?.id) {
          const loaded = await this.hubManager.getHubInfo(data.id);
          targetHub = { id: loaded.id, config: loaded.config, reference: loaded.reference };
        }
      }

      if (!targetHub) {
        const active = await this.hubManager.getActiveHub();
        if (active) {
          targetHub = {
            id: active.config.metadata.name.toLowerCase().replaceAll(/[^a-z0-9-]+/g, '-'),
            config: active.config,
            reference: active.reference
          };
        }
      }

      if (!targetHub) {
        await vscode.window.showInformationMessage('No active hub found. Import or activate a GitHub hub first.');
        return;
      }

      const eligibility = await this.workflowService.evaluateHubForContribution(targetHub);
      if (!eligibility.contributable || !eligibility.repositorySlug) {
        const hubName = String(targetHub.config?.metadata?.name ?? targetHub.id);
        await vscode.window.showWarningMessage(
          `Cannot contribute to hub "${hubName}": ${
            eligibility.reason
            ?? 'Only hubs connected with GitHub support contributions. Artifactory hubs are read-only replicas populated by promotion.'
          }`
        );
        return;
      }

      const repositorySlug = eligibility.repositorySlug;
      const repoName = repositorySlug.split('/')[1] || 'hub-config';
      const matchingWorkspaceFolder = (vscode.workspace.workspaceFolders ?? []).find(
        (folder) => fs.existsSync(path.join(folder.uri.fsPath, 'hub-config.yml'))
      );

      if (matchingWorkspaceFolder) {
        const useExistingChoice = await vscode.window.showQuickPick(
          [
            {
              label: `$(edit) Open existing workspace (${matchingWorkspaceFolder.name})`,
              description: matchingWorkspaceFolder.uri.fsPath,
              action: 'existing' as const
            },
            {
              label: `$(repo-forked) Fork / Clone ${repositorySlug} to a folder...`,
              description: 'Set up or sync a local fork & feature branch',
              action: 'clone' as const
            }
          ],
          {
            title: `Contribute to Hub (${targetHub.config?.metadata?.name ?? repositorySlug})`,
            placeHolder: 'A hub-config.yml is already in your workspace. How would you like to proceed?'
          }
        );
        if (!useExistingChoice) {
          return;
        }
        if (useExistingChoice.action === 'existing') {
          const existingConfigUri = vscode.Uri.file(path.join(matchingWorkspaceFolder.uri.fsPath, 'hub-config.yml'));
          await this.openHubVisualEditor(existingConfigUri);
          return;
        }
      }

      // Verify repository access via VS Code's native authentication chain
      // (offering VS Code's native GitHub account picker if the current session lacks access)
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
        openLabel: 'Select Parent Directory for Hub Clone',
        title: `Select where to clone ${eligibility.repositorySlug}`
      });
      if (!folderUris || folderUris.length === 0) {
        return;
      }

      const selectedDir = folderUris[0].fsPath;
      const targetDir = path.basename(selectedDir) === repoName || fs.existsSync(path.join(selectedDir, 'hub-config.yml'))
        ? selectedDir
        : path.join(selectedDir, repoName);

      const branchName = await vscode.window.showInputBox({
        title: 'Contribution Feature Branch Name',
        prompt: 'Enter the Git branch name for your hub changes',
        value: 'feat/add-hub-source-or-profile',
        ignoreFocusOut: true
      });
      if (!branchName) {
        return;
      }

      const session = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Preparing Hub Contribution (${eligibility.repositorySlug})`,
          cancellable: false
        },
        async (progress) => {
          progress.report({ message: 'Ensuring GitHub fork, cloning, and configuring branch...' });
          return this.workflowService.bootstrapContributionWorkspace({
            hubId: targetHub.id,
            hubName: String(targetHub.config?.metadata?.name ?? targetHub.id),
            hubReference: targetHub.reference,
            targetDir,
            branchName
          });
        }
      );

      if (session.accountResolution?.switchedFromAccount && session.accountResolution.message) {
        void vscode.window.showInformationMessage(session.accountResolution.message);
      }

      const configUri = vscode.Uri.file(session.hubConfigPath);
      const isTargetInWorkspace = (vscode.workspace.workspaceFolders ?? []).some(
        (f) => path.resolve(f.uri.fsPath) === path.resolve(session.workspaceDir)
      );

      if (isTargetInWorkspace || fs.existsSync(session.hubConfigPath)) {
        await this.openHubVisualEditor(configUri);
      }

      if (!isTargetInWorkspace) {
        const openChoice = await vscode.window.showInformationMessage(
          `Cloned fork ${session.forkSlug} on branch '${session.branchName}'. Open repository folder in VS Code?`,
          'Open in Current Window',
          'Open in New Window'
        );
        if (openChoice === 'Open in Current Window') {
          await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(session.workspaceDir), false);
        } else if (openChoice === 'Open in New Window') {
          await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(session.workspaceDir), true);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Contribute to Hub workflow failed', error as Error);
      await vscode.window.showErrorMessage(`Hub contribution failed: ${message}`);
    }
  }

  /**
   * Open a `hub-config.yml` file in the Visual Custom Editor.
   * Refuses if no local file is provided and the active hub is a read-only Artifactory hub.
   * @param uriArg Optional URI to `hub-config.yml`.
   * @param focus Optional initial section/item to select.
   */
  public async openHubVisualEditor(
    uriArg?: vscode.Uri,
    focus?: HubVisualEditorFocusTarget
  ): Promise<void> {
    if (!uriArg) {
      const activeHub = await this.hubManager.getActiveHub();
      if (activeHub && activeHub.reference.type === 'artifactory') {
        const eligibility = isContributableHub(activeHub.reference);
        await vscode.window.showWarningMessage(
          eligibility.reason ?? 'Artifactory hubs are read-only replicas and do not expose the visual editor.'
        );
        return;
      }
    }

    const targetUri = this.resolveTargetDocumentUri(uriArg);
    if (!targetUri) {
      await this.contributeToHub();
      return;
    }

    this.customEditorProvider?.setPendingFocusTarget(focus, targetUri);
    await vscode.commands.executeCommand(
      'vscode.openWith',
      targetUri,
      HubConfigCustomEditorProvider.viewType
    );
  }

  /**
   * Run static + deep validation on `hub-config.yml` and publish results to
   * Diagnostics, Inline Decorations, Tree View, and Visual Editor.
   * @param uriArg Optional URI to `hub-config.yml`.
   */
  public async validateHubConfig(uriArg?: vscode.Uri): Promise<void> {
    const targetUri = this.resolveTargetDocumentUri(uriArg);
    if (!targetUri) {
      await vscode.window.showWarningMessage('Open a hub-config.yml file first to validate.');
      return;
    }

    const doc = await vscode.workspace.openTextDocument(targetUri);
    const inspection = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Validating Hub Configuration (Sources, Catalogs & Profiles)',
        cancellable: false
      },
      async (progress) => {
        return this.editorService.validateDeep(
          this.fsAdapter,
          doc.uri.fsPath,
          doc.getText(),
          {
            sourceAdapterDeps: {
              fs: this.fsAdapter,
              clock: this.clockAdapter,
              httpClient: this.httpClient,
              processRunner: this.processRunner,
              fallbackTokenProviders: [this.promptingTokenProvider]
            },
            onProgress: (event) => {
              if (event.phase === 'source' && event.status === 'started') {
                progress.report({ message: `Checking source ${event.sourceId} (${event.current}/${event.total})...` });
              } else if (event.phase === 'profile' && event.status === 'started') {
                progress.report({ message: `Resolving profile ${event.profileId} (${event.current}/${event.total})...` });
              }
            }
          }
        );
      }
    );

    this.yamlIntelligence.publishInspection(doc.uri, doc.getText(), inspection);
    this.treeProvider.updateFromContent(doc.uri.fsPath, doc.getText(), inspection);

    if (inspection.valid) {
      await vscode.window.showInformationMessage(
        `✅ Hub configuration is valid (${inspection.config?.sources?.length ?? 0} sources, ${inspection.config?.profiles?.length ?? 0} profiles).`
      );
      return;
    }

    const hasAuthFailure = inspection.errors.some((err) => /\b(?:401|403|404)\b|authentication/i.test(err));
    const action = await (hasAuthFailure
      ? vscode.window.showWarningMessage(
        `⚠ Hub configuration has ${inspection.errors.length} validation error(s). Some sources could not be accessed with the current GitHub session.`,
        'Switch GitHub Account'
      )
      : vscode.window.showWarningMessage(
        `⚠ Hub configuration has ${inspection.errors.length} validation error(s). Check the Problems panel or Visual Editor.`
      ));
    if (action === 'Switch GitHub Account') {
      await promptGitHubAccountSelection();
      await this.validateHubConfig(targetUri);
    }
  }

  public async touchHubUpdatedAt(uriArg?: vscode.Uri): Promise<void> {
    await this.openDocumentAndApplyMutation(uriArg, {
      kind: 'touch-updated-at',
      updatedAt: this.clockAdapter.nowIso()
    });
  }

  public async addHubSource(uriArg?: vscode.Uri): Promise<void> {
    const id = await vscode.window.showInputBox({
      title: 'Add Hub Source — Step 1/4: Source ID',
      prompt: 'Enter a unique kebab-case identifier for the source',
      placeHolder: 'my-collections-source',
      ignoreFocusOut: true
    });
    if (!id) {
      return;
    }

    const typePick = await vscode.window.showQuickPick(
      [
        { label: 'github', description: 'GitHub repository with published collection releases' },
        { label: 'skills', description: 'GitHub repository directory containing Agent Skills' },
        { label: 'awesome-copilot', description: 'Structured collections repository with collectionsPath' },
        { label: 'apm', description: 'APM package repository' },
        { label: 'local', description: 'Local filesystem source' }
      ],
      {
        title: 'Add Hub Source — Step 2/4: Source Type',
        placeHolder: 'Select source type',
        ignoreFocusOut: true
      }
    );
    if (!typePick) {
      return;
    }

    const url = await vscode.window.showInputBox({
      title: 'Add Hub Source — Step 3/4: Source URL',
      prompt: 'Enter the GitHub repository or skills directory URL',
      placeHolder: typePick.label === 'skills'
        ? 'https://github.com/org/repo/skills'
        : 'https://github.com/org/repo',
      ignoreFocusOut: true
    });
    if (!url) {
      return;
    }

    const name = await vscode.window.showInputBox({
      title: 'Add Hub Source — Step 4/4: Display Name',
      prompt: 'Enter a human-readable display name for this source',
      value: id,
      ignoreFocusOut: true
    });
    if (!name) {
      return;
    }

    await this.openDocumentAndApplyMutation(uriArg, {
      kind: 'add-source',
      source: {
        id: id.trim(),
        name: name.trim(),
        type: typePick.label as HubSource['type'],
        url: url.trim(),
        enabled: true,
        priority: 10,
        ...(typePick.label === 'awesome-copilot'
          ? { config: { branch: 'main', collectionsPath: 'collections' } }
          : {})
      },
      updatedAt: this.clockAdapter.nowIso()
    });
  }

  public async discoverHubSourceBundles(
    uriArg?: vscode.Uri,
    sourceIndexOrId?: number | string,
    silent = false
  ): Promise<void> {
    const targetUri = this.resolveTargetDocumentUri(uriArg);
    if (!targetUri) {
      return;
    }
    const doc = await vscode.workspace.openTextDocument(targetUri);
    const inspection = this.editorService.inspectDocument(doc.getText());
    const sources = inspection.config?.sources ?? [];
    const source = typeof sourceIndexOrId === 'string'
      ? sources.find((s) => s.id === sourceIndexOrId)
      : sources[sourceIndexOrId ?? 0];
    if (!source) {
      return;
    }

    const tokenProvider = silent ? this.silentTokenProvider : this.promptingTokenProvider;
    const runDiscovery = async () => this.editorService.discoverSourceBundles(source, {
      fs: this.fsAdapter,
      clock: this.clockAdapter,
      httpClient: this.httpClient,
      processRunner: this.processRunner,
      fallbackTokenProviders: [tokenProvider]
    });

    let discovery: Awaited<ReturnType<typeof runDiscovery>> = {
      valid: false,
      bundles: [],
      errors: []
    };
    try {
      discovery = silent
        ? await runDiscovery()
        : await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Discovering bundles from source '${source.id}'...`,
            cancellable: false
          },
          runDiscovery
        );
    } catch (error) {
      discovery = {
        valid: false,
        bundles: [],
        errors: [error instanceof Error ? error.message : String(error)]
      };
    } finally {
      this.customEditorProvider?.notifySourceDiscoveryFinished(targetUri, {
        sourceId: source.id,
        valid: discovery.valid,
        errors: discovery.errors
      });
    }

    const updatedInspection = this.editorService.inspectDocument(doc.getText());
    this.yamlIntelligence.publishInspection(doc.uri, doc.getText(), updatedInspection);
    this.treeProvider.updateFromContent(doc.uri.fsPath, doc.getText(), updatedInspection);

    if (!silent) {
      if (discovery.valid) {
        await vscode.window.showInformationMessage(
          `Discovered ${discovery.bundles.length} bundle(s) in source '${source.id}'.`
        );
        return;
      }

      const errorSummary = discovery.errors.join(', ');
      const isAuthError = /\b(?:401|403|404)\b|authentication/i.test(errorSummary);
      const action = await (isAuthError
        ? vscode.window.showWarningMessage(
          `Source '${source.id}' discovery failed: ${errorSummary}`,
          'Switch GitHub Account'
        )
        : vscode.window.showWarningMessage(
          `Source '${source.id}' discovery failed: ${errorSummary}`
        ));
      if (action === 'Switch GitHub Account') {
        await promptGitHubAccountSelection();
        await this.discoverHubSourceBundles(targetUri, sourceIndexOrId, false);
      }
    }
  }

  public async addHubProfile(uriArg?: vscode.Uri): Promise<void> {
    const targetUri = this.resolveTargetDocumentUri(uriArg);
    if (!targetUri) {
      return;
    }
    const doc = await vscode.workspace.openTextDocument(targetUri);
    const inspection = this.editorService.inspectDocument(doc.getText());
    const sources = inspection.config?.sources ?? [];
    if (sources.length === 0) {
      await vscode.window.showWarningMessage('Add at least one source before creating a profile.');
      return;
    }

    const id = await vscode.window.showInputBox({
      title: 'Add Hub Profile — Step 1/4: Profile ID',
      prompt: 'Enter a unique kebab-case identifier for the profile',
      placeHolder: 'cloud-architect',
      ignoreFocusOut: true
    });
    if (!id) {
      return;
    }

    const name = await vscode.window.showInputBox({
      title: 'Add Hub Profile — Step 2/4: Display Name',
      prompt: 'Enter the profile display name',
      value: id,
      ignoreFocusOut: true
    });
    if (!name) {
      return;
    }

    const categoryPick = await vscode.window.showQuickPick(
      ['Roles', 'Domains', 'Languages', 'Platforms', 'Tools'],
      {
        title: 'Add Hub Profile — Step 3/4: Category Path',
        placeHolder: 'Select top-level category path',
        ignoreFocusOut: true
      }
    );
    if (!categoryPick) {
      return;
    }

    const description = await vscode.window.showInputBox({
      title: 'Add Hub Profile — Step 4/4: Description',
      prompt: 'Enter a short description of what this profile provides',
      value: `Curated primitives for ${name}`,
      ignoreFocusOut: true
    });
    if (!description) {
      return;
    }

    const defaultSource = sources[0];
    const catalog = inspection.catalogsBySourceId[defaultSource.id] ?? [];
    const defaultBundleId = catalog[0]?.id ?? formatHubBundleId(defaultSource, 'example-bundle');

    await this.openDocumentAndApplyMutation(targetUri, {
      kind: 'add-profile',
      profile: {
        id: id.trim(),
        name: name.trim(),
        description: description.trim(),
        icon: '🧩',
        path: [categoryPick],
        bundles: [
          {
            id: defaultBundleId,
            version: 'latest',
            source: defaultSource.id,
            required: true
          }
        ]
      },
      updatedAt: this.clockAdapter.nowIso()
    });
  }

  public async addHubProfileBundle(uriArg?: vscode.Uri, profileIndex?: number): Promise<void> {
    const targetUri = this.resolveTargetDocumentUri(uriArg);
    if (!targetUri) {
      return;
    }
    const doc = await vscode.workspace.openTextDocument(targetUri);
    const inspection = this.editorService.inspectDocument(doc.getText());
    const sources = inspection.config?.sources ?? [];
    const profiles = inspection.config?.profiles ?? [];
    const targetProfileIdx = profileIndex ?? 0;
    const profile = profiles[targetProfileIdx];
    if (!profile || sources.length === 0) {
      return;
    }

    const selectedSource = await vscode.window.showQuickPick(
      sources.map((s) => ({
        label: s.id,
        description: `${s.name ?? s.id} (${s.type})`,
        source: s
      })),
      {
        title: `Add Bundle to Profile '${profile.name || profile.id}'`,
        placeHolder: 'Select the source providing the bundle',
        ignoreFocusOut: true
      }
    );
    if (!selectedSource) {
      return;
    }

    let catalog = inspection.catalogsBySourceId[selectedSource.label] ?? [];
    if (catalog.length === 0) {
      const discovery = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Discovering bundles from source '${selectedSource.label}'...`,
          cancellable: false
        },
        async () => this.editorService.discoverSourceBundles(selectedSource.source, {
          fs: this.fsAdapter,
          clock: this.clockAdapter,
          httpClient: this.httpClient,
          processRunner: this.processRunner,
          fallbackTokenProviders: [this.promptingTokenProvider]
        })
      );
      if (discovery.valid && discovery.bundles.length > 0) {
        catalog = discovery.bundles;
        const refreshed = this.editorService.inspectDocument(doc.getText());
        this.yamlIntelligence.publishInspection(doc.uri, doc.getText(), refreshed);
        this.treeProvider.updateFromContent(doc.uri.fsPath, doc.getText(), refreshed);
      }
    }

    let bundleId: string | undefined;
    let selectedVersion = 'latest';

    if (catalog.length > 0) {
      const pickedBundle = await vscode.window.showQuickPick(
        catalog.map((b) => ({
          label: b.id,
          description: b.versions.length > 0
            ? `latest: v${b.version}${b.versions.length > 1 ? ` (${b.versions.length} versions)` : ''}`
            : 'latest',
          entry: b
        })),
        {
          title: 'Select Bundle from Source Catalog',
          placeHolder: 'Choose a discovered bundle',
          ignoreFocusOut: true
        }
      );
      if (!pickedBundle) {
        return;
      }
      bundleId = pickedBundle.label;

      if (pickedBundle.entry.versions.length > 0) {
        const versionPick = await vscode.window.showQuickPick(
          [
            {
              label: 'latest',
              description: `Track latest version (currently v${pickedBundle.entry.version})`
            },
            ...pickedBundle.entry.versions.map((ver) => ({
              label: ver,
              description: `Pin to version ${ver}`
            }))
          ],
          {
            title: `Select Version for '${bundleId}'`,
            placeHolder: 'Choose "latest" or pin to a specific version',
            ignoreFocusOut: true
          }
        );
        if (!versionPick) {
          return;
        }
        selectedVersion = versionPick.label;
      }
    } else {
      const rawId = await vscode.window.showInputBox({
        title: 'Enter Bundle or Skill ID',
        prompt: 'The required source prefix will be applied automatically',
        placeHolder: 'webapp-testing',
        ignoreFocusOut: true
      });
      if (rawId) {
        bundleId = formatHubBundleId(selectedSource.source, rawId);
      }
    }

    if (!bundleId) {
      return;
    }

    await this.openDocumentAndApplyMutation(targetUri, {
      kind: 'add-profile-bundle',
      profileIndex: targetProfileIdx,
      bundle: {
        id: bundleId,
        version: selectedVersion,
        source: selectedSource.label,
        required: true
      },
      updatedAt: this.clockAdapter.nowIso()
    });
  }

  public async submitHubPullRequest(uriArg?: vscode.Uri): Promise<void> {
    try {
      const targetUri = this.resolveTargetDocumentUri(uriArg);
      const workspaceDir = targetUri
        ? path.dirname(targetUri.fsPath)
        : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceDir) {
        await vscode.window.showWarningMessage('Open a local GitHub hub checkout first.');
        return;
      }

      if (targetUri) {
        const doc = await vscode.workspace.openTextDocument(targetUri);
        if (doc.isDirty) {
          await doc.save();
        }
      }

      const prTitle = await vscode.window.showInputBox({
        title: 'Submit Hub Pull Request — Title',
        prompt: 'Enter Pull Request title (leave default to use auto-generated summary)',
        value: 'feat(hub): update hub sources and profiles',
        ignoreFocusOut: true
      });
      if (!prTitle) {
        return;
      }

      const pr = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Submitting Hub Pull Request...',
          cancellable: false
        },
        async () => this.workflowService.submitPullRequest({
          workspaceDir,
          prTitle
        })
      );

      const contribContext = await this.workflowService.getWorkspaceContributionContext(workspaceDir);
      this.treeProvider.setContributionContext(contribContext);
      await this.customEditorProvider?.refreshOpenWebviews();

      const action = await vscode.window.showInformationMessage(
        `🎉 Created Pull Request #${pr.number}: ${pr.title}`,
        'Open PR in Browser'
      );
      if (action === 'Open PR in Browser') {
        await vscode.env.openExternal(vscode.Uri.parse(pr.htmlUrl));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Failed to submit hub Pull Request', error as Error);
      await vscode.window.showErrorMessage(`Failed to submit Pull Request: ${message}`);
    }
  }

  public async refreshHubPullRequestStatus(uriArg?: vscode.Uri): Promise<void> {
    const targetUri = this.resolveTargetDocumentUri(uriArg);
    const workspaceDir = targetUri
      ? path.dirname(targetUri.fsPath)
      : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceDir) {
      return;
    }
    try {
      const pr = await this.workflowService.refreshPullRequestStatus(workspaceDir);
      const contribContext = await this.workflowService.getWorkspaceContributionContext(workspaceDir);
      this.treeProvider.setContributionContext(contribContext);
      await this.customEditorProvider?.refreshOpenWebviews();
      if (pr) {
        const checks = pr.checks ? ` • Checks: ${pr.checks.state}` : '';
        const action = await vscode.window.showInformationMessage(
          `PR #${pr.number} is ${pr.state.toUpperCase()}${checks}`,
          'Open PR in Browser'
        );
        if (action === 'Open PR in Browser' && pr.htmlUrl) {
          await vscode.env.openExternal(vscode.Uri.parse(pr.htmlUrl));
        }
      } else {
        await vscode.window.showInformationMessage('No open Pull Request found for the current branch.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await vscode.window.showWarningMessage(`Failed to refresh PR status: ${message}`);
    }
  }

  public async openHubPullRequest(urlOrItem?: unknown): Promise<void> {
    let targetUrl: string | undefined;
    if (typeof urlOrItem === 'string' && /^https?:\/\//i.test(urlOrItem)) {
      targetUrl = urlOrItem;
    } else if (urlOrItem && typeof urlOrItem === 'object' && 'data' in urlOrItem) {
      const dataUrl = (urlOrItem as { data?: { url?: unknown } }).data?.url;
      if (typeof dataUrl === 'string' && /^https?:\/\//i.test(dataUrl)) {
        targetUrl = dataUrl;
      }
    }

    if (!targetUrl) {
      const targetUri = this.resolveTargetDocumentUri();
      const workspaceDir = targetUri
        ? path.dirname(targetUri.fsPath)
        : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (workspaceDir) {
        const contribContext = await this.workflowService.getWorkspaceContributionContext(workspaceDir);
        targetUrl = contribContext?.session?.pullRequest?.htmlUrl
          ?? (contribContext?.upstreamSlug ? `https://github.com/${contribContext.upstreamSlug}` : undefined);
      }
    }

    if (!targetUrl) {
      await vscode.window.showInformationMessage('No Pull Request or repository URL is associated with the current workspace.');
      return;
    }

    await vscode.env.openExternal(vscode.Uri.parse(targetUrl));
  }
}
