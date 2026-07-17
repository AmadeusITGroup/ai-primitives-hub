/**
 * `target add`/`target list`/`target remove`/`target types` command tests.
 *
 * Uses a real `NodeFileSystem` against a real temp directory (not
 * `createTestContext`'s default in-memory `fs` stub, which rejects
 * every call) since these commands read/write a real project config file.
 */
import {
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
  TargetAddCommand,
} from '../../src/commands/target-add';
import {
  TargetListCommand,
} from '../../src/commands/target-list';
import {
  TargetRemoveCommand,
} from '../../src/commands/target-remove';
import {
  TargetTypesCommand,
} from '../../src/commands/target-types';
import {
  runCommand,
} from '../../src/framework';

const COMMAND_CLASSES = [
  TargetAddCommand,
  TargetListCommand,
  TargetRemoveCommand,
  TargetTypesCommand
];

interface JsonEnvelope<T> {
  status: string;
  data: T;
}

describe('target commands', () => {
  let workspace: string;

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
    workspace = await mkdtemp(path.join(os.tmpdir(), 'cli-target-test-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  describe('target types', () => {
    it('lists every supported type with a non-empty description', async () => {
      const result = await run(['target', 'types', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ type: string; description: string }[]>(result.stdout);
      const types = envelope.data.map((t) => t.type);
      expect(types).toEqual(
        expect.arrayContaining(['vscode', 'vscode-insiders', 'copilot-cli', 'kiro', 'windsurf', 'claude-code'])
      );
      for (const entry of envelope.data) {
        expect(entry.description.length).toBeGreaterThan(0);
      }
    });
  });

  describe('target add', () => {
    it('registers a new target', async () => {
      const result = await run(['target', 'add', 'my-vscode', '--type', 'vscode', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ target: { name: string; type: string; scope: string }; created: boolean }>(result.stdout);
      expect(envelope.data.target).toMatchObject({ name: 'my-vscode', type: 'vscode', scope: 'user' });
      expect(envelope.data.created).toBe(true);
    });

    it('force-scopes copilot-cli targets to user regardless of --scope', async () => {
      const result = await run([
        'target', 'add', 'my-copilot', '--type', 'copilot-cli', '--scope', 'repository', '-o', 'json'
      ]);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ target: { scope: string } }>(result.stdout);
      expect(envelope.data.target.scope).toBe('user');
    });

    it('honors --scope repository and --workspace-root for non-copilot-cli types', async () => {
      const result = await run([
        'target', 'add', 'ws-prompts', '--type', 'vscode', '--scope', 'repository',
        '--workspace-root', workspace, '-o', 'json'
      ]);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ target: { scope: string; rootPath?: string } }>(result.stdout);
      expect(envelope.data.target.scope).toBe('repository');
      expect(envelope.data.target.rootPath).toBe(workspace);
    });

    it('fails with exit 1 for an unknown --type', async () => {
      const result = await run(['target', 'add', 'bad', '--type', 'not-a-real-type', '-o', 'json']);
      expect(result.exitCode).toBe(1);
    });

    it('fails with exit 1 when adding a duplicate name', async () => {
      await run(['target', 'add', 'dup', '--type', 'vscode', '-o', 'json']);
      const result = await run(['target', 'add', 'dup', '--type', 'vscode', '-o', 'json']);
      expect(result.exitCode).toBe(1);
    });

    it('fails with a clipanion usage error (exit 64) when <name> is omitted', async () => {
      const result = await run(['target', 'add', '--type', 'vscode', '-o', 'json']);
      expect(result.exitCode).toBe(64);
    });
  });

  describe('target list', () => {
    it('returns an empty list when no targets are configured', async () => {
      const result = await run(['target', 'list', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<unknown[]>(result.stdout);
      expect(envelope.data).toEqual([]);
    });

    it('lists every configured target', async () => {
      await run(['target', 'add', 'a', '--type', 'vscode', '-o', 'json']);
      await run(['target', 'add', 'b', '--type', 'copilot-cli', '-o', 'json']);

      const result = await run(['target', 'list', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ name: string }[]>(result.stdout);
      expect(envelope.data.map((t) => t.name).toSorted()).toEqual(['a', 'b']);
    });
  });

  describe('target remove', () => {
    beforeEach(async () => {
      await run(['target', 'add', 'to-remove', '--type', 'vscode', '-o', 'json']);
    });

    it('removes a configured target', async () => {
      const result = await run(['target', 'remove', 'to-remove', '-o', 'json']);
      expect(result.exitCode).toBe(0);

      const listResult = await run(['target', 'list', '-o', 'json']);
      const listEnvelope = parseJson<{ name: string }[]>(listResult.stdout);
      expect(listEnvelope.data.map((t) => t.name)).not.toContain('to-remove');
    });

    it('fails with exit 1 when the target does not exist', async () => {
      const result = await run(['target', 'remove', 'does-not-exist', '-o', 'json']);
      expect(result.exitCode).toBe(1);
    });

    it('fails with a clipanion usage error (exit 64) when <name> is omitted', async () => {
      const result = await run(['target', 'remove', '-o', 'json']);
      expect(result.exitCode).toBe(64);
    });
  });
});
