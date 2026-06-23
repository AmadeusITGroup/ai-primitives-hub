#!/usr/bin/env node
/**
 * CLI entry point for the prompt-registry CLI.
 * This file is the main entry point for the SEA binary.
 */
import {
  defaultTokenProvider,
  NodeHttpClient,
} from '@prompt-registry/infra';
import {
  AgentCreateCommand,
} from './commands/agent-create';
import {
  createApplyCommand,
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
  createConfigListCommand,
} from './commands/config-list';
import {
  createDiscoverCommand,
} from './commands/discover';
import {
  createDoctorCommandClass,
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
  createPluginsListCommandClass,
} from './commands/plugins-list';
import {
  ProfileActivateCommand,
  ProfileCreateCommand,
  ProfileDeactivateCommand,
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
  createSkillValidateCommandClass,
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
  runCli,
} from './framework/cli';
import {
  createProductionContext,
} from './framework/production-context';

/**
 * Main entry point.
 */
async function main(): Promise<number> {
  const ctx = createProductionContext();
  const http = new NodeHttpClient();
  const tokens = defaultTokenProvider(ctx.env);

  const commands = [
    createApplyCommand(),
    createDiscoverCommand(),
    createConfigListCommand()
  ];

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
    ProfileCreateCommand,
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
    createDoctorCommandClass(ctx),
    createPluginsListCommandClass(ctx),
    createSkillValidateCommandClass(ctx),
    CompletionCommand
  ];

  const exitCode = await runCli(process.argv.slice(2), {
    ctx,
    commands,
    commandClasses,
    name: 'prompt-registry',
    version: '1.0.0',
    http,
    tokens,
    defaultOutput: 'text'
  });

  return exitCode;
}

// Export for use by index.ts and bin/prompt-registry.js
export { main };
