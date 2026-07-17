/**
 * `source` command tests.
 *
 * Uses a real `NodeFileSystem` against a real temp directory (not
 * `createTestContext`'s default in-memory `fs` stub, which rejects
 * every call) since these commands do real file IO against the
 * default-local hub's user-scope store.
 */
import {
  mkdir,
  mkdtemp,
  rm,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
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
  SourceAddCommand,
  SourceListCommand,
  SourceRemoveCommand,
} from '../../src/commands/source';
import {
  runCommand,
} from '../../src/framework';

const COMMAND_CLASSES = [
  SourceAddCommand,
  SourceListCommand,
  SourceRemoveCommand
];

interface JsonEnvelope<T> {
  status: string;
  data: T;
}

describe('source commands', () => {
  let workspace: string;
  let localDir: string;

  const run = (argv: string[]): ReturnType<typeof runCommand> => runCommand(argv, {
    commandClasses: COMMAND_CLASSES,
    context: {
      cwd: workspace,
      fs: new NodeFileSystem(),
      env: {
        HOME: workspace,
        USERPROFILE: workspace,
        XDG_CONFIG_HOME: path.join(workspace, 'xdg-config'),
        XDG_CACHE_HOME: path.join(workspace, 'xdg-cache')
      }
    }
  });

  const parseJson = <T>(stdout: string): JsonEnvelope<T> => JSON.parse(stdout) as JsonEnvelope<T>;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'cli-source-test-'));
    localDir = path.join(workspace, 'local-skills');
    await mkdir(localDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  describe('source add', () => {
    it('adds a detached source to the default-local hub', async () => {
      const result = await run([
        'source', 'add', '--type', 'local', '--url', localDir, '--id', 'local-skills', '-o', 'json'
      ]);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ source: { id: string; type: string; url: string } }>(result.stdout);
      expect(envelope.data.source).toMatchObject({ id: 'local-skills', type: 'local', url: localDir });

      const listResult = await run(['source', 'list', '-o', 'json']);
      const listEnvelope = parseJson<{ sources: { id: string }[] }>(listResult.stdout);
      expect(listEnvelope.data.sources.map((s) => s.id)).toContain('local-skills');
    });

    it('fails with a non-zero exit code when --url is missing', async () => {
      const result = await run(['source', 'add', '--type', 'local', '-o', 'json']);
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe('source list', () => {
    it('returns an empty list when no sources exist', async () => {
      const result = await run(['source', 'list', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ sources: unknown[] }>(result.stdout);
      expect(envelope.data.sources).toEqual([]);
    });
  });

  describe('source remove', () => {
    it('removes an existing detached source', async () => {
      await run(['source', 'add', '--type', 'local', '--url', localDir, '--id', 'local-skills', '-o', 'json']);

      const result = await run(['source', 'remove', 'local-skills', '-o', 'json']);
      expect(result.exitCode).toBe(0);

      const listResult = await run(['source', 'list', '-o', 'json']);
      const listEnvelope = parseJson<{ sources: { id: string }[] }>(listResult.stdout);
      expect(listEnvelope.data.sources.map((s) => s.id)).not.toContain('local-skills');
    });

    it('fails with a non-zero exit code when the source does not exist', async () => {
      const result = await run(['source', 'remove', 'does-not-exist', '-o', 'json']);
      expect(result.exitCode).not.toBe(0);
    });
  });
});
