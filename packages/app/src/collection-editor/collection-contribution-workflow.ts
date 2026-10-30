/**
 * Orchestrates the end-to-end Collection Contributor Workflow:
 * - Enforces GitHub-connected collection source eligibility (rejecting
 *   Artifactory sources as read-only replicas populated by promotion)
 * - Resolves the target `<collectionId>` and `.collection.yml` path from a
 *   Marketplace tile or Registry Explorer item
 * - Forks the upstream GitHub collection repository
 * - Clones or attaches to a local repository checkout
 * - Configures `origin` (fork) and `upstream` remotes and checks out a branch
 * - Validates collections, stages multi-file changes (`.collection.yml` +
 *   referenced primitives), commits, pushes, creates a Pull Request, and tracks
 *   open PR/CI check status
 * @module collection-editor/collection-contribution-workflow
 */
import * as path from 'node:path';
import {
  type Clock,
  type CollectionContributionEligibility,
  type CollectionContributionSession,
  type FileSystem,
  type GitHubAccountResolution,
  type GitHubCollaborationPort,
  type GitWorkspacePort,
  type HubPullRequestInfo,
  isContributableCollectionSource,
  type RegistrySource,
  resolveCollectionIdFromBundle,
} from '@ai-primitives-hub/core';
import {
  extractGitHubSlugFromRemoteUrl,
  summarizeCollectionYamlChanges,
  validateCollectionYaml,
} from '@ai-primitives-hub/infra';

export interface CollectionContributionWorkflowDeps {
  fs: FileSystem;
  clock: Clock;
  github: GitHubCollaborationPort;
  git: GitWorkspacePort;
  /** File path where active collection contribution sessions are persisted. */
  sessionStorePath: string;
}

export interface BootstrapCollectionContributionInput {
  source: Pick<RegistrySource, 'id' | 'name' | 'type' | 'url' | 'config'>;
  bundleId?: string;
  targetDir: string;
  branchName?: string;
  preferredGitHubLogin?: string;
}

export interface SubmitCollectionPullRequestInput {
  workspaceDir: string;
  collectionsPath?: string;
  commitMessage?: string;
  prTitle?: string;
  prBody?: string;
  draft?: boolean;
}

export interface CollectionWorkspaceContributionContext {
  isCollectionWorkspace: boolean;
  workspaceDir: string;
  collectionsPath: string;
  collectionFiles: string[];
  upstreamSlug?: string;
  forkSlug?: string;
  currentBranch?: string;
  defaultBranch: string;
  modifiedFiles: string[];
  hasUncommittedChanges: boolean;
  session?: CollectionContributionSession;
}

interface StoredCollectionSessionsFile {
  sessions: Record<string, CollectionContributionSession>;
}

export class CollectionContributionWorkflowService {
  public constructor(private readonly deps: CollectionContributionWorkflowDeps) {}

  private normalizeDirKey(dir: string): string {
    return path.resolve(dir).replaceAll('\\', '/');
  }

  private async readAllSessions(): Promise<Record<string, CollectionContributionSession>> {
    try {
      if (!(await this.deps.fs.exists(this.deps.sessionStorePath))) {
        return {};
      }
      const raw = await this.deps.fs.readFile(this.deps.sessionStorePath);
      const parsed = JSON.parse(raw) as Partial<StoredCollectionSessionsFile>;
      return parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {};
    } catch {
      return {};
    }
  }

  private async loadSession(workspaceDir: string): Promise<CollectionContributionSession | undefined> {
    const all = await this.readAllSessions();
    return all[this.normalizeDirKey(workspaceDir)];
  }

  private async saveSession(session: CollectionContributionSession): Promise<void> {
    const all = await this.readAllSessions();
    all[this.normalizeDirKey(session.workspaceDir)] = session;
    await this.deps.fs.mkdir(path.dirname(this.deps.sessionStorePath), { recursive: true });
    await this.deps.fs.writeFile(
      this.deps.sessionStorePath,
      JSON.stringify({ sessions: all }, null, 2)
    );
  }

