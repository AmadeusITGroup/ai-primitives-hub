/**
 * Shared base for concrete `SourceAdapter` implementations.
 *
 * Mirrors `src/adapters/repository-adapter.ts`'s `RepositoryAdapter`
 * abstract class: every adapter needs `source` wired up and a
 * `requiresAuthentication()` default, and (from `GithubAdapter` onward)
 * shares the "does this look like a private source" check. Adapters that
 * genuinely never need auth (e.g. `LocalAdapter`) simply override it.
 * @module adapters/base-source-adapter
 */
import type {
  Bundle,
  RegistrySource,
  SourceAdapter,
  SourceMetadata,
  ValidationResult,
} from '@ai-primitives-hub/core';

export abstract class BaseSourceAdapter implements SourceAdapter {
  public abstract readonly type: string;

  public constructor(public readonly source: RegistrySource) {}

  /** Default: a source is treated as requiring auth iff it's marked private. */
  public requiresAuthentication(): boolean {
    return this.source.private === true;
  }

  public abstract fetchBundles(): Promise<Bundle[]>;
  public abstract downloadBundle(bundle: Bundle): Promise<Buffer>;
  public abstract fetchMetadata(): Promise<SourceMetadata>;
  public abstract validate(): Promise<ValidationResult>;
  public abstract getManifestUrl(bundleId: string, version?: string): string;
  public abstract getDownloadUrl(bundleId: string, version?: string): string;
}
