/**
 * Ports for the Hub Contributor Workflow: GitHub repository fork/PR operations
 * and local Git workspace operations.
 * @module ports/hub-contribution
 */
import type {
  HubReference,
} from '../domain/hub/types';

export interface GitHubUserProfile {
  login: string;
  htmlUrl: string;
}

export interface GitHubRepoMetadata {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  htmlUrl: string;
  cloneUrl: string;
  sshUrl: string;
  fork: boolean;
  canPush?: boolean;
  parentFullName?: string;
}

export interface GitHubForkInfo {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  htmlUrl: string;
  cloneUrl: string;
  sshUrl: string;
  upstreamFullName: string;
}

export interface CreatePullRequestInput {
  /** Upstream repository owner. */
  upstreamOwner: string;
  /** Upstream repository name. */
  upstreamRepo: string;
  /** Head ref in `<forkOwner>:<branch>` or `<branch>` format. */
  head: string;
  /** Target base branch in upstream repository (e.g. `main`). */
  base: string;
  /** Pull request title. */
  title: string;
  /** Pull request Markdown body. */
  body: string;
  /** Create as draft PR when true. */
  draft?: boolean;
}

export interface HubPullRequestCheckSummary {
  state: 'pending' | 'success' | 'failure' | 'neutral' | 'none';
  totalCount: number;
  passingCount: number;
  failingCount: number;
  pendingCount: number;
}

export interface HubPullRequestInfo {
  number: number;
  title: string;
  htmlUrl: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  headRef: string;
  baseRef: string;
  upstreamFullName: string;
  updatedAt: string;
  checks?: HubPullRequestCheckSummary;
}

/**
 * A GitHub CLI (`gh auth`) account entry for a host.
 */
export interface GitHubCliAccount {
  login: string;
  host: string;
  active: boolean;
  state: 'success' | 'error';
  scopes?: string;
  error?: string;
}

/**
 * Result of probing a GitHub CLI account's access to a hub repository.
 */
export interface GitHubAccountProbeResult extends GitHubCliAccount {
  canAccessHub: boolean;
  probeReason?: string;
}

/**
 * Resolution result when selecting a GitHub CLI account that can access a hub.
 */
export interface GitHubAccountResolution {
  selectedAccount?: GitHubAccountProbeResult;
  switchedFromAccount?: string;
  accounts: GitHubAccountProbeResult[];
  accessibleAccounts: GitHubAccountProbeResult[];
  message?: string;
}

/**
 * Port for GitHub collaboration actions (authenticated user lookup, repository
 * metadata, fork creation, pull request creation, PR/check status tracking,
 * and multi-account `gh auth` resolution).
 */
export interface GitHubCollaborationPort {
  getAuthenticatedUser(): Promise<GitHubUserProfile>;
  getRepository(owner: string, repo: string): Promise<GitHubRepoMetadata>;
  ensureFork(owner: string, repo: string): Promise<GitHubForkInfo>;
  createPullRequest(input: CreatePullRequestInput): Promise<HubPullRequestInfo>;
  findPullRequestsForBranch(
    upstreamOwner: string,
    upstreamRepo: string,
    headFilter: string
  ): Promise<HubPullRequestInfo[]>;
  getPullRequestStatus(
    upstreamOwner: string,
    upstreamRepo: string,
    pullNumber: number
  ): Promise<HubPullRequestInfo>;
  resolveAccessibleAccount?(
    upstreamOwner: string,
    upstreamRepo: string,
    options?: {
      host?: string;
      switchActive?: boolean;
      preferredLogin?: string;
    }
  ): Promise<GitHubAccountResolution>;
}

export interface GitWorkspaceStatus {
  isGitRepo: boolean;
  currentBranch?: string;
  remotes: Record<string, string>;
  modifiedFiles: string[];
  hasUncommittedChanges: boolean;
}

/**
 * Port for local Git repository operations used during hub contribution.
 */
export interface GitWorkspacePort {
  isGitRepository(dir: string): Promise<boolean>;
  cloneRepository(cloneUrl: string, targetDir: string): Promise<void>;
  getRemotes(dir: string): Promise<Record<string, string>>;
  ensureRemote(dir: string, name: string, url: string): Promise<void>;
  getCurrentBranch(dir: string): Promise<string>;
  fetchRemote(dir: string, remote: string, branch?: string): Promise<void>;
  checkoutBranch(dir: string, branch: string, options?: { create?: boolean; startPoint?: string }): Promise<void>;
  getStatus(dir: string): Promise<GitWorkspaceStatus>;
  getFileAtRef(dir: string, ref: string, relativeFilePath: string): Promise<string | undefined>;
  commitAndPush(
    dir: string,
    files: string[],
    message: string,
    remote: string,
    branch: string
  ): Promise<{ commitSha: string }>;
}

/**
 * Persisted session metadata for a local hub contribution workspace so that
 * reloading VS Code into the cloned fork automatically restores context.
 */
export interface HubContributionSession {
  hubId: string;
  hubName: string;
  hubReference: HubReference;
  upstreamSlug: string;
  forkSlug: string;
  defaultBranch: string;
  branchName: string;
  workspaceDir: string;
  hubConfigPath: string;
  pullRequest?: HubPullRequestInfo;
  updatedAt: string;
}