  private async listWorkspaceCollectionRelFiles(
    workspaceDir: string,
    collectionsPath = 'collections'
  ): Promise<string[]> {
    const absDir = path.join(workspaceDir, collectionsPath);
    if (!(await this.deps.fs.exists(absDir))) {
      return [];
    }
    try {
      const entries = await this.deps.fs.readDir(absDir);
      return entries
        .filter((f: string) => /\.collection\.ya?ml$/i.test(f))
        .toSorted()
        .map((f: string) => `${collectionsPath}/${f}`.replaceAll('\\', '/'));
    } catch {
      return [];
    }
  }

  /**
   * Determine whether a registry source (and optional bundle ID) is eligible
   * for collection contribution and visual editing.
   * @param source Registry source descriptor.
   * @param bundleId Optional Marketplace/Explorer bundle ID.
   */
  public async evaluateSourceForContribution(
    source: Pick<RegistrySource, 'type' | 'url' | 'config'>,
    bundleId?: string
  ): Promise<CollectionContributionEligibility & { targetCollectionId?: string; targetCollectionFilePath?: string }> {
    let remoteSlug: string | undefined;
    if ((source.type === 'local' || source.type === 'local-awesome-copilot') && source.url) {
      const remotes = await this.deps.git.getRemotes(source.url);
      const remoteUrl = remotes.upstream ?? remotes.origin;
      remoteSlug = remoteUrl ? extractGitHubSlugFromRemoteUrl(remoteUrl) : undefined;
    }

    const eligibility = isContributableCollectionSource(source, remoteSlug);
    const resolvedTarget = bundleId ? resolveCollectionIdFromBundle(bundleId, source) : null;

    return {
      ...eligibility,
      targetCollectionId: resolvedTarget?.collectionId,
      targetCollectionFilePath: resolvedTarget?.collectionFilePath
    };
  }

  /**
   * Probe available `gh auth` accounts against a target `owner/repo` and
   * optionally switch the active `gh` account to one with verified access.
   * @param repositorySlug Target `owner/repo` slug.
   * @param options Account resolution options.
   * @param options.switchActive
   * @param options.preferredLogin
   */
  public async resolveCollectionGitHubAccount(
    repositorySlug: string,
    options?: {
      switchActive?: boolean;
      preferredLogin?: string;
    }
  ): Promise<GitHubAccountResolution | undefined> {
    if (!this.deps.github.resolveAccessibleAccount) {
      return undefined;
    }
    const [owner, repo] = repositorySlug.split('/');
    if (!owner || !repo) {
      return undefined;
    }
    return this.deps.github.resolveAccessibleAccount(owner, repo, options);
  }

