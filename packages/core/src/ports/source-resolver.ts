/**
 * SourceResolver port — resolves a `BundleSpec` to a downloadable
 * `Installable`. Concrete adapters (GitHub resolver, awesome-copilot
 * resolver, skills resolver, local resolver) live in `infra/resolvers`.
 * @module ports/source-resolver
 */
import type {
  BundleSpec,
  Installable,
} from '../domain/install/installable';

/**
 * Resolves a parsed install specification to a downloadable bundle.
 */
export interface BundleResolver {
  /**
   * Resolve a BundleSpec to an Installable.
   * @param spec Parsed install positional.
   * @returns Resolved Installable, or null when not found.
   */
  resolve(spec: BundleSpec): Promise<Installable | null>;
}
