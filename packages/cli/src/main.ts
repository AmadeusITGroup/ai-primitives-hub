#!/usr/bin/env node
/**
 * CLI entry point for the prompt-registry CLI.
 * This file is the main entry point for the SEA binary.
 */
import {
  createProductionContext,
} from './framework/production-context';
import {
  runCli,
} from './framework/cli';
import {
  defaultTokenProvider,
  NodeHttpClient,
} from '@prompt-registry/infra';
import {
  InstallCommand,
} from './commands/install';
import {
  UninstallCommand,
} from './commands/uninstall';
import {
  UpdateCommand,
} from './commands/update';
import {
  StatusCommand,
} from './commands/status';
import {
  ProfileListCommand,
  ProfileActivateCommand,
  ProfileDeactivateCommand,
  ProfileShowCommand,
  ProfileCreateCommand,
  ProfilePublishCommand,
} from './commands/profile';
import {
  HubCreateCommand,
  HubAddCommand,
  HubListCommand,
  HubUseCommand,
  HubRemoveCommand,
  HubSyncCommand,
  HubRefreshCommand,
} from './commands/hub';
import {
  SourceAddCommand,
  SourceListCommand,
  SourceRemoveCommand,
} from './commands/source';
import {
  createApplyCommand,
} from './commands/apply';
import {
  InitCommand,
} from './commands/init';
import {
  createDoctorCommand,
  createDoctorCommandClass,
  DoctorCommand,
  DOCTOR_DIAGNOSTICS_COMMAND_CLASS,
} from './commands/doctor';
import {
  createDiscoverCommand,
} from './commands/discover';
import {
  CollectionListCommand,
  createCollectionListCommandClass,
} from './commands/collection-list';
import {
  CollectionValidateCommand,
  createCollectionValidateCommandClass,
} from './commands/collection-validate';
import {
  CollectionAffectedCommand,
  createCollectionAffectedCommandClass,
} from './commands/collection-affected';
import {
  CollectionCreateCommand,
  createCollectionCreateCommandClass,
} from './commands/collection-create';
import {
  PromptCreateCommand,
  createPromptCreateCommandClass,
} from './commands/prompt-create';
import {
  InstructionCreateCommand,
  createInstructionCreateCommandClass,
} from './commands/instruction-create';
import {
  AgentCreateCommand,
  createAgentCreateCommandClass,
} from './commands/agent-create';
import {
  SkillCreateCommand,
  createSkillCreateCommandClass,
} from './commands/skill-create';
import {
  PluginCreateCommand,
  createPluginCreateCommandClass,
} from './commands/plugin-create';
import {
  HookCreateCommand,
  createHookCreateCommandClass,
} from './commands/hook-create';
import {
  createSkillValidateCommand,
  createSkillValidateCommandClass,
  SkillValidateCommand,
} from './commands/skill-validate';
import {
  IndexSearchCommand,
} from './commands/index-search';
import {
  IndexShortlistNewCommand,
  IndexShortlistAddCommand,
  IndexShortlistRemoveCommand,
  IndexShortlistListCommand,
} from './commands/index-shortlist';
import {
  IndexHarvestCommand,
} from './commands/index-harvest';
import {
  IndexStatsCommand,
} from './commands/index-stats';
import {
  IndexReportCommand,
} from './commands/index-report';
import {
  TargetTypesCommand,
} from './commands/target-types';
import {
  createConfigListCommand,
} from './commands/config-list';
import {
  createPluginsListCommand,
  createPluginsListCommandClass,
  PluginsListCommand,
} from './commands/plugins-list';
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
  IndexBuildCommand,
} from './commands/index-build';
import {
  IndexExportCommand,
} from './commands/index-export';
import {
  ExplainCommand,
} from './commands/explain';
import {
  ConfigGetCommand,
} from './commands/config-get';
import {
  SkillNewCommand,
} from './commands/skill-new';
import {
  BundleBuildCommand,
} from './commands/bundle-build';
import {
  BundleManifestCommand,
} from './commands/bundle-manifest';
import {
  VersionComputeCommand,
} from './commands/version-compute';
import {
  IndexEvalCommand,
} from './commands/index-eval';
import {
  IndexBenchCommand,
} from './commands/index-bench';
import {
  CompletionCommand,
} from './commands/completion';

/**
 * Main entry point.
 */
async function main(): Promise<number> {
  const ctx = createProductionContext();
  const http = new NodeHttpClient({ env: ctx.env });
  const tokens = defaultTokenProvider(ctx.env);

  const commands = [
    createApplyCommand(),
    createDiscoverCommand(),
    createConfigListCommand(),
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
    DOCTOR_DIAGNOSTICS_COMMAND_CLASS,
    createPluginsListCommandClass(ctx),
    createSkillValidateCommandClass(ctx),
    CompletionCommand,
  ];

  const exitCode = await runCli(process.argv.slice(2), {
    ctx,
    commands,
    commandClasses,
    name: 'prompt-registry',
    version: '1.0.0',
    http,
    tokens,
    defaultOutput: 'text',
  });

  return exitCode;
}

// Export for use by index.ts and bin/prompt-registry.js
export { main };
