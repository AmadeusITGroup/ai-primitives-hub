/**
 * Wiring of the shared `app` install surface for the extension's
 * repository scope.
 *
 * Only builds the writer factory, target and exclusion list the `app` use
 * cases take; placement, naming and file-location rules stay in `app` and
 * `infra`, so the extension finds a file where the CLI put it.
 * @module services/app-install-context
 */
import {
  createTargetWriterFactory,
} from '@ai-primitives-hub/app';
import type {
  RepositoryExclusion,
  Target,
  TargetType,
  TargetWriter,
} from '@ai-primitives-hub/core';
import {
  GitInfoExclude,
  NodeFileSystem,
} from '@ai-primitives-hub/infra';
import type {
  RepositoryCommitMode,
} from '../types/registry';

/**
 * Writer factory over the real filesystem. Project layout files are read
 * from the workspace; the user layout layer is off. The extension owns the
 * exclusion calls, so the repository-scope writer leaves `info/exclude`
 * alone.
 * @param workspaceRoot - Workspace root, or `null` when there is none.
 * @returns The writer factory.
 */
export function createExtensionWriterFactory(workspaceRoot: string | null): (target: Target) => TargetWriter {
  return createTargetWriterFactory({
    fs: new NodeFileSystem(),
    env: process.env,
    projectDir: workspaceRoot,
    userConfigDir: null,
    writerOwnsExclusion: false
  });
}

/**
 * Repository-scope target of the host.
 * @param workspaceRoot - Workspace root.
 * @param commitMode - Commit mode of the install.
 * @param hostType - Target type of the host editor.
 * @returns The target.
 */
export function repositoryTarget(workspaceRoot: string, commitMode: RepositoryCommitMode, hostType: TargetType): Target {
  return {
    name: hostType,
    type: hostType,
    scope: 'repository',
    commitMode,
    rootPath: workspaceRoot
  };
}

/**
 * Exclusion list of the workspace's git repository (`info/exclude`,
 * worktrees and submodules included). Never creates a `.git`.
 * @param workspaceRoot - Workspace root.
 * @returns The exclusion list.
 */
export function repositoryExclusion(workspaceRoot: string): RepositoryExclusion {
  return new GitInfoExclude({ fs: new NodeFileSystem(), workspaceRoot });
}
