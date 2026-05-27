/**
 * Install use cases — barrel export.
 * @module app/install
 */
export {
  installBundle,
} from './install-bundle';

export type {
  InstallBundleInput,
  InstallBundleOptions,
} from './install-bundle';

export {
  planUninstall,
  uninstallBundle,
} from './uninstall-bundle';

export type {
  UninstallBundleInput,
  UninstallBundleOptions,
} from './uninstall-bundle';
