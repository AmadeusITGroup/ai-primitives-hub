/**
 * Resolve the `--source` value of `install <bundle-id> --source <value>`
 * to a configured hub source.
 *
 * `--source` names a hub id in list/interactive mode, but a remote install
 * historically treated it only as a GitHub `owner/repo` slug. This use case
 * lets the remote path accept the same names the rest of the CLI prints:
 * a source id (or name) in the active hub first, then a hub id (whose
 * profiles say which source carries the bundle). The caller falls back to
 * the `owner/repo` interpretation when nothing matches.
 * @module registry/resolve-install-source
 */
import {
  type HubConfig,
  RegistryError,
  type RegistrySource,
} from '@ai-primitives-hub/core';
import {
  parseGitHubRepositoryTarget,
} from '@ai-primitives-hub/infra';

/**
 * Hub read access needed by {@link resolveInstallSource}; satisfied by
 * `HubManager`.
 */
export interface InstallSourceHubs {
  getActiveHubId(): Promise<string | null>;
  /** Whether the hub's config is on disk (malformed or not). */
  hasHub(hubId: string): Promise<boolean>;
  getHub(hubId: string): Promise<{ id: string; config: HubConfig } | null>;
  listSources(hubId?: string): Promise<RegistrySource[]>;
}

/** A hub that exists on disk but whose configuration could not be loaded. */
interface HubLoadFailure {
  hubId: string;
  cause: unknown;
}

const matchesSource = (source: RegistrySource, value: string): boolean =>
  source.id === value || source.name === value;

/**
 * List a hub's sources. A hub that is not on disk has none; a hub that
 * is on disk but fails to load is recorded in `failures` so the caller
 * can report it instead of a bare "not found".
 * @param hubs Hub read access.
 * @param hubId Hub to read.
 * @param failures Load failures collected so far.
 * @returns The sources, or null when the hub is missing or unreadable.
 */
const loadHubSources = async (
  hubs: InstallSourceHubs,
  hubId: string,
  failures: HubLoadFailure[]
): Promise<RegistrySource[] | null> => {
  if (!(await hubs.hasHub(hubId))) {
    return null;
  }
  try {
    return await hubs.listSources(hubId);
  } catch (cause) {
    failures.push({ hubId, cause });
    return null;
  }
};

/**
 * Look `value` up as a source id/name in the active hub.
 * @param hubs Hub read access.
 * @param value `--source` value.
 * @param failures Load failures collected so far.
 * @returns Matching source, or null.
 */
const findActiveHubSource = async (
  hubs: InstallSourceHubs,
  value: string,
  failures: HubLoadFailure[]
): Promise<RegistrySource | null> => {
  const activeHubId = await hubs.getActiveHubId();
  if (activeHubId === null) {
    return null;
  }
  const sources = await loadHubSources(hubs, activeHubId, failures);
  return sources?.find((source) => matchesSource(source, value)) ?? null;
};

/**
 * Look `value` up as a hub id; pick the source its profiles name for
 * `bundleId`, or its only source when no profile names the bundle.
 * @param hubs Hub read access.
 * @param value `--source` value.
 * @param bundleId Bundle id being installed.
 * @param failures Load failures collected so far.
 * @returns Matching source, or null.
 */
const findHubSource = async (
  hubs: InstallSourceHubs,
  value: string,
  bundleId: string,
  failures: HubLoadFailure[]
): Promise<RegistrySource | null> => {
  const sources = await loadHubSources(hubs, value, failures);
  const hub = sources === null ? null : await hubs.getHub(value);
  if (sources === null || hub === null) {
    return null;
  }
  const profileBundle = hub.config.profiles
    .flatMap((profile) => profile.bundles)
    .find((bundle) => bundle.id === bundleId);
  if (profileBundle !== undefined) {
    return sources.find((source) => matchesSource(source, profileBundle.source)) ?? null;
  }
  return sources.length === 1 ? sources[0] : null;
};

/**
 * Resolve an install `--source` value to a hub source: first as a source
 * id (or name) in the active hub, then as a hub id.
 * @param hubs Hub read access (e.g. `HubManager`).
 * @param value `--source` value from the command line.
 * @param bundleId Bundle id being installed (used for the hub-id lookup).
 * @returns The resolved source, or null when neither lookup matches.
 * @throws {RegistryError} `HUB.LOAD_FAILED` when nothing matched and the
 * active hub (or the hub named by `value`) exists but its configuration
 * could not be loaded — the match may be hiding in it.
 */
export async function resolveInstallSource(
  hubs: InstallSourceHubs,
  value: string,
  bundleId: string
): Promise<RegistrySource | null> {
  const failures: HubLoadFailure[] = [];
  const match = await findActiveHubSource(hubs, value, failures)
    ?? await findHubSource(hubs, value, bundleId, failures);
  if (match !== null || failures.length === 0) {
    return match;
  }
  const { hubId, cause } = failures[0];
  throw new RegistryError({
    code: 'HUB.LOAD_FAILED',
    message: `hub "${hubId}" configuration could not be loaded while resolving --source "${value}": ${cause instanceof Error ? cause.message : String(cause)}`,
    hint: `Fix the hub configuration, or re-import it with \`ai-primitives-hub hub sync ${hubId}\`.`,
    cause,
    context: { hubId, source: value }
  });
}

/**
 * The `owner/repo` slug of a GitHub source, used to match hub bundle ids
 * of the form `{owner}-{repo}-{name}` against the bundle's manifest.
 * @param source Registry source or lockfile source entry (`type` + `url`).
 * @param source.type
 * @param source.url
 * @returns The slug, or undefined for non-GitHub or unparsable sources.
 */
export function githubRepoSlugForSource(source: { type: string; url: string }): string | undefined {
  if (source.type !== 'github') {
    return undefined;
  }
  try {
    const target = parseGitHubRepositoryTarget(source.url);
    return `${target.owner}/${target.repository}`;
  } catch {
    return undefined;
  }
}