  /**
   * Execute the `Fork -> Clone -> Branch -> Resolve Target Collection` pipeline
   * and persist the contribution session.
   * @param input Bootstrap parameters.
   */
  public async bootstrapContributionWorkspace(
    input: BootstrapCollectionContributionInput
  ): Promise<CollectionContributionSession & { accountResolution?: GitHubAccountResolution }> {
    const eligibility = await this.evaluateSourceForContribution(input.source, input.bundleId);
    if (!eligibility.contributable || !eligibility.repositorySlug) {
      throw new Error(
        eligibility.reason
        ?? 'Only GitHub-connected collection sources support contribution.'
      );
    }

    const [upstreamOwner, upstreamRepo] = eligibility.repositorySlug.split('/');
    const accountResolution = await this.resolveCollectionGitHubAccount(eligibility.repositorySlug, {
      switchActive: true,
      preferredLogin: input.preferredGitHubLogin
    });
    if (accountResolution && accountResolution.accounts.length > 0 && !accountResolution.selectedAccount) {
      throw new Error(
        accountResolution.message
        ?? `No GitHub CLI account has access to ${eligibility.repositorySlug}.`
      );
    }

    const fork = await this.deps.github.ensureFork(upstreamOwner, upstreamRepo);
    const upstreamCloneUrl = `https://github.com/${eligibility.repositorySlug}.git`;

    const isAlreadyGit = await this.deps.git.isGitRepository(input.targetDir);
    if (!isAlreadyGit) {
      await this.deps.git.cloneRepository(fork.cloneUrl, input.targetDir);
    }

    const existingRemotes = await this.deps.git.getRemotes(input.targetDir);
    const sameRepo = (url: string | undefined, slug: string): boolean =>
      url !== undefined && extractGitHubSlugFromRemoteUrl(url)?.toLowerCase() === slug.toLowerCase();
    if (!sameRepo(existingRemotes.origin, fork.fullName)) {
      await this.deps.git.ensureRemote(input.targetDir, 'origin', fork.cloneUrl);
    }
    if (!sameRepo(existingRemotes.upstream, eligibility.repositorySlug)) {
      await this.deps.git.ensureRemote(input.targetDir, 'upstream', upstreamCloneUrl);
    }

    const upstreamRepoMeta = await this.deps.github.getRepository(upstreamOwner, upstreamRepo)
      .catch(() => ({ defaultBranch: fork.defaultBranch }));
    const requestedBranch = eligibility.branch;
    const baseBranch = requestedBranch && !/^[0-9a-f]{7,40}$/i.test(requestedBranch)
      ? requestedBranch
      : upstreamRepoMeta.defaultBranch;

    await this.deps.git.fetchRemote(input.targetDir, 'upstream', baseBranch);

    const defaultFeatureBranch = eligibility.targetCollectionId
      ? `feat/collection-${eligibility.targetCollectionId}`
      : 'feat/update-collections';
    const branchName = input.branchName?.trim() || defaultFeatureBranch;
    await this.deps.git.checkoutBranch(input.targetDir, branchName, {
      create: true,
      startPoint: `upstream/${baseBranch}`
    });

    const detectedFiles = await this.listWorkspaceCollectionRelFiles(
      input.targetDir,
      eligibility.collectionsPath
    );
    let targetCollectionPath: string | undefined;
    if (eligibility.targetCollectionFilePath) {
      const candidateAbs = path.join(input.targetDir, eligibility.targetCollectionFilePath);
      if (await this.deps.fs.exists(candidateAbs)) {
        targetCollectionPath = candidateAbs;
      }
    }
    if (!targetCollectionPath && detectedFiles.length > 0) {
      targetCollectionPath = path.join(input.targetDir, detectedFiles[0]);
    }

    const session: CollectionContributionSession = {
      sourceId: input.source.id,
      sourceName: input.source.name,
      sourceType: input.source.type,
      collectionId: eligibility.targetCollectionId,
      collectionsPath: eligibility.collectionsPath,
      upstreamSlug: eligibility.repositorySlug,
      forkSlug: fork.fullName,
      defaultBranch: baseBranch,
      branchName,
      workspaceDir: input.targetDir,
      targetCollectionPath,
      updatedAt: this.deps.clock.nowIso()
    };

    await this.saveSession(session);
    return {
      ...session,
      accountResolution
    };
  }

