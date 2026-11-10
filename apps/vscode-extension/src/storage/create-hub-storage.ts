/**
 * Composition helper for `HubStorage`: hub data always lives in the shared XDG
 * user-config layout (`resolveUserConfigPaths`) with the canonical
 * `active-hub.json` pointer and a stateless facade, matching the CLI's
 * on-disk contract.
 */

import {
  resolveUserConfigPaths,
} from '@ai-primitives-hub/app';
import {
  HubStorage,
} from './hub-storage';

/**
 * Create the extension's `HubStorage` for the given environment.
 * @param env Environment bag (production callers pass `process.env`).
 * @returns Configured HubStorage facade.
 */
export function createHubStorage(env: Readonly<Record<string, string | undefined>>): HubStorage {
  const paths = resolveUserConfigPaths({ ...env });
  return new HubStorage(paths.hubs, {
    activeHubPath: paths.activeHub,
    cacheMode: 'stateless'
  });
}
