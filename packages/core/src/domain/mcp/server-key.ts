/**
 * Names under which a bundle's MCP servers are written into a host's MCP config.
 *
 * The key is `ai-primitives-hub:<owner>:<repo>:<collection id>:<server name>`:
 * the repository that publishes the collection, the manifest (collection) id
 * and the server name. It deliberately leaves out the version: hosts remember
 * settings per server name (trust, enabled tools, `tools:` references in agent
 * files), so the key must stay the same across bundle updates. The repository
 * makes it globally unique, because collection ids are only unique within one
 * repository. Older installs used `prompt-registry:<bundle id>:<server name>`;
 * those entries keep their name until the bundle is next uninstalled or updated.
 *
 * The key never depends on what else is installed. Two installs of the same
 * collection from the same repository into one scope produce the same key; the
 * caller's conflict handling rejects the second rather than giving it another
 * name, because a name chosen by install order would change again later.
 *
 * Pure: no IO, no side effects, no framework imports.
 * @module domain/mcp/server-key
 */
import {
  parseGitHubOwnerRepo,
} from '../hub/validate';

/**
 * Inputs to {@link resolveMcpServerKey}.
 */
export interface McpServerKeyRequest {
  /** Full bundle id, as recorded in the MCP tracking metadata. */
  readonly bundleId: string;
  /** Manifest (collection) id; falls back to `bundleId` when absent. */
  readonly manifestId?: string;
  /** Server name from the bundle manifest. */
  readonly serverName: string;
  /**
   * The deployment manifest's `repository` field, written by the collection
   * build. Preferred, because it is the same whichever way the release is
   * installed (hub, GitHub source, mirror, Artifactory).
   */
  readonly manifestRepository?: string;
  /**
   * Repository of the source the bundle was installed from (the bundle's
   * `repository`). Used when the manifest has no usable `repository`.
   */
  readonly sourceRepository?: string;
}

/**
 * Build the key for one MCP server of a bundle.
 *
 * The repository is taken from `manifestRepository`, else `sourceRepository`,
 * parsed by `parseGitHubOwnerRepo`; a value it rejects (empty, a local path,
 * another git host) is skipped. With no usable repository the key is
 * `ai-primitives-hub:<collection id>:<server name>`, which is unique only
 * within that repository.
 * @param request - Bundle, server and the repositories it may come from.
 * @returns The key to write the server under.
 */
export function resolveMcpServerKey(request: McpServerKeyRequest): string {
  const repository = parseGitHubOwnerRepo(request.manifestRepository ?? '')
    ?? parseGitHubOwnerRepo(request.sourceRepository ?? '');
  // Lowercased: GitHub owners and repositories are case-insensitive.
  const repositorySegments = repository === null ? [] : [repository.owner.toLowerCase(), repository.repo.toLowerCase()];
  const segments = [...repositorySegments, request.manifestId || request.bundleId, request.serverName];
  return `ai-primitives-hub:${segments.join(':')}`;
}
