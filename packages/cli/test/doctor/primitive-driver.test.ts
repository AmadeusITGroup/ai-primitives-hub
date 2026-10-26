/**
 * In-process PrimitiveDiagnosticsDriver adapter.
 *
 * Pins how the driver reads the two failure shapes of `collection validate`,
 * how it reports an unparseable command output, and that a prepared
 * sandbox is fully contained in its case root.
 */
import {
  spawnSync,
} from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  checkSandboxContainment,
  type DiagnosticSandbox,
} from '@ai-primitives-hub/core';
import {
  NodeFileSystem,
} from '@ai-primitives-hub/infra';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  getPrimitiveDiagnosticCommandClasses,
} from '../../src/doctor/diagnostics';
import {
  createInProcessPrimitiveDriver,
  parseRejectedPaths,
} from '../../src/doctor/primitive-driver';
import {
  Command,
  type Context,
  createTestContext,
  Option,
} from '../../src/framework';

const BAD_COLLECTION = `id: bad
name: Bad
description: References a missing file.
version: 1.0.0
items:
  - path: prompts/missing.prompt.md
    kind: prompt
`;

/** A `collection validate` stand-in whose stdout is not an envelope. */
class GarbledValidateCommand extends Command {
  public static readonly paths = [['collection', 'validate']];
  public commandContext!: { ctx: Context };
  public output = Option.String('-o,--output');
  public collectionFile = Option.Array('--collection-file');

  public execute(): Promise<number> {
    this.commandContext.ctx.stdout.write('not an envelope\n');
    this.commandContext.ctx.stderr.write('x'.repeat(600));
    return Promise.resolve(2);
  }
}

describe('createInProcessPrimitiveDriver', () => {
  let root: string;
  let sandbox: DiagnosticSandbox;
  const ctx = (): Context => createTestContext({
    fs: new NodeFileSystem(),
    env: { PATH: process.env.PATH ?? '', AI_PRIMITIVES_HUB_SKIP_NETWORK: '1' }
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'cli-primitive-driver-'));
    sandbox = { root, cwd: path.join(root, 'ws'), home: path.join(root, 'home') };
    await mkdir(sandbox.cwd, { recursive: true });
    await mkdir(sandbox.home, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reports validate file failures through data.errors, without an error code', async () => {
    await mkdir(path.join(sandbox.cwd, 'collections'), { recursive: true });
    await writeFile(path.join(sandbox.cwd, 'collections', 'bad.collection.yml'), BAD_COLLECTION);
    const driver = createInProcessPrimitiveDriver({ ctx: ctx(), commandClasses: getPrimitiveDiagnosticCommandClasses() });

    const result = await driver.validateCollection(sandbox, { collectionFile: 'collections/bad.collection.yml' });

    expect(result.exitCode).toBe(1);
    expect(result.status).toBe('error');
    expect(result.errorCode).toBeUndefined();
    expect(result.errorMessages.some((message) => message.includes('referenced file not found'))).toBe(true);
  }, 60_000);

  it('reports a missing collections/ directory through the envelope errors', async () => {
    const driver = createInProcessPrimitiveDriver({ ctx: ctx(), commandClasses: getPrimitiveDiagnosticCommandClasses() });

    const result = await driver.validateCollection(sandbox, { collectionFile: 'collections/bad.collection.yml' });

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe('FS.NOT_FOUND');
    expect(result.errorMessages).toHaveLength(1);
  }, 60_000);

  it('reports unparseable stdout as the first 500 characters of stderr', async () => {
    const driver = createInProcessPrimitiveDriver({ ctx: ctx(), commandClasses: [GarbledValidateCommand] });

    const result = await driver.validateCollection(sandbox, { collectionFile: 'collections/bad.collection.yml' });

    expect(result).toEqual({ exitCode: 2, warnings: [], errorMessages: ['x'.repeat(500)] });
  }, 60_000);

  it('commits the listed fixture files as executable (100755) and every other file as 100644', async () => {
    await mkdir(path.join(sandbox.cwd, 'scripts'), { recursive: true });
    await writeFile(path.join(sandbox.cwd, 'scripts', 'run.sh'), '#!/bin/sh\n');
    await writeFile(path.join(sandbox.cwd, 'README.md'), '# fixture\n');
    const driver = createInProcessPrimitiveDriver({ ctx: ctx(), commandClasses: getPrimitiveDiagnosticCommandClasses() });
    await driver.prepareSandbox(sandbox);

    await driver.commitFixtureRepository(sandbox, { remoteUrl: 'https://github.com/example/fixture.git', executableFiles: ['scripts/run.sh'] });

    const listed = spawnSync('git', ['ls-tree', '-r', 'HEAD'], { cwd: sandbox.cwd, encoding: 'utf8' });
    const modes = Object.fromEntries(listed.stdout.trim().split('\n').map((line) => {
      const [meta, file] = line.split('\t');
      return [file, meta.split(' ')[0]];
    }));
    expect(modes).toEqual({ 'README.md': '100644', 'scripts/run.sh': '100755' });
  }, 60_000);

  it('prepares a contained sandbox with roots in port order', async () => {
    const driver = createInProcessPrimitiveDriver({ ctx: ctx(), commandClasses: getPrimitiveDiagnosticCommandClasses() });

    const prepared = await driver.prepareSandbox(sandbox);

    expect(prepared.roots.map((r) => r.label)).toEqual([
      '$XDG_CONFIG_HOME',
      '$XDG_CACHE_HOME',
      '$XDG_DATA_HOME',
      '$XDG_STATE_HOME',
      '$XDG_RUNTIME_DIR',
      '$TMPDIR',
      '$HOME',
      '<workspace>',
      '<case>'
    ]);
    expect(prepared.roots.at(-3)?.path).toBe(sandbox.home);
    expect(prepared.roots.at(-2)?.path).toBe(sandbox.cwd);
    expect(prepared.roots.at(-1)?.path).toBe(sandbox.root);
    expect(checkSandboxContainment(prepared)).toEqual([]);
    expect(Object.keys(prepared.userDirs)).toEqual(expect.arrayContaining([
      'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
      'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR', 'TEMP', 'TMP', 'userConfigRoot'
    ]));
    for (const envRoot of prepared.roots.slice(0, 6)) {
      expect((await stat(envRoot.path)).isDirectory(), envRoot.label).toBe(true);
    }
  }, 60_000);
});

describe('parseRejectedPaths', () => {
  it('reads the paths listed by an unsupported-content rejection', () => {
    expect(parseRejectedPaths('install: target cannot install bundle content: hooks/pre-commit.hook.json, plugins/p/plugin.json'))
      .toEqual(['hooks/pre-commit.hook.json', 'plugins/p/plugin.json']);
  });

  it('is undefined for a message that lists no paths', () => {
    expect(parseRejectedPaths('install: something else failed')).toBeUndefined();
    expect(parseRejectedPaths('install: target cannot install bundle content: ')).toBeUndefined();
  });
});
