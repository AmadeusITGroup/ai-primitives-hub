/**
 * Ports & session contracts for the Collection Contributor Workflow.
 * @module ports/collection-contribution
 */
import type {
  HubPullRequestInfo,
} from './hub-contribution';

/**
 * Persisted session metadata for a local collection contribution workspace so
 * that opening or reloading VS Code into the cloned fork automatically restores
 * collection context and opens the target `.collection.yml` in the Visual Editor.
 */
export interface CollectionContributionSession {
  sourceId: string;
  sourceName: string;
  sourceType: string;
  /** Target collection ID when bootstrapped from a specific collection card/bundle. */
  collectionId?: string;
  /** Collections directory relative to the repo root (default `collections`). */
  collectionsPath: string;
  /** Upstream `owner/repo` slug on GitHub. */
  upstreamSlug: string;
  /** User fork `owner/repo` slug on GitHub. */
  forkSlug: string;
  /** Upstream default/base branch name (e.g. `main`). */
  defaultBranch: string;
  /** Checked-out feature branch name in the local clone. */
  branchName: string;
  /** Local workspace directory path. */
  workspaceDir: string;
  /** Absolute or workspace-relative path to the focused `.collection.yml` file. */
  targetCollectionPath?: string;
  /** Active open Pull Request metadata, if created/found. */
  pullRequest?: HubPullRequestInfo;
  /** ISO-8601 timestamp when the session was last updated. */
  updatedAt: string;
}
