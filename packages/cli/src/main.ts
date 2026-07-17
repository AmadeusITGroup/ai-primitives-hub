#!/usr/bin/env node
/**
 * CLI entry point for the ai-primitives-hub CLI.
 * @module main
 */
import {
  defaultTokenProvider,
  NodeHttpClient,
} from '@ai-primitives-hub/infra';
import {
  AgentCreateCommand,
} from './commands/agent-create';
import {
  ApplyCommand,
} from './commands/apply';
import {
  BundleBuildCommand,
} from './commands/bundle-build';
import {
  BundleManifestCommand,
} from './commands/bundle-manifest';
import {
  CollectionAffectedCommand,
} from './commands/collection-affected';
import {
  CollectionCreateCommand,
} from './commands/collection-create';
import {
  CollectionListCommand,
} from './commands/collection-list';
import {
  CollectionValidateCommand,
} from './commands/collection-validate';
import {
  CompletionCommand,
} from './commands/completion';
import {
  ConfigGetCommand,
} from './commands/config-get';
import {
  ConfigListCommand,
} from './commands/config-list';
import {
  DiscoverCommand,
} from './commands/discover';
import {
  DoctorCommand,
  DoctorDiagnosticsCommand,
} from './commands/doctor';
import {
  ExplainCommand,
} from './commands/explain';
import {
  HookCreateCommand,
} from './commands/hook-create';
import {
  HubAddCommand,
  HubCreateCommand,
  HubListCommand,
  HubRefreshCommand,
  HubRemoveCommand,
  HubSyncCommand,
  HubUseCommand,
} from './commands/hub';
import {
  IndexBenchCommand,
} from './commands/index-bench';
import {
  IndexBuildCommand,
} from './commands/index-build';
import {
  IndexEvalCommand,
} from './commands/index-eval';
import {
  IndexExportCommand,
} from './commands/index-export';
import {
  IndexHarvestCommand,
} from './commands/index-harvest';
import {
  IndexReportCommand,
} from './commands/index-report';
import {
  IndexSearchCommand,
} from './commands/index-search';
import {
  IndexShortlistAddCommand,
  IndexShortlistListCommand,
  IndexShortlistNewCommand,
  IndexShortlistRemoveCommand,
} from './commands/index-shortlist';
import {
  IndexStatsCommand,
} from './commands/index-stats';
import {
  InitCommand,
} from './commands/init';
import {
  InstallCommand,
} from './commands/install';
import {
  InstructionCreateCommand,
} from './commands/instruction-create';
import {
  PluginCreateCommand,
} from './commands/plugin-create';
import {
  PluginsListCommand,
} from './commands/plugins-list';
import {
  ProfileActivateCommand,
  ProfileCreateCommand,
  ProfileCurrentCommand,
  ProfileDeactivateCommand,
  ProfileEditCommand,
  ProfileListCommand,
  ProfilePublishCommand,
  ProfileShowCommand,
} from './commands/profile';
import {
  PromptCreateCommand,
} from './commands/prompt-create';
import {
  SkillCreateCommand,
} from './commands/skill-create';
import {
  SkillNewCommand,
} from './commands/skill-new';
import {
  SkillValidateCommand,
} from './commands/skill-validate';
import {
  SourceAddCommand,
  SourceListCommand,
  SourceRemoveCommand,
} from './commands/source';
import {
  StatusCommand,
} from './commands/status';
import {
  TargetAddCommand,
} from './commands/target-add';
import {
  TargetListCommand,
} from './commands/target-list';
import {
  TargetRemoveCommand,
} from './commands/target-remove';
import {
  TargetTypesCommand,
} from './commands/target-types';
import {
  UninstallCommand,
} from './commands/uninstall';
import {
  UpdateCommand,
} from './commands/update';
import {
  VersionComputeCommand,
} from './commands/version-compute';
import {
  createProductionContext,
  runCli,
} from './framework';

/**
 * Main entry point.
 * @returns Process exit code.
 */
async function main(): Promise<number> {
  const ctx = createProductionContext();
  const http = new NodeHttpClient();
  const tokens = defaultTokenProvider(ctx.env);

  const commandClasses = [
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

  const exitCode = await runCli(process.argv.slice(2), {
    ctx,
    commands: [],
    commandClasses,
    name: 'ai-primitives-hub',
    version: '1.0.0',
    http,
    tokens,
    defaultOutput: 'text'
  });

  return exitCode;
}

// Export for use by index.ts and bin/ai-primitives-hub.js
export { main };
