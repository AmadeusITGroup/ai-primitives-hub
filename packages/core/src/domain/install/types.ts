/**
 * Domain layer — Install types.
 *
 * Mirrors the production shape at `src/types/registry.ts`
 * (`InstallationScope`, `RepositoryCommitMode`, `InstallOptions`,
 * `InstalledBundle`) so the extension's install pipeline can eventually
 * delegate here with zero field-mapping (migration plan §7.5).
 * @module domain/install/types
 */
import type {
  DeploymentManifest,
} from '../collection/types';

/**
 * Where a bundle is installed to: the current user's global profile, the
 * open VS Code workspace, or a git-tracked repository (lockfile-backed).
 */
export type InstallationScope = 'user' | 'workspace' | 'repository';

/**
 * Whether a repository-scoped install's files are committed to Git or
 * kept local-only (e.g. gitignored).
 */
export type RepositoryCommitMode = 'commit' | 'local-only';

/**
 * Options accepted by an install use case.
 */
export interface InstallOptions {
  version?: string;
  scope: InstallationScope;
  profileId?: string;
  /** Overwrite an existing install at the same path. */
  force?: boolean;
  commitMode?: RepositoryCommitMode;
}

/**
 * Record of a bundle already installed at some scope.
 */
export interface InstalledBundle {
  bundleId: string;
  version: string;
  installedAt: string;
  scope: InstallationScope;
  profileId?: string;
  installPath: string;
  manifest: DeploymentManifest;
  /** Source identifier, for identity matching across re-syncs. */
  sourceId?: string;
  /** Source type, for identity matching across re-syncs. */
  sourceType?: string;
  commitMode?: RepositoryCommitMode;
  /** Set when a lockfile entry exists but its files are missing on disk (repository scope only). */
  filesMissing?: boolean;
}
