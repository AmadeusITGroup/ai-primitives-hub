/**
 * App layer: Registry management use cases.
 *
 * Orchestrates hub management, profile activation, and user config path resolution.
 */
export type { UserConfigPaths } from './user-config-paths';
export { resolveUserConfigPaths } from './user-config-paths';

export type { HubInfo } from './hub-manager';
export { HubManager } from './hub-manager';

export type { ActivationInput, ActivationOutcome, ProfileActivatorDeps } from './profile-activator';
export { ProfileActivator } from './profile-activator';
