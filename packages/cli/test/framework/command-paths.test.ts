/**
 * Tests for `framework/command-paths.ts`.
 *
 * `collectCommandPaths` derives the full completion candidate list from
 * both native clipanion command classes and declarative `CommandDefinition`s
 * (`opts.commands`); `getCommandPaths` reads that list back out of a
 * command's injected `commandContext`.
 */
import type {
  CommandClass,
} from 'clipanion';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  collectCommandPaths,
  getCommandPaths,
} from '../../src/framework';

const classWithPaths = (paths: string[][]): CommandClass =>
  ({ paths } as unknown as CommandClass);

describe('collectCommandPaths', () => {
  it('flattens paths across multiple command classes', () => {
    const classes = [
      classWithPaths([['index', 'search'], ['search']]),
      classWithPaths([['hub', 'validate']])
    ];

    expect(collectCommandPaths(classes)).toEqual([
      ['hub', 'validate'],
      ['index', 'search'],
      ['search']
    ]);
  });

  it('merges in declarative CommandDefinition paths and deduplicates', () => {
    const classes = [classWithPaths([['status']])];
    const extraPaths = [['status'], ['uninstall']];

    expect(collectCommandPaths(classes, extraPaths)).toEqual([
      ['status'],
      ['uninstall']
    ]);
  });

  it('returns an empty list when no commands are registered', () => {
    expect(collectCommandPaths([])).toEqual([]);
  });
});

describe('getCommandPaths', () => {
  it('reads the command-path list from commandContext', () => {
    const command = { commandContext: { commandPaths: [['a'], ['b', 'c']] } };
    expect(getCommandPaths(command)).toEqual([['a'], ['b', 'c']]);
  });

  it('returns an empty list when commandContext is absent', () => {
    expect(getCommandPaths({})).toEqual([]);
  });
});
