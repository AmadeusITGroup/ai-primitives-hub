/**
 * Install use cases — barrel export.
 * @module install
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

export {
  InstallPipeline,
  InstallPipelineError,
} from './pipeline';

export type {
  InstallOutcome,
  InstallPipelineOptions,
  PipelineEvent,
} from './pipeline';

export {
  UninstallPipeline,
} from './uninstall-pipeline';

export type {
  UninstallPipelineOptions,
  UninstallPlan,
  UninstallResult,
} from './uninstall-pipeline';

export type {
  McpConfigScope,
} from './layout-resolver';

export {
  resolveLayoutFromLayers,
  resolveMcpLayoutConfig,
  WORKSPACE_ROOT_TOKEN,
} from './layout-resolver';
