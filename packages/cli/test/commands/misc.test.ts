/**
 * Tests for the command files that were missed from the original
 * command-test-group breakdown: `apply`, `explain`, `config get`,
 * `config list`, `plugins list`, `skill validate`.
 *
 * Uses a real `NodeFileSystem` against a real temp directory (not
 * `createTestContext`'s default in-memory `fs` stub, which rejects
 * every call) since several of these commands do real file IO.
 */
import {
  mkdir,
  mkdtemp,
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
  ApplyCommand,
} from '../../src/commands/apply';
import {
  ConfigGetCommand,
} from '../../src/commands/config-get';
import {
  ConfigListCommand,
} from '../../src/commands/config-list';
import {
  ExplainCommand,
} from '../../src/commands/explain';
import {
  HubAddCommand,
  HubSyncCommand,
  HubUseCommand,
} from '../../src/commands/hub';
import {
  PluginsListCommand,
} from '../../src/commands/plugins-list';
import {
  ProfileActivateCommand,
} from '../../src/commands/profile';
import {
  SkillNewCommand,
} from '../../src/commands/skill-new';
import {
  SkillValidateCommand,
} from '../../src/commands/skill-validate';
import {
  TargetAddCommand,
} from '../../src/commands/target-add';
import {
  runCommand,
} from '../../src/framework';

const COMMAND_CLASSES = [
  TargetAddCommand,
  HubAddCommand,
  HubUseCommand,
  HubSyncCommand,
  ProfileActivateCommand,
  ApplyCommand,
  ExplainCommand,
  ConfigGetCommand,
  ConfigListCommand,
  PluginsListCommand,
  SkillNewCommand,
  SkillValidateCommand
];

interface JsonEnvelope<T> {
  status: string;
  data: T;
}

