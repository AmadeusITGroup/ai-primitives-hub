/**
 * Single source of truth for every registered CLI command class.
 *
 * `main.ts` uses this list to register commands with clipanion; the
 * `completion` command's shell-completion generator derives its full
 * command/subcommand tree from the same list (via `getCommandPaths` /
 * `collectCommandPaths`). Adding a native command class here is therefore
 * required to make it runnable and completion-covered — no separate
 * completion list needs to be maintained.
 * @module commands/registry
 */
import type {
  CommandClass,
} from '../framework';
import {
  AgentCreateCommand,
} from './agent-create';
import {
  ApplyCommand,
} from './apply';
import {
  BundleBuildCommand,
} from './bundle-build';
import {
  BundleManifestCommand,
} from './bundle-manifest';
import {
  CollectionAffectedCommand,
} from './collection-affected';
import {
  CollectionCreateCommand,
} from './collection-create';
import {
  CollectionListCommand,
} from './collection-list';
import {
  CollectionValidateCommand,
} from './collection-validate';
import {
  CompletionCommand,
} from './completion';
import {
  ConfigGetCommand,
} from './config-get';
import {
  ConfigListCommand,
} from './config-list';
import {
  DiscoverCommand,
} from './discover';
import {
  DoctorCommand,
  DoctorDiagnosticsCommand,
} from './doctor';
import {
  ExplainCommand,
} from './explain';
import {
  HookCreateCommand,
} from './hook-create';
import {
  HubAddCommand,
  HubCreateCommand,
  HubListCommand,
  HubRefreshCommand,
  HubRemoveCommand,
  HubSyncCommand,
  HubUseCommand,
  HubValidateCommand,
} from './hub';
import {
  IndexBenchCommand,
} from './index-bench';
import {
  IndexBuildCommand,
} from './index-build';
import {
  IndexEvalCommand,
} from './index-eval';
import {
  IndexExportCommand,
} from './index-export';
import {
  IndexHarvestCommand,
} from './index-harvest';
import {
  IndexReportCommand,
} from './index-report';
import {
  IndexSearchCommand,
} from './index-search';
import {
  IndexShortlistAddCommand,
  IndexShortlistListCommand,
  IndexShortlistNewCommand,
  IndexShortlistRemoveCommand,
} from './index-shortlist';
import {
  IndexStatsCommand,
} from './index-stats';
import {
  InitCommand,
} from './init';
import {
  InstallCommand,
} from './install';
import {
  InstructionCreateCommand,
} from './instruction-create';
import {
  PluginCreateCommand,
} from './plugin-create';
import {
  PluginsListCommand,
} from './plugins-list';
import {
  ProfileActivateCommand,
  ProfileCreateCommand,
  ProfileCurrentCommand,
  ProfileDeactivateCommand,
  ProfileEditCommand,
  ProfileListCommand,
  ProfilePublishCommand,
  ProfileShowCommand,
} from './profile';
import {
  PromptCreateCommand,
} from './prompt-create';
import {
  SkillCreateCommand,
} from './skill-create';
import {
  SkillNewCommand,
} from './skill-new';
import {
  SkillValidateCommand,
} from './skill-validate';
import {
  SourceAddCommand,
  SourceListCommand,
  SourceRemoveCommand,
} from './source';
import {
  StatusCommand,
} from './status';
import {
  TargetAddCommand,
} from './target-add';
import {
  TargetListCommand,
} from './target-list';
import {
  TargetRemoveCommand,
} from './target-remove';
import {
  TargetTypesCommand,
} from './target-types';
import {
  UninstallCommand,
} from './uninstall';
import {
  UpdateCommand,
} from './update';
import {
  VersionComputeCommand,
} from './version-compute';

/** Every native clipanion command class registered by the production CLI. */
export const ALL_COMMAND_CLASSES: CommandClass[] = [
  StatusCommand,
  InitCommand,
  InstallCommand,
  UninstallCommand,
  UpdateCommand,
  ProfileListCommand,
  ProfileActivateCommand,
  ProfileDeactivateCommand,
  ProfileShowCommand,
  ProfileCurrentCommand,
  ProfileCreateCommand,
  ProfileEditCommand,
  ProfilePublishCommand,
  HubCreateCommand,
  HubAddCommand,
  HubListCommand,
  HubUseCommand,
  HubRemoveCommand,
  HubSyncCommand,
  HubRefreshCommand,
  HubValidateCommand,
  SourceAddCommand,
  SourceListCommand,
  SourceRemoveCommand,
  TargetAddCommand,
  TargetListCommand,
  TargetRemoveCommand,
  TargetTypesCommand,
  IndexBuildCommand,
  IndexExportCommand,
  IndexSearchCommand,
  IndexShortlistNewCommand,
  IndexShortlistAddCommand,
  IndexShortlistRemoveCommand,
  IndexShortlistListCommand,
  IndexHarvestCommand,
  IndexStatsCommand,
  IndexReportCommand,
  ExplainCommand,
  ConfigGetCommand,
  ConfigListCommand,
  ApplyCommand,
  SkillNewCommand,
  BundleBuildCommand,
  BundleManifestCommand,
  VersionComputeCommand,
  IndexEvalCommand,
  IndexBenchCommand,
  CollectionListCommand,
  CollectionValidateCommand,
  CollectionAffectedCommand,
  CollectionCreateCommand,
  PromptCreateCommand,
  InstructionCreateCommand,
  AgentCreateCommand,
  SkillCreateCommand,
  PluginCreateCommand,
  HookCreateCommand,
  DoctorCommand,
  DoctorDiagnosticsCommand,
  PluginsListCommand,
  SkillValidateCommand,
  CompletionCommand,
  DiscoverCommand
];
