/**
 * Release-source port — read-only access to the repository content a
 * release is planned from.
 *
 * Governed release planning reads exact bytes from an immutable Git
 * revision; the legacy compatibility path reads the working tree. Both are
 * addressed by repo-relative POSIX paths, and may report which files are
 * executable so archives keep their permission bits. Concrete adapters live in `infra`
 * (`NodeReleaseSourceReader`); tests inject an in-memory double.
 * @module ports/release-source
 */
/** Read-only view over repository content addressed by repo-relative POSIX paths. */
export interface ReleaseSourceTree {
  /**
   * Read the exact bytes of one file.
   * @param repositoryPath Repo-relative path of the file.
   * @returns The file bytes. Rejects when the file is absent.
   */
  readFile(repositoryPath: string): Promise<Uint8Array>;
  /**
   * Recursively list files under a repo-relative directory.
   * @param repositoryDirectory Repo-relative directory (`'.'` for the root).
   * @returns Normalized repo-relative file paths, in no guaranteed order.
   */
  listFiles(repositoryDirectory: string): Promise<string[]>;
  /**
   * Report whether one file is recorded as executable: Git mode `100755`
   * for a revision, the owner execute bit for a working tree. Symlinks and
   * absent paths are never executable. Optional: trees that cannot tell may
   * omit it and are treated as having no executable files.
   * @param repositoryPath Repo-relative path of the file.
   * @returns `true` only for an executable regular file.
   */
  isExecutable?(repositoryPath: string): Promise<boolean>;
}

/** A tree pinned to an immutable Git object id. */
export interface RevisionedReleaseSourceTree extends ReleaseSourceTree {
  /** Full, lowercase, immutable commit id the tree was opened at. */
  readonly revision: string;
}

/** Opens the source trees a release is planned from. */
export interface ReleaseSourceReader {
  /**
   * Resolve a revision to a full immutable commit id and open that tree.
   * @param repoRoot Absolute repository root.
   * @param revision Revision to resolve (default `'HEAD'`).
   */
  openRevision(repoRoot: string, revision?: string): Promise<RevisionedReleaseSourceTree>;
  /**
   * Open the working tree. Its `listFiles` resolves `[]` when the directory
   * is missing or is not a directory.
   * @param repoRoot Absolute repository root.
   */
  openWorkingTree(repoRoot: string): ReleaseSourceTree;
  /**
   * Read the `origin` remote URL.
   * @param repoRoot Absolute repository root.
   * @returns The URL, or `''` when unavailable. Never rejects.
   */
  readRemoteUrl(repoRoot: string): Promise<string>;
}
