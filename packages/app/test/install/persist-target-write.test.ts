import type {
  Target,
  TargetWriteResult,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  persistTargetWrite,
} from '../../src/install/persist-target-write';
import type {
  TargetWriter,
} from '../../src/writers/file-tree-writer';

const target: Target = { name: 'vscode', type: 'vscode', scope: 'user', path: '/user' };
const result: TargetWriteResult = {
  written: ['/user/knowledge/guide.md'],
  skipped: [],
  writtenBundlePaths: ['knowledge/guide.md']
};

describe('persistTargetWrite', () => {
  it('rolls back written files when tracking persistence fails and preserves the failure', async () => {
    const rollback = vi.fn(async () => {});
    const writer: TargetWriter = { write: async () => result, remove: async () => {}, rollback };
    const failure = new Error('lockfile write failed');

    await expect(persistTargetWrite(writer, target, result, async () => {
      throw failure;
    })).rejects.toBe(failure);

    expect(rollback).toHaveBeenCalledWith(target, result.written);
  });

  it('surfaces the tracking and rollback failures together', async () => {
    const rollbackFailure = new Error('rollback failed');
    const writer: TargetWriter = {
      write: async () => result,
      remove: async () => {},
      rollback: async () => {
        throw rollbackFailure;
      }
    };
    const trackingFailure = new Error('lockfile write failed');

    let thrown: unknown;
    try {
      await persistTargetWrite(writer, target, result, async () => {
        throw trackingFailure;
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([trackingFailure, rollbackFailure]);
  });
});
