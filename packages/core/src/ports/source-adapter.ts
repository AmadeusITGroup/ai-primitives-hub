/**
 * Source adapter port.
 *
 * Mirrors `src/adapters/repository-adapter.ts`'s `IRepositoryAdapter`
 * contract (see `src/adapters/AGENTS.md`) so that concrete adapters in
 * `@ai-primitives-hub/infra` (Phase 3) can be implemented once and shared
 * by both the CLI and, eventually, the extension (migration plan §6.3).
 * @module ports/source-adapter
 */
import type {
  Bundle,
} from '../domain/bundle/types';
import type {
  RegistrySource,
  SourceMetadata,
  ValidationResult,
} from '../domain/source/types';

/**
 * Contract every source adapter (GitHub, Local, Awesome Copilot, APM,
 * Skills, and their local variants) implements.
 */
export interface SourceAdapter {
  readonly type: string;
  readonly source: RegistrySource;

  fetchBundles(): Promise<Bundle[]>;

  /**
   * Download a bundle's archive.
   * Always resolves to a `Buffer` — whether the source provides
   * pre-packaged archives (GitHub) or builds them dynamically
   * (Awesome Copilot, Local).
   */
  downloadBundle(bundle: Bundle): Promise<Buffer>;

  fetchMetadata(): Promise<SourceMetadata>;

  /** Returns validation details for user-facing diagnostics, not just a boolean. */
  validate(): Promise<ValidationResult>;

  requiresAuthentication(): boolean;

  /** URL for UI display/debugging only — not used for the actual download. */
  getManifestUrl(bundleId: string, version?: string): string;

  /** URL for UI display/debugging only — not used for the actual download. */
  getDownloadUrl(bundleId: string, version?: string): string;

  /** Optional: force re-authentication (e.g. after a token expires). */
  forceAuthentication?(): Promise<void>;
}