  /**
   * Inspect a local workspace directory to determine its collection contribution state.
   * @param workspaceDir Local workspace root directory.
   * @param collectionsPath Optional relative collections folder.
   */
  public async getWorkspaceContributionContext(
    workspaceDir: string,
    collectionsPath?: string
  ): Promise<CollectionWorkspaceContributionContext> {
    const savedSession = await this.loadSession(workspaceDir);
    const effectiveCollectionsPath = collectionsPath ?? savedSession?.collectionsPath ?? 'collections';
    const collectionFiles = await this.listWorkspaceCollectionRelFiles(workspaceDir, effectiveCollectionsPath);
    const status = await this.deps.git.getStatus(workspaceDir);

    const originSlug = status.remotes.origin
      ? extractGitHubSlugFromRemoteUrl(status.remotes.origin)
      : savedSession?.forkSlug;
    const upstreamSlug = status.remotes.upstream
      ? extractGitHubSlugFromRemoteUrl(status.remotes.upstream)
      : (savedSession?.upstreamSlug ?? originSlug);

    const activeSession = savedSession?.pullRequest && savedSession.pullRequest.state !== 'open'
      ? { ...savedSession, pullRequest: undefined }
      : savedSession;

    return {
      isCollectionWorkspace: collectionFiles.length > 0,
      workspaceDir,
      collectionsPath: effectiveCollectionsPath,
      collectionFiles,
      upstreamSlug,
      forkSlug: originSlug,
      currentBranch: status.currentBranch ?? savedSession?.branchName,
      defaultBranch: savedSession?.defaultBranch ?? 'main',
      modifiedFiles: status.modifiedFiles,
      hasUncommittedChanges: status.hasUncommittedChanges,
      session: activeSession
    };
  }

