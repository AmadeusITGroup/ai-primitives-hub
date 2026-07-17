/**
 * `hub` command tests.
 *
 * Uses a real `NodeFileSystem` against a real temp directory (not
 * `createTestContext`'s default in-memory `fs` stub, which rejects
 * every call) since these commands do real file IO (hub-config.yml
 * scaffolding, user-scope hub store reads/writes).
 */
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
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
  HubAddCommand,
  HubCreateCommand,
  HubListCommand,
  HubRefreshCommand,
  HubRemoveCommand,
  HubSyncCommand,
  HubUseCommand,
} from '../../src/commands/hub';
import {
  runCommand,
} from '../../src/framework';

const COMMAND_CLASSES = [
  HubAddCommand,
  HubCreateCommand,
  HubListCommand,
  HubRefreshCommand,
  HubRemoveCommand,
  HubSyncCommand,
  HubUseCommand
];

interface JsonEnvelope<T> {
  status: string;
  data: T;
}

describe('hub commands', () => {
  let workspace: string;
  let bundleDir: string;
  let hubConfigFile: string;

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
    workspace = await mkdtemp(path.join(os.tmpdir(), 'cli-hub-test-'));
    bundleDir = path.join(workspace, 'bundle');
    hubConfigFile = path.join(workspace, 'hub-config.yml');

    await mkdir(bundleDir, { recursive: true });
    await writeFile(
      hubConfigFile,
      `version: 1.0.0
metadata:
  name: Test Hub
  description: Test hub
  maintainer: test
  updatedAt: '2026-01-01T00:00:00Z'
sources:
  - id: local-foo-src
    name: Local Foo Source
    type: local
    url: ${bundleDir}
    enabled: true
    priority: 0
    hubId: test-hub
profiles: []
`
    );
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  describe('hub create', () => {
    it('scaffolds a hub-config.yml in the given --out dir', async () => {
      const outDir = path.join(workspace, 'scaffolded');
      const result = await run(['hub', 'create', '--name', 'My Hub', '--out', outDir, '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ path: string; name: string; outDir: string }>(result.stdout);
      expect(envelope.data.name).toBe('My Hub');
      expect(envelope.data.path).toBe(path.join(outDir, 'hub-config.yml'));

      const content = await readFile(envelope.data.path, 'utf8');
      expect(content).toContain('name: "My Hub"');
      expect(content).toContain('profiles: []');
    });

    it('fails with exit 1 when --name is missing', async () => {
      const result = await run(['hub', 'create', '-o', 'json']);
      expect(result.exitCode).toBe(1);
    });
  });

  describe('hub add', () => {
    it('imports a local hub and auto-uses + auto-syncs it by default', async () => {
      const result = await run([
        'hub', 'add', '--type', 'local', '--location', hubConfigFile, '--id', 'test-hub', '-o', 'json'
      ]);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ id: string; used: boolean; synced: boolean }>(result.stdout);
      expect(envelope.data).toMatchObject({ id: 'test-hub', used: true, synced: true });

      const listResult = await run(['hub', 'list', '-o', 'json']);
      const listEnvelope = parseJson<{ hubs: { id: string }[]; activeId: string | null }>(listResult.stdout);
      expect(listEnvelope.data.activeId).toBe('test-hub');
      expect(listEnvelope.data.hubs.map((h) => h.id)).toContain('test-hub');
    });

    it('honors --no-use and --no-sync', async () => {
      const result = await run([
        'hub', 'add', '--type', 'local', '--location', hubConfigFile, '--id', 'test-hub',
        '--no-use', '--no-sync', '-o', 'json'
      ]);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ used: boolean; synced: boolean }>(result.stdout);
      expect(envelope.data).toMatchObject({ used: false, synced: false });

      const listResult = await run(['hub', 'list', '-o', 'json']);
      const listEnvelope = parseJson<{ activeId: string | null }>(listResult.stdout);
      expect(listEnvelope.data.activeId).toBeNull();
    });

    it('fails with exit 1 when --location is missing', async () => {
      const result = await run(['hub', 'add', '--type', 'local', '-o', 'json']);
      expect(result.exitCode).toBe(1);
    });
  });

  describe('hub list --check', () => {
    it('reports reachability per hub', async () => {
      await run(['hub', 'add', '--type', 'local', '--location', hubConfigFile, '--id', 'test-hub', '-o', 'json']);

      const result = await run(['hub', 'list', '--check', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ hubs: { id: string; check?: { status: string } }[] }>(result.stdout);
      const hub = envelope.data.hubs.find((h) => h.id === 'test-hub');
      expect(hub?.check?.status).toBe('ok');
    });
  });

  describe('hub use', () => {
    beforeEach(async () => {
      await run([
        'hub', 'add', '--type', 'local', '--location', hubConfigFile, '--id', 'test-hub', '--no-use', '-o', 'json'
      ]);
    });

    it('sets the active hub', async () => {
      const result = await run(['hub', 'use', 'test-hub', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ activeId: string }>(result.stdout);
      expect(envelope.data.activeId).toBe('test-hub');
    });

    it('clears the active hub with --clear', async () => {
      await run(['hub', 'use', 'test-hub', '-o', 'json']);
      const result = await run(['hub', 'use', '--clear', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ activeId: null }>(result.stdout);
      expect(envelope.data.activeId).toBeNull();
    });

    it('fails with exit 1 when neither an id nor --clear is given', async () => {
      const result = await run(['hub', 'use', '-o', 'json']);
      expect(result.exitCode).toBe(1);
    });
  });

  describe('hub remove', () => {
    beforeEach(async () => {
      await run(['hub', 'add', '--type', 'local', '--location', hubConfigFile, '--id', 'test-hub', '-o', 'json']);
    });

    it('removes a hub', async () => {
      const result = await run(['hub', 'remove', 'test-hub', '-o', 'json']);
      expect(result.exitCode).toBe(0);

      const listResult = await run(['hub', 'list', '-o', 'json']);
      const listEnvelope = parseJson<{ hubs: { id: string }[] }>(listResult.stdout);
      expect(listEnvelope.data.hubs.map((h) => h.id)).not.toContain('test-hub');
    });

    it('fails with exit 1 when no id is given', async () => {
      const result = await run(['hub', 'remove', '-o', 'json']);
      expect(result.exitCode).toBe(1);
    });
  });

  describe('hub sync / hub refresh', () => {
    beforeEach(async () => {
      await run([
        'hub', 'add', '--type', 'local', '--location', hubConfigFile, '--id', 'test-hub', '--no-sync', '-o', 'json'
      ]);
    });

    it('hub sync <id> syncs the given hub', async () => {
      const result = await run(['hub', 'sync', 'test-hub', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ id: string }>(result.stdout);
      expect(envelope.data.id).toBe('test-hub');
    });

    it('hub sync (no id) syncs the active hub', async () => {
      const result = await run(['hub', 'sync', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ id: string }>(result.stdout);
      expect(envelope.data.id).toBe('test-hub');
    });

    it('hub sync (no id, no active hub) fails with exit 1', async () => {
      await run(['hub', 'use', '--clear', '-o', 'json']);
      const result = await run(['hub', 'sync', '-o', 'json']);
      expect(result.exitCode).toBe(1);
    });

    it('hub refresh syncs the active hub', async () => {
      const result = await run(['hub', 'refresh', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ id: string }>(result.stdout);
      expect(envelope.data.id).toBe('test-hub');
    });

    it('hub refresh (no active hub) fails with exit 1', async () => {
      await run(['hub', 'use', '--clear', '-o', 'json']);
      const result = await run(['hub', 'refresh', '-o', 'json']);
      expect(result.exitCode).toBe(1);
    });
  });
});
