/**
 * AppStorage port — universal, non-VS-Code-specific storage-root
 * resolution for the registry/bookkeeping layer (config, cache, profiles,
 * logs and the shared user install record).
 *
 * Models the directory/file responsibilities every client shares, plus a
 * tiny generic key/value slot for small persisted state (bundle update
 * preferences today) — so path *and* state resolution are both behind one
 * injectable seam instead of being resolved inline against
 * `vscode.ExtensionContext`. Repository-level install records live at the
 * git root and are not storage paths; the extension's own per-profile
 * bundle-record folders are declared by the extension
 * (`ExtensionStoragePaths`), not here (ADR-0011).
 *
 * Two implementations: the VS Code extension's own adapter, backed by
 * `context.globalStorageUri`/`context.globalState` (kept exactly as-is
 * for existing users — see ADR-0005 decision 3); and `infra`'s
 * `XdgAppStorage`, an XDG Base Directory-compliant default for the CLI
 * and any other non-VS-Code client (ADR-0005 decision 2).
 * @module ports/app-storage
 */

/**
 * The fixed set of paths shared by every client.
 */
export interface AppStoragePaths {
  /** Root directory this app's data lives under. */
  root: string;
  /** Path to the registry config file (sources, profiles, settings). */
  config: string;
  /** Root of the cache subtree. */
  cache: string;
  /** Cached per-source bundle listings. */
  sourcesCache: string;
  /** Cached per-bundle metadata. */
  bundlesCache: string;
  /** Profile definitions. */
  profiles: string;
  /** Log output. */
  logs: string;
  /** The one user-level install record per machine, shared by the CLI and every VS Code profile. */
  userRecord: string;
}

/**
 * Universal storage-root port for the registry/bookkeeping layer.
 */
export interface AppStorage {
  /** Resolve the fixed set of directory/file paths this app uses. */
  getPaths(): AppStoragePaths;
  /**
   * Read a small piece of persisted state (e.g. bundle update
   * preferences). Returns `defaultValue` if `key` has never been set.
   * @param key - State key.
   * @param defaultValue - Value to return when `key` is unset.
   */
  getState<T>(key: string, defaultValue: T): Promise<T>;
  /**
   * Persist a small piece of state under `key`.
   * @param key - State key.
   * @param value - Value to persist.
   */
  setState<T>(key: string, value: T): Promise<void>;
}
