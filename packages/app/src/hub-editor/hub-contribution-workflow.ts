/**
 * Orchestrates the end-to-end Hub Contributor Workflow:
 * - Enforces GitHub-connected hub eligibility (rejecting Artifactory hubs as
 *   read-only replicas populated by promotion)
 * - Forks the upstream GitHub hub repository
 * - Clones or attaches to a local repository checkout
 * - Configures `origin` (fork) and `upstream` remotes and checks out a branch
 * - Validates, commits, pushes, creates a Pull Request, and tracks PR/check status
 * @module hub-editor/hub-contribution-workflow
 */
import * as path from 'node:path';
import type {
  Clock,
  FileSystem,
  GitHubAccountResolution,
  GitHubCollaborationPort,
  GitWorkspacePort,
  HubConfig,
  HubContributionEligibility,
  HubContributionSession,
  HubPullRequestInfo,
  HubReference,
} from '@ai-primitives-hub/core';
import {
  isContributableHub,
} from '@ai-primitives-hub/core';
import {
  applyHubYamlMutation,
  extractGitHubSlugFromRemoteUrl,
  summarizeHubYamlChanges,
  validateHubConfigYaml,
} from '@ai-primitives-hub/infra';

export interface HubContributionWorkflowDeps {
  fs: FileSystem;
  clock: Clock;
  github: GitHubCollaborationPort;
  git: GitWorkspacePort;
  /** File path where active contribution sessions are persisted. */
  sessionStorePath: string;
}

export interface BootstrapHubContributionInput {
  hubId: string;
  hubName: string;
  hubReference: HubReference;
  targetDir: string;
  branchName: string;
  preferredGitHubLogin?: string;
}

export interface SubmitHubPullRequestInput {
  workspaceDir: string;
  hubConfigFileName?: string;
  commitMessage?: string;
  prTitle?: string;
  prBody?: string;
  draft?: boolean;
  touchUpdatedAt?: boolean;
}

export interface WorkspaceContributionContext {
  isHubWorkspace: boolean;
  workspaceDir: string;
  hubConfigPath: string;
  upstreamSlug?: string;
  forkSlug?: string;
  currentBranch?: string;
  defaultBranch: string;
  hasUncommittedChanges: boolean;
  session?: HubContributionSession;
}

export class HubContributionWorkflowService {
  public constructor(private readonly deps: HubContributionWorkflowDeps) {}

  /**
   * Determine whether a hub is eligible for contribution and visual editing.
   *
   * Only hubs connected with GitHub are qualified. Artifactory hubs are
   * read-only replicas populated by the promotion process and are strictly
   * rejected.
   * @param hub Hub descriptor (`id`, `config`, `reference`).
   * @param hub.id
   * @param hub.config
   * @param hub.reference
   */
  public async evaluateHubForContribution(hub: {
    id: string;
    config: HubConfig;
    reference: HubReference;
  }): Promise<HubContributionEligibility> {
    if (hub.reference.type === 'local' && hub.reference.location) {
      const repoDir = hub.reference.location.endsWith('.yml') || hub.reference.location.endsWith('.yaml')
        ? path.dirname(hub.reference.location)
        : hub.reference.location;
      const remotes = await this.deps.git.getRemotes(repoDir);
      const remoteUrl = remotes.upstream ?? remotes.origin;
      const remoteSlug = remoteUrl ? extractGitHubSlugFromRemoteUrl(remoteUrl) : undefined;
      return isContributableHub(hub.reference, remoteSlug);
    }
    return isContributableHub(hub.reference);
  }