  /**
   * Validate all collections in the workspace, stage all modified/created
   * `.collection.yml` manifests and primitive files, commit, push to the fork
   * remote, and create a Pull Request against the upstream collection repo.
   * @param input Submission options.
   */
  public async submitPullRequest(
    input: SubmitCollectionPullRequestInput
  ): Promise<HubPullRequestInfo> {
    const context = await this.getWorkspaceContributionContext(input.workspaceDir, input.collectionsPath);
    if (!context.upstreamSlug) {
      throw new Error('Workspace does not have a GitHub upstream or origin remote.');
    }

    const [upstreamOwner, upstreamRepo] = context.upstreamSlug.split('/');
    const defaultBranch = context.session?.defaultBranch
      ?? (await this.deps.github.getRepository(upstreamOwner, upstreamRepo).catch(() => undefined))?.defaultBranch
      ?? context.defaultBranch;

    const branchName = context.currentBranch ?? 'feat/update-collections';
    if (branchName === defaultBranch || branchName === 'HEAD') {
      throw new Error(
        `Refusing to commit directly to '${branchName}'. Check out a feature branch before submitting a Pull Request.`
      );
    }

    if (context.collectionFiles.length === 0) {
      throw new Error(`No collection files (*.collection.yml) found in '${context.collectionsPath}/'.`);
    }

    // Validate all collection files in the workspace (including duplicate ID/name checks)
    const contentsByRel = new Map<string, string>();
    const siblingSummaries: { file: string; id?: string; name?: string }[] = [];
    for (const relFile of context.collectionFiles) {
      const raw = await this.deps.fs.readFile(path.join(input.workspaceDir, relFile));
      contentsByRel.set(relFile, raw);
      const quickVal = validateCollectionYaml(raw, { fileLabel: relFile });
      siblingSummaries.push({
        file: relFile,
        id: quickVal.manifest?.id,
        name: quickVal.manifest?.name
      });
    }

    const allErrors: string[] = [];
    for (const [relFile, raw] of contentsByRel.entries()) {
      const res = validateCollectionYaml(raw, {
        fileLabel: relFile,
        siblingCollections: siblingSummaries
      });
      if (!res.valid) {
        allErrors.push(...res.errors);
      }
    }

    if (allErrors.length > 0) {
      throw new Error(
        `Cannot submit Pull Request because collection validation failed:\n- ${allErrors.join('\n- ')}`
      );
    }

    await this.resolveCollectionGitHubAccount(context.upstreamSlug, { switchActive: true });

    // Restrict staged files to collection manifests and paths referenced by them
    // (items, skill/plugin/power directories, and readme.path) so unrelated or
    // sensitive untracked files in the workspace are never staged automatically.
    const referencedFiles = new Set<string>(context.collectionFiles);
    const referencedDirPrefixes: string[] = [];
    for (const raw of contentsByRel.values()) {
      const manifest = validateCollectionYaml(raw).manifest;
      for (const item of manifest?.items ?? []) {
        if (item?.path) {
          const normalizedItemPath = item.path.replaceAll('\\', '/').replace(/^\/+/, '');
          referencedFiles.add(normalizedItemPath);
          if (item.kind === 'skill' || item.kind === 'plugin' || item.kind === 'power') {
            const dirPrefix = path.posix.dirname(normalizedItemPath);
            if (dirPrefix && dirPrefix !== '.') {
              referencedDirPrefixes.push(`${dirPrefix}/`);
            }
          }
        }
      }
      if (manifest?.readme?.path) {
        referencedFiles.add(manifest.readme.path.replaceAll('\\', '/').replace(/^\/+/, ''));
      }
    }

    const filesToStage = context.modifiedFiles.filter((file) => {
      const normalized = file.replaceAll('\\', '/').replace(/^\/+/, '');
      return /\.collection\.ya?ml$/i.test(normalized)
        || referencedFiles.has(normalized)
        || referencedDirPrefixes.some((prefix) => normalized.startsWith(prefix));
    });

    // Summarize changes across modified collection files
    const modifiedCollectionFiles = filesToStage.filter((f) => /\.collection\.ya?ml$/i.test(f));
    const targetCollectionFilesForSummary = modifiedCollectionFiles.length > 0
      ? modifiedCollectionFiles
      : [context.collectionFiles[0]];

    const summaries = [];
    for (const relFile of targetCollectionFilesForSummary) {
      const currentYaml = contentsByRel.get(relFile)
        ?? await this.deps.fs.readFile(path.join(input.workspaceDir, relFile)).catch(() => '');
      const baseYaml = await this.deps.git.getFileAtRef(
        input.workspaceDir,
        `upstream/${defaultBranch}`,
        relFile
      );
      if (currentYaml) {
        summaries.push(summarizeCollectionYamlChanges(baseYaml, currentYaml));
      }
    }

    const primarySummary = summaries[0];
    const primitiveFilesChanged = filesToStage.filter((f) => !/\.collection\.ya?ml$/i.test(f));

    const defaultCommitMessage = primarySummary
      ? primarySummary.suggestedCommitMessage
      : `feat(collection): update collections (${filesToStage.length} file(s))`;
    const defaultPrTitle = primarySummary
      ? primarySummary.suggestedPrTitle
      : `feat(collection): update collections`;

    const bodySections: string[] = [];
    if (summaries.length > 0) {
      bodySections.push(summaries.map((s) => s.suggestedPrBody).join('\n\n'));
    } else {
      bodySections.push('## Summary\n\n- Updated collection files');
    }
    if (primitiveFilesChanged.length > 0) {
      bodySections.push(
        `### Modified Primitive & Documentation Files\n\n${primitiveFilesChanged.map((f) => `- \`${f}\``).join('\n')}`
      );
    }

    const commitMessage = input.commitMessage?.trim() || defaultCommitMessage;
    const prTitle = input.prTitle?.trim() || defaultPrTitle;
    const prBody = input.prBody?.trim() || bodySections.join('\n\n');

    await this.deps.git.commitAndPush(
      input.workspaceDir,
      filesToStage,
      commitMessage,
      'origin',
      branchName
    );

    const forkOwner = context.forkSlug ? context.forkSlug.split('/')[0] : upstreamOwner;
    const headRef = forkOwner.toLowerCase() === upstreamOwner.toLowerCase()
      ? branchName
      : `${forkOwner}:${branchName}`;

    const existingPrs = await this.deps.github.findPullRequestsForBranch(
      upstreamOwner,
      upstreamRepo,
      `${forkOwner}:${branchName}`
    );
    const existingOpenPr = existingPrs.find((item) => item.state === 'open')
      ?? (context.session?.pullRequest?.state === 'open' && context.session.pullRequest.headRef === branchName
        ? context.session.pullRequest
        : undefined);

    const pr = existingOpenPr
      ? await this.deps.github.getPullRequestStatus(upstreamOwner, upstreamRepo, existingOpenPr.number)
      : await this.deps.github.createPullRequest({
        upstreamOwner,
        upstreamRepo,
        head: headRef,
        base: defaultBranch,
        title: prTitle,
        body: prBody,
        draft: input.draft
      });

    const sessionToSave: CollectionContributionSession = context.session
      ? {
        ...context.session,
        branchName,
        pullRequest: pr,
        updatedAt: this.deps.clock.nowIso()
      }
      : {
        sourceId: context.upstreamSlug.replaceAll('/', '-').toLowerCase(),
        sourceName: context.upstreamSlug,
        sourceType: 'github',
        collectionId: primarySummary?.collectionId,
        collectionsPath: context.collectionsPath,
        upstreamSlug: context.upstreamSlug,
        forkSlug: context.forkSlug ?? context.upstreamSlug,
        defaultBranch,
        branchName,
        workspaceDir: input.workspaceDir,
        targetCollectionPath: context.collectionFiles[0]
          ? path.join(input.workspaceDir, context.collectionFiles[0])
          : undefined,
        pullRequest: pr,
        updatedAt: this.deps.clock.nowIso()
      };

    await this.saveSession(sessionToSave);
    return pr;
  }

  /**
   * Refresh the Pull Request and CI check-run status for a local collection workspace.
   * Only open Pull Requests are tracked; closed/merged PRs are cleared from active state.
   * @param workspaceDir Local workspace root directory.
   */
  public async refreshPullRequestStatus(
    workspaceDir: string
  ): Promise<HubPullRequestInfo | undefined> {
    const context = await this.getWorkspaceContributionContext(workspaceDir);
    if (!context.upstreamSlug) {
      return undefined;
    }
    const [upstreamOwner, upstreamRepo] = context.upstreamSlug.split('/');
    const storedSession = await this.loadSession(workspaceDir);

    const findOpenPrNumberForBranch = async (): Promise<number | undefined> => {
      if (!context.currentBranch) {
        return undefined;
      }
      const forkOwner = context.forkSlug ? context.forkSlug.split('/')[0] : upstreamOwner;
      const headFilter = `${forkOwner}:${context.currentBranch}`;
      const found = await this.deps.github.findPullRequestsForBranch(
        upstreamOwner,
        upstreamRepo,
        headFilter
      );
      return found.find((item) => item.state === 'open')?.number;
    };

    let prNumber = storedSession?.pullRequest?.state === 'open'
      ? storedSession.pullRequest.number
      : undefined;
    if (!prNumber) {
      prNumber = await findOpenPrNumberForBranch();
    }

    if (!prNumber) {
      if (storedSession?.pullRequest) {
        await this.saveSession({
          ...storedSession,
          pullRequest: undefined,
          updatedAt: this.deps.clock.nowIso()
        });
      }
      return undefined;
    }

    let status = await this.deps.github.getPullRequestStatus(
      upstreamOwner,
      upstreamRepo,
      prNumber
    );

    if (status.state !== 'open') {
      const replacementOpenNumber = await findOpenPrNumberForBranch();
      if (replacementOpenNumber && replacementOpenNumber !== prNumber) {
        status = await this.deps.github.getPullRequestStatus(
          upstreamOwner,
          upstreamRepo,
          replacementOpenNumber
        );
      }
    }

    if (status.state !== 'open') {
      if (storedSession) {
        await this.saveSession({
          ...storedSession,
          pullRequest: undefined,
          updatedAt: this.deps.clock.nowIso()
        });
      }
      return undefined;
    }

    if (storedSession) {
      await this.saveSession({
        ...storedSession,
        pullRequest: status,
        updatedAt: this.deps.clock.nowIso()
      });
    }

    return status;
  }
}
