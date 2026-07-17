/**
 * Public surface of the CLI framework.
 *
 * This barrel is the *only* import path command code (and tests) should use
 * to reach the framework. Only `packages/cli/src/framework/` may import
 * clipanion directly; a future ESLint rule enforces that (see this
 * package's port of the reference's `local/no-framework-imports`).
 * @module framework
 */
export type {
  CapturedOutputStream,
  ClockAbstraction,
  Context,
  FsAbstraction,
  InputStream,
  NetAbstraction,
  NetRequestInit,
  NetResponse,
  OutputStream,
  TestClock,
} from './context';
export type {
  TestContext,
  TestContextOptions,
} from './test-context';
export {
  createTestContext,
  isTestContext,
} from './test-context';
export {
  createProductionContext,
} from './production-context';
export type {
  CommandDefinition,
  RunCliOptions,
} from './cli';
export type {
  CommandClass,
} from 'clipanion';
export {
  defineCommand,
  runCli,
} from './cli';
export {
  Command,
  Option,
} from 'clipanion';
export type {
  Config,
  ConfigFs,
  LoadConfigOptions,
} from './config';
export {
  loadConfig,
  resolveProjectConfigPath,
} from './config';
export type {
  FormatOutputOptions,
  OutputError,
  OutputFormat,
  OutputStatus,
} from './output';
export {
  formatOutput,
} from './output';
export type {
  RegistryErrorNamespace,
  RegistryErrorOptions,
} from './error';
export {
  RegistryError,
  isRegistryError,
  renderError,
  failWith,
  generateTargetHint,
  readTargetsSafely,
  throwTargetNotFoundError,
  resolveTargetName,
  resolveTarget,
  validateInputs,
  getCommandContext,
  requireActiveHub,
  requireActiveHubOrFail,
} from './error';
export type {
  RunCommandOptions,
  RunCommandResult,
} from './golden';
export {
  runCommand,
} from './golden';
export type {
  CreateHubManagerOptions,
} from './hub-manager';
export {
  createHubManager,
  createHttpClientAndTokens,
} from './hub-manager';
export {
  findProjectLockfile,
  loadTargets,
  lockfilePathForTarget,
} from './target';
export {
  copyCommandPrototype,
} from './command-class';
export type {
  RenderTableOptions,
  TableColumn,
} from './table';
export {
  renderTable,
} from './table';
export {
  parseCsv,
  parseCsvEnum,
  parseCsvKinds,
  parseCsvNonEmpty,
} from './parsers';
export {
  renderGlobalHelp,
} from './help-renderer';
export {
  suggestCommand,
} from './suggest';
