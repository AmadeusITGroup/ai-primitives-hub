/**
 * Drift guard for core's bookkeeping literals (`isBookkeepingLabel`).
 *
 * Core cannot import app or infra, so it names APH's own state files as
 * literals. This test labels the real constants and resolvers for a
 * driver-like sandbox env: if a store moves, fix the core literals, not
 * this test.
 */
import * as path from 'node:path';
import {
  isBookkeepingLabel,
  labelSandboxPath,
} from '@ai-primitives-hub/core';
import {
  findProjectConfigPath,
  XdgAppStorage,
} from '@ai-primitives-hub/infra';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  LOCAL_LOCKFILE_NAME,
  LOCKFILE_NAME,
  resolveUserConfigPaths,
} from '../../src';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';
import {
  sandboxEnv,
  sandboxRoots,
} from './fake-primitive-driver';

const CASE_ROOT = '/run/cases/aph-e2e-only-prompt__vscode__user';
const SANDBOX = { root: CASE_ROOT, cwd: path.join(CASE_ROOT, 'ws'), home: path.join(CASE_ROOT, 'home') };
const ROOTS = sandboxRoots(SANDBOX);
const ENV = sandboxEnv(SANDBOX.home);

const label = (absolute: string): string | undefined => labelSandboxPath(ROOTS, absolute);

describe('bookkeeping names drift guard', () => {
  it.each(Object.entries(new XdgAppStorage(ENV).getPaths()))('labels XdgAppStorage %s as bookkeeping', (_key, value) => {
    const labelled = label(value);
    expect(labelled).toBeDefined();
    expect(isBookkeepingLabel(labelled!)).toBe(true);
  });

  it.each(Object.entries(resolveUserConfigPaths(ENV)))('labels user config path %s as bookkeeping', (_key, value) => {
    const labelled = label(value);
    expect(labelled).toBeDefined();
    expect(isBookkeepingLabel(labelled!)).toBe(true);
  });

  it.each([LOCKFILE_NAME, LOCAL_LOCKFILE_NAME])('labels the workspace lockfile %s as bookkeeping', (name) => {
    expect(label(path.join(SANDBOX.cwd, name))).toBe(`<workspace>/${name}`);
    expect(isBookkeepingLabel(`<workspace>/${name}`)).toBe(true);
  });

  it('labels the project config file target add writes as bookkeeping', async () => {
    const { file, exists } = await findProjectConfigPath({ cwd: SANDBOX.cwd, fs: new InMemoryFileSystem() });

    expect(exists).toBe(false);
    expect(label(file)).toBe('<workspace>/ai-primitives-hub.yml');
    expect(isBookkeepingLabel(label(file)!)).toBe(true);
  });
});