describe('apply/explain/config/plugins-list/skill-validate commands', () => {
  let workspace: string;

  const run = (argv: string[], env: Record<string, string> = {}): ReturnType<typeof runCommand> => runCommand(argv, {
    commandClasses: COMMAND_CLASSES,
    context: {
      cwd: workspace,
      fs: new NodeFileSystem(),
      env: {
        HOME: workspace,
        USERPROFILE: workspace,
        XDG_CONFIG_HOME: path.join(workspace, 'xdg-config'),
        XDG_CACHE_HOME: path.join(workspace, 'xdg-cache'),
        ...env
      }
    }
  });

  const parseJson = <T>(stdout: string): JsonEnvelope<T> => JSON.parse(stdout) as JsonEnvelope<T>;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'cli-misc-test-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  describe('apply', () => {
    let bundleDir: string;
    let targetDir: string;
    let hubConfigFile: string;

    beforeEach(async () => {
      bundleDir = path.join(workspace, 'bundle');
      targetDir = path.join(workspace, 'target');
      hubConfigFile = path.join(workspace, 'hub-config.yml');

      await mkdir(path.join(bundleDir, 'prompts'), { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await writeFile(
        path.join(bundleDir, 'deployment-manifest.yml'),
        'id: local-foo\nversion: 1.0.0\nname: Local Foo\nitems:\n  - path: prompts/hello.prompt.md\n    kind: prompt\n'
      );
      await writeFile(path.join(bundleDir, 'prompts', 'hello.prompt.md'), '# Hello Prompt\n');
      await writeFile(
        hubConfigFile,
        `version: 1.0.0
metadata:
  name: Test Hub
  description: Test hub for apply
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
profiles:
  - id: backend
    name: Backend Developer
    description: Test profile
    bundles:
      - id: local-foo
        version: 1.0.0
        source: local-foo-src
        required: true
`
      );
      expect((await run(['target', 'add', 'copilot', '--type', 'copilot-cli', '--path', targetDir, '-o', 'json'])).exitCode).toBe(0);
      expect((await run(['hub', 'add', '--type', 'local', '--location', hubConfigFile, '--id', 'test-hub', '-o', 'json'])).exitCode).toBe(0);
      expect((await run(['hub', 'use', 'test-hub', '-o', 'json'])).exitCode).toBe(0);
      expect((await run(['hub', 'sync', 'test-hub', '-o', 'json'])).exitCode).toBe(0);
    });

    it('fails with exit 1 when no profile is active', async () => {
      const result = await run(['apply', '-o', 'json']);
      expect(result.exitCode).toBe(1);
    });

    it('re-syncs the hub and re-activates the currently active profile', async () => {
      expect((await run(['profile', 'activate', 'backend', '--target', 'copilot', '-o', 'json'])).exitCode).toBe(0);

      const result = await run(['apply', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ hubId: string; profileId: string; synced: boolean }>(result.stdout);
      expect(envelope.data).toMatchObject({ hubId: 'test-hub', profileId: 'backend', synced: true });
    });

    it('--no-sync skips the hub sync step', async () => {
      expect((await run(['profile', 'activate', 'backend', '--target', 'copilot', '-o', 'json'])).exitCode).toBe(0);

      const result = await run(['apply', '--no-sync', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ synced: boolean }>(result.stdout);
      expect(envelope.data.synced).toBe(false);
    });
  });

  describe('explain', () => {
    it('returns the documented catalog entry for a known code', async () => {
      const result = await run(['explain', 'BUNDLE.NOT_FOUND', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ code: string; namespace: string; summary: string }>(result.stdout);
      expect(envelope.data).toMatchObject({ code: 'BUNDLE.NOT_FOUND', namespace: 'BUNDLE' });
      expect(envelope.data.summary.length).toBeGreaterThan(0);
    });

    it('returns a generic entry for a recognized namespace with no catalog entry yet', async () => {
      const result = await run(['explain', 'HUB.ACCESS_DENIED', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ namespace: string; docsUrl: string | null }>(result.stdout);
      expect(envelope.data.namespace).toBe('HUB');
    });

    it('fails with exit 1 for an unknown namespace', async () => {
      const result = await run(['explain', 'BOGUS.CODE', '-o', 'json']);
      expect(result.exitCode).toBe(1);
    });

    it('fails with a clipanion usage error (exit 64) when the code is omitted', async () => {
      const result = await run(['explain', '-o', 'json']);
      expect(result.exitCode).toBe(64);
    });
  });

  describe('config get', () => {
    it('reads a default value when no config file exists', async () => {
      const result = await run(['config', 'get', 'output', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ key: string; value: unknown }>(result.stdout);
      expect(envelope.data).toEqual({ key: 'output', value: 'text' });
    });

    it('project config overrides the default', async () => {
      await writeFile(path.join(workspace, 'ai-primitives-hub.yml'), 'output: json\n');
      const result = await run(['config', 'get', 'output', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ value: unknown }>(result.stdout);
      expect(envelope.data.value).toBe('json');
    });

    it('an AI_PRIMITIVES_HUB_* env var overrides the project config', async () => {
      const result = await run(['config', 'get', 'verbose', '-o', 'json'], { AI_PRIMITIVES_HUB_VERBOSE: 'true' });
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ value: unknown }>(result.stdout);
      expect(envelope.data.value).toBe(true);
    });

    it('fails with a clipanion usage error (exit 64) when the key is omitted', async () => {
      const result = await run(['config', 'get', '-o', 'json']);
      expect(result.exitCode).toBe(64);
    });
  });

  describe('config list', () => {
    it('dumps the resolved config defaults as JSON', async () => {
      const result = await run(['config', 'list', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ version: number; output: string }>(result.stdout);
      expect(envelope.data).toMatchObject({ version: 1, output: 'text' });
    });

    it('renders a human-readable summary in text mode', async () => {
      const result = await run(['config', 'list']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('AI Primitives Hub Configuration');
    });
  });

  describe('plugins list', () => {
    it('reports no plugins when nothing on $PATH matches', async () => {
      const emptyBinDir = path.join(workspace, 'empty-bin');
      await mkdir(emptyBinDir, { recursive: true });
      const result = await run(['plugins', 'list', '-o', 'json'], { PATH: emptyBinDir });
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<unknown[]>(result.stdout);
      expect(envelope.data).toEqual([]);
    });

    it('discovers an ai-primitives-hub-<name> executable on $PATH', async () => {
      const binDir = path.join(workspace, 'bin');
      await mkdir(binDir, { recursive: true });
      await writeFile(path.join(binDir, 'ai-primitives-hub-hello'), '#!/bin/sh\necho hi\n');
      const result = await run(['plugins', 'list', '-o', 'json'], { PATH: binDir });
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ name: string }[]>(result.stdout);
      expect(envelope.data.map((p) => p.name)).toContain('hello');
    });

    it('flags a shadowed plugin found in two PATH directories as a warning', async () => {
      const binDir1 = path.join(workspace, 'bin1');
      const binDir2 = path.join(workspace, 'bin2');
      await mkdir(binDir1, { recursive: true });
      await mkdir(binDir2, { recursive: true });
      await writeFile(path.join(binDir1, 'ai-primitives-hub-hello'), '#!/bin/sh\necho hi\n');
      await writeFile(path.join(binDir2, 'ai-primitives-hub-hello'), '#!/bin/sh\necho hi\n');
      const result = await run(['plugins', 'list', '-o', 'json'], { PATH: `${binDir1}${path.delimiter}${binDir2}` });
      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout) as { status: string; warnings: string[] };
      expect(envelope.status).toBe('warning');
      expect(envelope.warnings.length).toBeGreaterThan(0);
    });
  });

  describe('skill validate', () => {
    it('reports a fresh workspace with no skills/ dir as valid (nothing to check)', async () => {
      const result = await run(['skill', 'validate', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ valid: boolean; totalSkills: number }>(result.stdout);
      expect(envelope.data).toMatchObject({ valid: true, totalSkills: 0 });
    });

    it('validates a real skill created via `skill new` as valid', async () => {
      expect((await run([
        'skill', 'new', '--skill-name', 'my-skill', '--description', 'A valid test skill', '-o', 'json'
      ])).exitCode).toBe(0);

      const result = await run(['skill', 'validate', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ valid: boolean; validSkills: number; invalidSkills: number }>(result.stdout);
      expect(envelope.data).toMatchObject({ valid: true, validSkills: 1, invalidSkills: 0 });
    });

    it('fails exit 1 for a skill folder missing SKILL.md', async () => {
      await mkdir(path.join(workspace, 'skills', 'broken'), { recursive: true });
      const result = await run(['skill', 'validate', '-o', 'json']);
      expect(result.exitCode).toBe(1);
      const envelope = parseJson<{ valid: boolean; skills: { valid: boolean; errors: string[] }[] }>(result.stdout);
      expect(envelope.data.valid).toBe(false);
      expect(envelope.data.skills[0].errors).toContain('Missing SKILL.md file');
    });
  });
});