  /**
   * Probe available `gh auth` accounts against a target `owner/repo` and
   * optionally switch the active `gh` account to one with verified access.
   * @param repositorySlug Target `owner/repo` slug.
   * @param options Account resolution options.
   * @param options.switchActive
   * @param options.preferredLogin
   */
  public async resolveHubGitHubAccount(
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
   * Execute the Fork -> Clone (or Sync existing local clone) -> Branch pipeline
   * and persist the contribution session.
   * @param input Bootstrap parameters.
   */
  public async bootstrapContributionWorkspace(
    input: BootstrapHubContributionInput
  ): Promise<HubContributionSession & { accountResolution?: GitHubAccountResolution }> {
    let remoteSlugForLocal: string | undefined;
    if (input.hubReference.type === 'local') {
      const localDir = input.hubReference.location.endsWith('.yml') || input.hubReference.location.endsWith('.yaml')
        ? path.dirname(input.hubReference.location)
        : input.hubReference.location;
      const remotes = await this.deps.git.getRemotes(localDir);
      const remoteUrl = remotes.upstream ?? remotes.origin;
      remoteSlugForLocal = remoteUrl ? extractGitHubSlugFromRemoteUrl(remoteUrl) : undefined;
    }

    const eligibility = isContributableHub(input.hubReference, remoteSlugForLocal);
    if (!eligibility.contributable || !eligibility.repositorySlug) {
      throw new Error(
        eligibility.reason
        ?? 'Only hubs connected with a GitHub repository support contributions.'
      );
    }

    const [upstreamOwner, upstreamRepo] = eligibility.repositorySlug.split('/');
    const accountResolution = await this.resolveHubGitHubAccount(eligibility.repositorySlug, {
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
    const requestedRef = input.hubReference.ref?.trim();
    // Only branch names are valid PR bases; commit SHAs or version tags fall back to upstream defaultBranch
    const baseBranch = requestedRef && !/^[0-9a-f]{7,40}$/i.test(requestedRef) && !/^v?\d+\.\d+/.test(requestedRef)
      ? requestedRef
      : upstreamRepoMeta.defaultBranch;
    await this.deps.git.fetchRemote(input.targetDir, 'upstream', baseBranch);

    const branchName = input.branchName.trim() || 'feat/update-hub-config';
    await this.deps.git.checkoutBranch(input.targetDir, branchName, {
      create: true,
      startPoint: `upstream/${baseBranch}`
    });

    const hubConfigPath = path.join(input.targetDir, 'hub-config.yml');
    const session: HubContributionSession = {
      hubId: input.hubId,
      hubName: input.hubName,
      hubReference: input.hubReference,
      upstreamSlug: eligibility.repositorySlug,
      forkSlug: fork.fullName,
      defaultBranch: baseBranch,
      branchName,
      workspaceDir: input.targetDir,
      hubConfigPath,
      updatedAt: this.deps.clock.nowIso()
    };

    await this.saveSession(session);
    return {
      ...session,
      accountResolution
    };
  }

  /**
   * Inspect a local workspace directory to determine its hub contribution state.
   * @param workspaceDir Local workspace root directory.
   */
  public async getWorkspaceContributionContext(
    workspaceDir: string
  ): Promise<WorkspaceContributionContext> {
    const hubConfigPath = path.join(workspaceDir, 'hub-config.yml');
    const hasConfig = await this.deps.fs.exists(hubConfigPath);
    const status = await this.deps.git.getStatus(workspaceDir);
    const savedSession = await this.loadSession(workspaceDir);

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
      isHubWorkspace: hasConfig && Boolean(upstreamSlug),
      workspaceDir,
      hubConfigPath,
      upstreamSlug,
      forkSlug: originSlug,
      currentBranch: status.currentBranch ?? savedSession?.branchName,
      defaultBranch: savedSession?.defaultBranch ?? 'main',
      hasUncommittedChanges: status.hasUncommittedChanges,
      session: activeSession
    };
  }

  /**
   * Validate `hub-config.yml`, touch `metadata.updatedAt`, stage, commit, push
   * to the fork remote, and create a Pull Request against the upstream hub repo.
   * @param input Submission options.
   */
  public async submitPullRequest(
    input: SubmitHubPullRequestInput
  ): Promise<HubPullRequestInfo> {
    const configFileName = input.hubConfigFileName ?? 'hub-config.yml';
    const hubConfigPath = path.join(input.workspaceDir, configFileName);
    const context = await this.getWorkspaceContributionContext(input.workspaceDir);
    if (!context.upstreamSlug) {
      throw new Error('Workspace does not have a GitHub upstream or origin remote.');
    }

    const [upstreamOwner, upstreamRepo] = context.upstreamSlug.split('/');
    const defaultBranch = context.session?.defaultBranch
      ?? (await this.deps.github.getRepository(upstreamOwner, upstreamRepo).catch(() => undefined))?.defaultBranch
      ?? context.defaultBranch;

    const branchName = context.currentBranch ?? 'feat/update-hub-config';
    if (branchName === defaultBranch || branchName === 'HEAD') {
      throw new Error(
        `Refusing to commit directly to '${branchName}'. Check out a feature branch before submitting a Pull Request.`
      );
    }

    const rawContent = await this.deps.fs.readFile(hubConfigPath);
    const content = input.touchUpdatedAt === false
      ? rawContent
      : applyHubYamlMutation(rawContent, {
        kind: 'touch-updated-at',
        updatedAt: this.deps.clock.nowIso()
      });

    const validation = validateHubConfigYaml(content);
    if (!validation.valid) {
      throw new Error(
        `Cannot submit Pull Request because ${configFileName} has validation errors:\n- ${validation.errors.join('\n- ')}`
      );
    }

    if (content !== rawContent) {
      await this.deps.fs.writeFile(hubConfigPath, content);
    }

    await this.resolveHubGitHubAccount(context.upstreamSlug, { switchActive: true });

    const baseContent = await this.deps.git.getFileAtRef(
      input.workspaceDir,
      `upstream/${defaultBranch}`,
      configFileName
    ) ?? '';
    const diffSummary = summarizeHubYamlChanges(baseContent, content);

    const commitMessage = input.commitMessage?.trim() || diffSummary.suggestedCommitMessage;
    const prTitle = input.prTitle?.trim() || diffSummary.suggestedPrTitle;
    const prBody = input.prBody?.trim() || diffSummary.suggestedPrBody;

    await this.deps.git.commitAndPush(
      input.workspaceDir,
      [configFileName],
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

    const sessionToSave: HubContributionSession = context.session
      ? {
        ...context.session,
        branchName,
        pullRequest: pr,
        updatedAt: this.deps.clock.nowIso()
      }
      : {
        hubId: context.upstreamSlug.replaceAll('/', '-').toLowerCase(),
        hubName: String((validation.config as HubConfig | undefined)?.metadata?.name ?? context.upstreamSlug),
        hubReference: {
          type: 'github',
          location: context.upstreamSlug,
          ref: defaultBranch
        },
        upstreamSlug: context.upstreamSlug,
        forkSlug: context.forkSlug ?? context.upstreamSlug,
        defaultBranch,
        branchName,
        workspaceDir: input.workspaceDir,
        hubConfigPath,
        pullRequest: pr,
        updatedAt: this.deps.clock.nowIso()
      };

    await this.saveSession(sessionToSave);

    return pr;
  }

  /**
   * Refresh the Pull Request and CI check-run status for a local hub workspace.
   * Only open Pull Requests are tracked; if a previously tracked PR has been
   * closed or merged, it is cleared from the active session unless a newer open
   * PR exists for the current branch.
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

  public async loadSession(workspaceDir: string): Promise<HubContributionSession | undefined> {
    try {
      const exists = await this.deps.fs.exists(this.deps.sessionStorePath);
      if (!exists) {
        return undefined;
      }
      const raw = await this.deps.fs.readFile(this.deps.sessionStorePath);
      const map = JSON.parse(raw) as Record<string, HubContributionSession>;
      return map[path.resolve(workspaceDir)];
    } catch {
      return undefined;
    }
  }

  public async saveSession(session: HubContributionSession): Promise<void> {
    let map: Record<string, HubContributionSession> = {};
    try {
      if (await this.deps.fs.exists(this.deps.sessionStorePath)) {
        const raw = await this.deps.fs.readFile(this.deps.sessionStorePath);
        map = JSON.parse(raw) as Record<string, HubContributionSession>;
      }
    } catch {
      map = {};
    }
    map[path.resolve(session.workspaceDir)] = session;
    await this.deps.fs.mkdir(path.dirname(this.deps.sessionStorePath), { recursive: true });
    await this.deps.fs.writeFile(this.deps.sessionStorePath, JSON.stringify(map, null, 2));
  }
}
