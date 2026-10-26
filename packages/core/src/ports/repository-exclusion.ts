/**
 * RepositoryExclusion port — keeps locally installed files out of version
 * control.
 *
 * Repository-scope installs in `local-only` commit mode write files into
 * the working tree that must not be committed. The writer records them
 * through this port; the Git adapter (`GitInfoExclude` in
 * `@ai-primitives-hub/infra`) lists them in `.git/info/exclude`.
 * @module ports/repository-exclusion
 */
/**
 * Adds and removes repository paths from the local exclusion list.
 *
 * Paths are absolute and lie below the repository root the adapter was
 * created for. Adding a path that is already listed, or removing one that
 * is not, is a no-op.
 */
export interface RepositoryExclusion {
  /**
   * Exclude paths from version control.
   * @param paths - Absolute paths below the repository root.
   */
  add(paths: readonly string[]): Promise<void>;
  /**
   * Stop excluding paths.
   * @param paths - Absolute paths below the repository root.
   */
  remove(paths: readonly string[]): Promise<void>;
}
