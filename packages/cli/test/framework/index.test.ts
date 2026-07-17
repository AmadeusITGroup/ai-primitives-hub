/**
 * Tests for the public `framework` barrel.
 *
 * The barrel is the only import path command code should use. This test
 * guards against accidental loss of exported framework helpers.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  Command,
  copyCommandPrototype,
  createHubManager,
  createProductionContext,
  createTestContext,
  defineCommand,
  failWith,
  findProjectLockfile,
  formatOutput,
  generateTargetHint,
  getCommandContext,
  isTestContext,
  loadConfig,
  loadTargets,
  lockfilePathForTarget,
  Option,
  parseCsv,
  parseCsvEnum,
  parseCsvKinds,
  parseCsvNonEmpty,
  RegistryError,
  renderError,
  renderGlobalHelp,
  renderTable,
  requireActiveHub,
  requireActiveHubOrFail,
  resolveProjectConfigPath,
  resolveTarget,
  resolveTargetName,
  runCli,
  runCommand as runCommandAlias,
  suggestCommand,
  throwTargetNotFoundError,
  validateInputs,
} from '../../src/framework';

describe('framework barrel', () => {
  it('exports the core types and factories', () => {
    expect(typeof createTestContext).toBe('function');
    expect(typeof createProductionContext).toBe('function');
    expect(typeof isTestContext).toBe('function');
    expect(typeof runCli).toBe('function');
    expect(typeof defineCommand).toBe('function');
    expect(typeof runCommandAlias).toBe('function');
    expect(typeof loadConfig).toBe('function');
    expect(typeof resolveProjectConfigPath).toBe('function');
    expect(typeof formatOutput).toBe('function');
    expect(typeof RegistryError).toBe('function');
    expect(typeof renderError).toBe('function');
    expect(typeof failWith).toBe('function');
    expect(typeof generateTargetHint).toBe('function');
    expect(typeof resolveTargetName).toBe('function');
    expect(typeof resolveTarget).toBe('function');
    expect(typeof throwTargetNotFoundError).toBe('function');
    expect(typeof validateInputs).toBe('function');
    expect(typeof getCommandContext).toBe('function');
    expect(typeof requireActiveHub).toBe('function');
    expect(typeof requireActiveHubOrFail).toBe('function');
    expect(typeof createHubManager).toBe('function');
    expect(typeof loadTargets).toBe('function');
    expect(typeof findProjectLockfile).toBe('function');
    expect(typeof lockfilePathForTarget).toBe('function');
    expect(typeof copyCommandPrototype).toBe('function');
    expect(typeof renderTable).toBe('function');
    expect(typeof parseCsv).toBe('function');
    expect(typeof parseCsvEnum).toBe('function');
    expect(typeof parseCsvKinds).toBe('function');
    expect(typeof parseCsvNonEmpty).toBe('function');
    expect(typeof renderGlobalHelp).toBe('function');
    expect(typeof suggestCommand).toBe('function');
  });

  it('exports clipanion primitives', () => {
    expect(typeof Command).toBe('function');
    expect(typeof Option).toBe('object');
    expect(typeof Option.String).toBe('function');
  });
});
