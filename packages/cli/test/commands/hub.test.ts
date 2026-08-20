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
  HubValidateCommand,
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
  HubUseCommand,
  HubValidateCommand
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

  describe('hub validate', () => {
    it('validates hub-config.yml through the CLI', async () => {
      await writeFile(
        hubConfigFile,
        `version: 1.0.0
metadata:
  name: Test Hub
  description: Test hub
  maintainer: test
  updatedAt: '2026-01-01T00:00:00Z'
sources:
  - id: github-source
    type: github
    url: https://github.com/example-org/example-repository
    enabled: true
    priority: 1
profiles:
  - id: test-profile
    name: Test Profile
    description: Test profile
    bundles:
      - id: example-org-example-repository-example-bundle
        version: latest
        source: github-source
        required: true
`
      );

      const result = await run(['hub', 'validate', '-o', 'json']);

      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ valid: boolean; file: string; errors: string[] }>(result.stdout);
      expect(envelope.data.valid).toBe(true);
      expect(envelope.data.file).toContain('hub-config.yml');
      expect(envelope.data.errors).toHaveLength(0);
    });

    it('returns source-policy errors and a failing exit code', async () => {
      await writeFile(
        hubConfigFile,
        `version: 1.0.0
metadata:
  name: Test Hub
  description: Test hub
  maintainer: test
  updatedAt: '2026-01-01T00:00:00Z'
sources:
  - id: github-source
    type: github
    url: https://github.com/example-org/example-repository
    enabled: true
    priority: 1
    config:
      branch: main
profiles: []
`
      );

      const result = await run(['hub', 'validate', '-o', 'json']);

      expect(result.exitCode).toBe(1);
      const envelope = parseJson<{ valid: boolean; errors: string[] }>(result.stdout);
      expect(envelope.data.valid).toBe(false);
      expect(envelope.data.errors).toContain(
        "Source 'github-source' has type 'github' and must not define 'config'."
      );
    });

    it('keeps the default validation offline', async () => {
      await writeFile(
        hubConfigFile,
        `version: 1.0.0
metadata:
  name: Test Hub
  description: Test hub
  maintainer: test
  updatedAt: '2026-01-01T00:00:00Z'
sources:
  - id: github-source
    type: github
    url: https://github.com/example-org/example-repository-that-does-not-exist
    enabled: true
    priority: 1
profiles: []
`
      );

      const result = await run(['hub', 'validate', '-o', 'json']);

      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ valid: boolean; deep?: boolean }>(result.stdout);
      expect(envelope.data.valid).toBe(true);
      expect(envelope.data.deep).toBeUndefined();
    });

    it('checks local catalogs and reports a missing required profile bundle', async () => {
      await mkdir(path.join(bundleDir, 'available'), { recursive: true });
      await writeFile(
        path.join(bundleDir, 'available', 'deployment-manifest.yml'),
        `id: available
name: Available Bundle
version: 1.0.0
description: Available bundle
author: test
`
      );
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
profiles:
  - id: test-profile
    name: Test Profile
    description: Test profile
    bundles:
      - id: missing
        version: latest
        source: local-foo-src
        required: true
`
      );

      const result = await run(['hub', 'validate', '--check-sources', '-o', 'json']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).not.toContain('Deep validation:');
      const envelope = parseJson<{
        valid: boolean;
        deep: boolean;
        sources: { sourceId: string; bundlesFound: number }[];
        profiles: { profileId: string; valid: boolean }[];
        errors: string[];
      }>(result.stdout);
      expect(envelope.data.deep).toBe(true);
      expect(envelope.data.valid).toBe(false);
      expect(envelope.data.sources).toEqual([
        expect.objectContaining({ sourceId: 'local-foo-src', bundlesFound: 1 })
      ]);
      expect(envelope.data.profiles).toEqual([
        expect.objectContaining({ profileId: 'test-profile', valid: false })
      ]);
      expect(envelope.data.errors).toContain(
        "Profile 'test-profile' references bundle 'missing' from source 'local-foo-src', but no matching bundle was discovered."
      );
    });

    it('resolves latest from the discovered local catalog', async () => {
      await mkdir(path.join(bundleDir, 'v1'), { recursive: true });
      await mkdir(path.join(bundleDir, 'v2'), { recursive: true });
      await writeFile(
        path.join(bundleDir, 'v1', 'deployment-manifest.yml'),
        `id: versioned
name: Versioned Bundle
version: 1.0.0
description: Version one
author: test
`
      );
      await writeFile(
        path.join(bundleDir, 'v2', 'deployment-manifest.yml'),
        `id: versioned
name: Versioned Bundle
version: 2.0.0
description: Version two
author: test
`
      );
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
profiles:
  - id: test-profile
    name: Test Profile
    description: Test profile
    bundles:
      - id: versioned
        version: latest
        source: local-foo-src
        required: true
`
      );

      const result = await run(['hub', 'validate', '--check-sources', '-o', 'json']);

      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{
        profiles: { bundles: { resolvedBundle?: { version: string } }[] }[];
      }>(result.stdout);
      expect(envelope.data.profiles[0].bundles[0].resolvedBundle?.version).toBe('2.0.0');
    });

    it('reports verbose deep progress to stderr while keeping JSON stdout parseable', async () => {
      await mkdir(path.join(bundleDir, 'available'), { recursive: true });
      await writeFile(
        path.join(bundleDir, 'available', 'deployment-manifest.yml'),
        `id: available
name: Available Bundle
version: 1.0.0
description: Available bundle
author: test
`
      );
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
profiles:
  - id: test-profile
    name: Test Profile
    description: Test profile
    bundles:
      - id: available
        version: latest
        source: local-foo-src
        required: true
`
      );

      const result = await run([
        'hub', 'validate', '--check-sources', '--verbose', '-o', 'json'
      ]);

      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ valid: boolean; deep: boolean }>(result.stdout);
      expect(envelope.data).toMatchObject({ valid: true, deep: true });
      expect(result.stderr).toContain('Deep validation: checking 1 source(s) and 1 profile(s)');
      expect(result.stderr).toContain('[source 1/1] Checking local-foo-src (local)');
      expect(result.stderr).toContain('[profile 1/1] Resolving test-profile');
      expect(result.stderr).toContain('Deep validation complete: valid');
    });

    it('does not enable deep checks when --verbose is used without --check-sources', async () => {
      const result = await run(['hub', 'validate', '--verbose', '-o', 'json']);

      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ valid: boolean; deep?: boolean }>(result.stdout);
      expect(envelope.data).toMatchObject({ valid: true });
      expect(envelope.data.deep).toBeUndefined();
      expect(result.stderr).toContain('--verbose has no effect without --check-sources');
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
