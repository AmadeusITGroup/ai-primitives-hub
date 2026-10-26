/**
 * `collection-*`, `bundle manifest`, `bundle build`, `version compute`,
 * and `skill new` command tests.
 *
 * Uses a real `NodeFileSystem` against a real temp directory (not
 * `createTestContext`'s default in-memory `fs` stub, which rejects
 * every call) since these commands do real file IO; `bundle build`
 * additionally shells out to a real zip stream and `version compute`
 * to a real `git` binary, neither of which can be stubbed through
 * `Context.fs`.
 */
import {
  execFileSync,
} from 'node:child_process';
import {
  existsSync,
} from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getInstallableBundleFiles,
  validateManifest,
} from '@ai-primitives-hub/core';
import {
  NodeFileSystem,
  readZipEntryModes,
  ZipBundleExtractor,
} from '@ai-primitives-hub/infra';
import * as yaml from 'js-yaml';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  BundleBuildCommand,
} from '../../src/commands/bundle-build';
import {
  BundleManifestCommand,
} from '../../src/commands/bundle-manifest';
import {
  CollectionAffectedCommand,
} from '../../src/commands/collection-affected';
import {
  CollectionCreateCommand,
} from '../../src/commands/collection-create';
import {
  CollectionListCommand,
} from '../../src/commands/collection-list';
import {
  CollectionValidateCommand,
} from '../../src/commands/collection-validate';
import {
  SkillNewCommand,
} from '../../src/commands/skill-new';
import {
  VersionComputeCommand,
} from '../../src/commands/version-compute';
import {
  runCommand,
} from '../../src/framework';

const COMMAND_CLASSES = [
  CollectionCreateCommand,
  CollectionListCommand,
  CollectionValidateCommand,
  CollectionAffectedCommand,
  BundleManifestCommand,
  BundleBuildCommand,
  VersionComputeCommand,
  SkillNewCommand
];

interface JsonEnvelope<T> {
  status: string;
  data: T;
  warnings: string[];
}

// Windows CI can take longer than Vitest's default 10-second hook timeout
// while initializing and removing a Git-backed real-filesystem fixture.
const REAL_FS_HOOK_TIMEOUT_MS = 30_000;

describe('collection/bundle/version/skill commands', () => {
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

  const commitFixtureChanges = (): void => {
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'fixture update'], { cwd: workspace, stdio: 'ignore' });
  };

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'cli-collection-test-'));
    await mkdir(path.join(workspace, 'collections'), { recursive: true });
    await mkdir(path.join(workspace, 'prompts'), { recursive: true });
    await writeFile(path.join(workspace, 'prompts', 'hello.prompt.md'), '# Hello Prompt\n\nA test prompt.\n');
    await writeFile(
      path.join(workspace, 'collections', 'foo.collection.yml'),
      `id: foo
name: Foo Collection
description: Test collection
items:
  - path: prompts/hello.prompt.md
    kind: prompt
`
    );
    await writeFile(path.join(workspace, 'LICENSE'), 'Test fixture license\n');
    execFileSync('git', ['init'], { cwd: workspace, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: workspace });
    execFileSync('git', ['config', 'user.name', 'Test Fixture'], { cwd: workspace });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/test-collection.git'], { cwd: workspace });
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: workspace, stdio: 'ignore' });
  }, REAL_FS_HOOK_TIMEOUT_MS);

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  }, REAL_FS_HOOK_TIMEOUT_MS);

  describe('collection create', () => {
    it('creates a new collection file', async () => {
      const result = await run(['collection', 'create', 'bar', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ collectionId: string; path: string }>(result.stdout);
      expect(envelope.data.collectionId).toBe('bar');
      const content = await readFile(envelope.data.path, 'utf8');
      expect(content).toContain('id: bar');
    });

    it('fails with a clipanion usage error (exit 64) when <id> is omitted', async () => {
      const result = await run(['collection', 'create', '-o', 'json']);
      expect(result.exitCode).toBe(64);
    });

    it('honors an absolute --path as-is instead of nesting it under cwd', async () => {
      const customDir = path.join(workspace, 'custom-out');
      const result = await run(['collection', 'create', 'bar', '--path', customDir, '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ path: string }>(result.stdout);
      expect(envelope.data.path.startsWith(customDir)).toBe(true);
    });
  });

  describe('collection list', () => {
    it('lists the seeded collection', async () => {
      const result = await run(['collection', 'list', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ id: string }[]>(result.stdout);
      expect(envelope.data.map((c) => c.id)).toContain('foo');
    });

    it('fails with exit 1 when collections/ does not exist', async () => {
      const freshDir = await mkdtemp(path.join(os.tmpdir(), 'cli-collection-test-nocol-'));
      try {
        const result = await runCommand(['collection', 'list', '-o', 'json'], {
          commandClasses: COMMAND_CLASSES,
          context: { cwd: freshDir, fs: new NodeFileSystem(), env: {} }
        });
        expect(result.exitCode).toBe(1);
      } finally {
        await rm(freshDir, { recursive: true, force: true });
      }
    });
  });

  describe('collection validate', () => {
    it('passes for the seeded valid collection', async () => {
      const result = await run(['collection', 'validate', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ ok: boolean; warnings: string[] }>(result.stdout);
      expect(envelope.data.ok).toBe(true);
      expect(envelope.status).toBe('warning');
      expect(envelope.warnings).toContain('collections/foo.collection.yml: Collection has no readme. Consider adding a readme to help users understand this collection.');
    });

    it('emits text warnings only once through stderr', async () => {
      const result = await run(['collection', 'validate']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('Warnings:');
      expect(result.stderr).toContain('warning: collections/foo.collection.yml: Collection has no readme. Consider adding a readme to help users understand this collection.');
    });

    it('fails for a collection missing the required id field', async () => {
      await writeFile(
        path.join(workspace, 'collections', 'bad.collection.yml'),
        'name: Bad Collection\nitems: []\n'
      );
      const result = await run([
        'collection', 'validate', '--collection-file', 'collections/bad.collection.yml', '-o', 'json'
      ]);
      expect(result.exitCode).toBe(1);
      const envelope = parseJson<{ ok: boolean }>(result.stdout);
      expect(envelope.data.ok).toBe(false);
    });

    describe('plugin items', () => {
      const writePluginCollection = async (name: string, manifest: Record<string, unknown>): Promise<string> => {
        await mkdir(path.join(workspace, 'plugins', name), { recursive: true });
        await writeFile(
          path.join(workspace, 'plugins', name, 'plugin.json'),
          JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name, ...manifest })
        );
        await writeFile(path.join(workspace, 'README.md'), '# Plug\n');
        const collectionFile = `collections/${name}.collection.yml`;
        await writeFile(
          path.join(workspace, collectionFile),
          `id: ${name}\nname: ${name}\nreadme:\n  path: README.md\nitems:\n  - path: plugins/${name}/plugin.json\n    kind: plugin\n`
        );
        return collectionFile;
      };

      it('fails when a plugin manifest violates Agent Plugins 1.0.0', async () => {
        const collectionFile = await writePluginCollection('bad-author', { author: 'someone' });
        const result = await run(['collection', 'validate', '--collection-file', collectionFile, '-o', 'json']);
        expect(result.exitCode).toBe(1);
        const envelope = parseJson<{ ok: boolean; errors: string[] }>(result.stdout);
        expect(envelope.data.ok).toBe(false);
        expect(envelope.data.errors).toEqual([
          expect.stringContaining('items[0] plugin plugins/bad-author/plugin.json: "author" must be an object')
        ]);
      });

      it('passes with a warning for an unknown plugin manifest field', async () => {
        const collectionFile = await writePluginCollection('extra-field', { hooks: 'hooks.json' });
        const result = await run(['collection', 'validate', '--collection-file', collectionFile, '-o', 'json']);
        expect(result.exitCode).toBe(0);
        const envelope = parseJson<{ ok: boolean }>(result.stdout);
        expect(envelope.data.ok).toBe(true);
        expect(envelope.status).toBe('warning');
        expect(envelope.warnings).toEqual([
          expect.stringContaining('items[0] plugin plugins/extra-field/plugin.json: unknown top-level field "hooks"')
        ]);
      });
    });
  });

  describe('collection affected', () => {
    it('reports the collection as affected when an item path changed', async () => {
      const result = await run([
        'collection', 'affected', '--changed-path', 'prompts/hello.prompt.md', '-o', 'json'
      ]);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ affected: { id: string }[] }>(result.stdout);
      expect(envelope.data.affected.map((a) => a.id)).toContain('foo');
    });

    it('reports the collection as affected when its README changed', async () => {
      await mkdir(path.join(workspace, 'docs'), { recursive: true });
      await writeFile(path.join(workspace, 'docs', 'collection-overview.md'), '# Overview\n');
      await writeFile(
        path.join(workspace, 'collections', 'foo.collection.yml'),
        `id: foo
name: Foo Collection
readme:
  path: docs/collection-overview.md
items:
  - path: prompts/hello.prompt.md
    kind: prompt
`
      );
      commitFixtureChanges();

      const result = await run([
        'collection', 'affected', '--changed-path', 'docs/collection-overview.md', '-o', 'json'
      ]);

      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ affected: { id: string }[] }>(result.stdout);
      expect(envelope.data.affected.map((a) => a.id)).toContain('foo');
    });

    it('reports no affected collections for an unrelated path', async () => {
      const result = await run([
        'collection', 'affected', '--changed-path', 'unrelated/file.md', '-o', 'json'
      ]);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ affected: unknown[] }>(result.stdout);
      expect(envelope.data.affected).toEqual([]);
    });
  });

  describe('bundle manifest', () => {
    it('generates a deployment-manifest.yml from the collection', async () => {
      const outFile = path.join(workspace, 'deployment-manifest.yml');
      const result = await run([
        'bundle', 'manifest', '--version', '1.0.0', '--out-file', outFile, '-o', 'json'
      ]);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ id: string; totalItems: number }>(result.stdout);
      expect(envelope.data).toMatchObject({ id: 'foo', totalItems: 1 });
      const content = await readFile(outFile, 'utf8');
      expect(content).toContain('id: foo');
      expect(content).not.toContain('readme:');
    });

    it('keeps collection tags at the root and does not clone them onto items', async () => {
      await writeFile(
        path.join(workspace, 'collections', 'foo.collection.yml'),
        `id: foo
name: Foo Collection
description: Test collection
author: Test Author
tags: [argos, splunk]
items:
  - path: prompts/hello.prompt.md
    kind: prompt
`
      );

      const outFile = path.join(workspace, 'deployment-manifest.yml');
      const result = await run([
        'bundle', 'manifest',
        '--version', '1.0.0',
        '--collection-file', 'collections/foo.collection.yml',
        '--out-file', outFile,
        '-o', 'json'
      ]);
      expect(result.exitCode).toBe(0);

      const manifest = yaml.load(await readFile(outFile, 'utf8')) as {
        tags?: string[];
        prompts: { tags?: string[] }[];
      };
      expect(manifest.tags).toEqual(['argos', 'splunk']);
      expect(manifest.prompts).toHaveLength(1);
      expect(manifest.prompts[0].tags).toBeUndefined();
    });

    it('preserves item-specific tags without copying collection tags', async () => {
      await writeFile(
        path.join(workspace, 'collections', 'foo.collection.yml'),
        `id: foo
name: Foo Collection
tags: [argos, pack]
items:
  - path: prompts/hello.prompt.md
    kind: prompt
    tags: [splunk]
`
      );

      const outFile = path.join(workspace, 'deployment-manifest.yml');
      const result = await run([
        'bundle', 'manifest',
        '--version', '1.0.0',
        '--collection-file', 'collections/foo.collection.yml',
        '--out-file', outFile,
        '-o', 'json'
      ]);
      expect(result.exitCode).toBe(0);

      const manifest = yaml.load(await readFile(outFile, 'utf8')) as {
        tags?: string[];
        prompts: { tags?: string[] }[];
      };
      expect(manifest.tags).toEqual(['argos', 'pack']);
      expect(manifest.prompts[0].tags).toEqual(['splunk']);
    });

    it('generates the expected MCP fields in the legacy-compatible manifest shape', async () => {
      await writeFile(
        path.join(workspace, 'collections', 'foo.collection.yml'),
        `id: foo
name: Foo Collection
description: Test collection
author: Test Author
tags: [test]
items:
  - path: prompts/hello.prompt.md
    kind: prompt
mcp:
  inputs:
    - id: serviceUrl
      type: promptString
      description: "Service URL"
      default: "https://service.example.test"
    - id: accessToken
      type: promptString
      description: "Service access token"
      password: true
    - id: proxyUrl
      type: promptString
      description: "HTTPS proxy URL"
      default: "https://proxy.example.test"
  items:
    example-server:
      type: stdio
      command: node
      args:
        - server.js
        - "--service-url=\${input:serviceUrl}"
        - "--access-token=\${input:accessToken}"
        - "--proxy-url=\${input:proxyUrl}"
`
      );

      const cliManifestPath = path.join(workspace, 'cli-manifest.yml');

      const result = await run([
        'bundle', 'manifest',
        '--version', '1.0.0',
        '--collection-file', 'collections/foo.collection.yml',
        '--out-file', cliManifestPath,
        '-o', 'json'
      ]);

      expect(result.exitCode).toBe(0);

      const cliManifest = yaml.load(await readFile(cliManifestPath, 'utf8'));

      // Pinned from lib/bin/generate-manifest.js output so parity holds without building lib/.
      expect(cliManifest).toEqual({
        id: 'foo',
        version: '1.0.0',
        name: 'Foo Collection',
        description: 'Test collection',
        author: 'Test Author',
        tags: ['test'],
        environments: ['vscode', 'windsurf', 'cursor'],
        license: 'MIT',
        repository: '',
        prompts: [
          {
            id: 'hello.prompt',
            name: 'Hello Prompt',
            description: '',
            file: 'prompts/hello.prompt.md',
            type: 'prompt'
          }
        ],
        dependencies: [],
        mcpServers: {
          'example-server': {
            type: 'stdio',
            command: 'node',
            args: [
              'server.js',
              '--service-url=${input:serviceUrl}',
              '--access-token=${input:accessToken}',
              '--proxy-url=${input:proxyUrl}'
            ]
          }
        },
        mcpInputs: [
          {
            id: 'serviceUrl',
            type: 'promptString',
            description: 'Service URL',
            default: 'https://service.example.test'
          },
          {
            id: 'accessToken',
            type: 'promptString',
            description: 'Service access token',
            password: true
          },
          {
            id: 'proxyUrl',
            type: 'promptString',
            description: 'HTTPS proxy URL',
            default: 'https://proxy.example.test'
          }
        ]
      });
    });

    it('preserves ${env:VAR} and ${env:VAR:-default} placeholders in MCP headers verbatim', async () => {
      await writeFile(
        path.join(workspace, 'collections', 'foo.collection.yml'),
        `id: foo
name: Foo Collection
description: Test collection
items:
  - path: prompts/hello.prompt.md
    kind: prompt
mcp:
  items:
    gateway:
      type: http
      url: https://gateway.example.test/mcp
      headers:
        x-jira-token: "Token \${env:JIRA_PAT:-}"
        x-sonar-token: "Token \${env:SONARQUBE_TOKEN}"
        x-user: \${env:APROACH_USERNAME:-anonymous}
`
      );

      const outFile = path.join(workspace, 'manifest.yml');
      const result = await run([
        'bundle', 'manifest',
        '--version', '1.0.0',
        '--collection-file', 'collections/foo.collection.yml',
        '--out-file', outFile,
        '-o', 'json'
      ]);
      expect(result.exitCode).toBe(0);

      const manifest = yaml.load(await readFile(outFile, 'utf8')) as {
        mcpServers: Record<string, { headers: Record<string, string> }>;
      };
      expect(manifest.mcpServers.gateway.headers).toEqual({
        'x-jira-token': 'Token ${env:JIRA_PAT:-}',
        'x-sonar-token': 'Token ${env:SONARQUBE_TOKEN}',
        'x-user': '${env:APROACH_USERNAME:-anonymous}'
      });
    });

    it('records the declared README basename in the legacy-compatible manifest shape', async () => {
      await mkdir(path.join(workspace, 'docs'), { recursive: true });
      await writeFile(path.join(workspace, 'docs', 'collection-overview.md'), '# Overview\n');
      await writeFile(
        path.join(workspace, 'collections', 'foo.collection.yml'),
        `id: foo
name: Foo Collection
description: Test collection
readme:
  path: docs/collection-overview.md
items:
  - path: prompts/hello.prompt.md
    kind: prompt
`
      );

      const cliManifestPath = path.join(workspace, 'cli-manifest.yml');

      const result = await run([
        'bundle', 'manifest',
        '--version', '1.0.0',
        '--collection-file', 'collections/foo.collection.yml',
        '--out-file', cliManifestPath,
        '-o', 'json'
      ]);

      expect(result.exitCode).toBe(0);
      const cliManifest = yaml.load(await readFile(cliManifestPath, 'utf8'));
      // Pinned from lib/bin/generate-manifest.js output so parity holds without building lib/.
      expect(cliManifest).toEqual({
        id: 'foo',
        version: '1.0.0',
        name: 'Foo Collection',
        description: 'Test collection',
        author: 'Prompt Registry',
        tags: [],
        environments: ['vscode', 'windsurf', 'cursor'],
        license: 'MIT',
        repository: '',
        prompts: [
          {
            id: 'hello.prompt',
            name: 'Hello Prompt',
            description: '',
            file: 'prompts/hello.prompt.md',
            type: 'prompt'
          }
        ],
        dependencies: [],
        readme: 'collection-overview.md'
      });
    });

    it('fails with exit 1 when collections/ does not exist and no --collection-file is given', async () => {
      const freshDir = await mkdtemp(path.join(os.tmpdir(), 'cli-collection-test-nocol-'));
      try {
        const result = await runCommand(['bundle', 'manifest', '--version', '1.0.0', '-o', 'json'], {
          commandClasses: COMMAND_CLASSES,
          context: { cwd: freshDir, fs: new NodeFileSystem(), env: {} }
        });
        expect(result.exitCode).toBe(1);
      } finally {
        await rm(freshDir, { recursive: true, force: true });
      }
    });

    it('writes the default deployment-manifest.yml under ctx.cwd(), not process.cwd()', async () => {
      const result = await run(['bundle', 'manifest', '--version', '1.0.0', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ outFile: string }>(result.stdout);
      expect(envelope.data.outFile).toBe(path.join(workspace, 'deployment-manifest.yml'));
      const content = await readFile(path.join(workspace, 'deployment-manifest.yml'), 'utf8');
      expect(content).toContain('id: foo');
      await expect(readFile(path.join(process.cwd(), 'deployment-manifest.yml'), 'utf8')).rejects.toThrow();
    });
  });

  // Real Git subprocesses and archive IO need more than five seconds on Windows CI.
  describe('bundle build', { timeout: 30_000 }, () => {
    it('builds a self-contained governed archive and retains metadata outside target content', async () => {
      await mkdir(path.join(workspace, 'docs'), { recursive: true });
      await writeFile(path.join(workspace, 'docs', 'collection-overview.md'), '# Overview\n');
      await writeFile(path.join(workspace, 'LICENSE'), 'Example license\n');
      await writeFile(
        path.join(workspace, 'package.json'),
        JSON.stringify({
          name: 'example-collection',
          license: 'Example-License',
          repository: { url: 'https://github.com/example/example-collection.git' }
        })
      );
      await writeFile(
        path.join(workspace, 'collections', 'foo.collection.yml'),
        `id: foo
name: Foo Collection
description: Test collection
readme:
  path: docs/collection-overview.md
items:
  - path: prompts/hello.prompt.md
    kind: prompt
`
      );
      commitFixtureChanges();

      const result = await run([
        'bundle', 'build', '--version', '1.0.0', '--collection-file', 'collections/foo.collection.yml', '-o', 'json'
      ]);

      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ zipAsset: string; manifestAsset: string }>(result.stdout);
      const files = await new ZipBundleExtractor().extract(await readFile(envelope.data.zipAsset));
      const manifest = validateManifest(files, { expectedId: 'foo', expectedVersion: '1.0.0' });

      expect(manifest).toMatchObject({
        formatVersion: 1,
        items: [{ id: 'hello.prompt', path: 'prompts/hello.prompt.md', kind: 'prompt' }],
        provenance: {
          source: 'https://github.com/example/example-collection',
          collectionPath: 'collections/foo.collection.yml',
          sourceSnapshotPath: 'metadata/source/collections/foo.collection.yml',
          license: 'Example-License',
          licensePath: 'LICENSE'
        }
      });
      expect([...files.keys()].toSorted()).toEqual([
        'LICENSE',
        'README.md',
        'deployment-manifest.yml',
        'metadata/source/collections/foo.collection.yml',
        'prompts/hello.prompt.md'
      ]);
      expect([...getInstallableBundleFiles(files, manifest).keys()]).toEqual([
        'deployment-manifest.yml',
        'prompts/hello.prompt.md'
      ]);
      expect(yaml.load(await readFile(envelope.data.manifestAsset, 'utf8'))).toEqual(
        yaml.load(new TextDecoder().decode(files.get('deployment-manifest.yml')))
      );
    });

    it('builds a non-trivial, reproducible bundle zip', async () => {
      const result = await run([
        'bundle', 'build', '--version', '1.0.0', '--collection-file', 'collections/foo.collection.yml', '-o', 'json'
      ]);
      expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0);
      const envelope = parseJson<{ zipAsset: string; manifestAsset: string; readmeAsset?: string }>(result.stdout);
      const zipStat = await stat(envelope.data.zipAsset);
      expect(zipStat.size).toBeGreaterThan(0);
      expect(envelope.data.readmeAsset).toBeUndefined();
    });

    it('builds a legacy bundle with a warning when committed license text is absent', async () => {
      await rm(path.join(workspace, 'LICENSE'));
      await writeFile(
        path.join(workspace, 'collections', 'foo.collection.yml'),
        `id: foo
name: Foo Collection
license: MIT
items:
  - path: prompts/hello.prompt.md
    kind: prompt
`
      );
      commitFixtureChanges();

      const result = await run([
        'bundle', 'build', '--collection-file', 'collections/foo.collection.yml', '-o', 'json'
      ]);

      expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0);
      const envelope = parseJson<{ zipAsset: string; manifestAsset: string; version: string }>(result.stdout);
      expect(envelope.data.version).toBe('0.0.0-dev');
      expect(envelope.status).toBe('warning');
      expect(envelope.warnings).toContain(
        'No committed LICENSE, COPYING, or NOTICE file was found; building a legacy bundle without governed release evidence. Add license text to enable governed self-contained releases.'
      );

      const files = await new ZipBundleExtractor().extract(await readFile(envelope.data.zipAsset));
      const manifest = validateManifest(files, { expectedId: 'foo', expectedVersion: '0.0.0-dev' });
      expect(manifest).not.toHaveProperty('formatVersion');
      expect(manifest).not.toHaveProperty('files');
      expect(manifest).not.toHaveProperty('provenance');
      expect([...files.keys()].toSorted()).toEqual([
        'deployment-manifest.yml',
        'prompts/hello.prompt.md'
      ]);
      expect(yaml.load(await readFile(envelope.data.manifestAsset, 'utf8'))).toEqual(
        yaml.load(new TextDecoder().decode(files.get('deployment-manifest.yml')))
      );
    });

    it('returns the declared README as a release asset', async () => {
      await mkdir(path.join(workspace, 'docs'), { recursive: true });
      await writeFile(path.join(workspace, 'docs', 'collection-overview.md'), '# Overview\n');
      await writeFile(
        path.join(workspace, 'collections', 'foo.collection.yml'),
        `id: foo
name: Foo Collection
readme:
  path: docs/collection-overview.md
items:
  - path: prompts/hello.prompt.md
    kind: prompt
`
      );
      commitFixtureChanges();

      const result = await run([
        'bundle', 'build', '--version', '1.0.0', '--collection-file', 'collections/foo.collection.yml', '-o', 'json'
      ]);

      expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0);
      const envelope = parseJson<{ readmeAsset?: string }>(result.stdout);
      expect(envelope.data.readmeAsset).toBe('docs/collection-overview.md');
      expect(await readFile(path.join(workspace, envelope.data.readmeAsset!), 'utf8')).toBe('# Overview\n');
      const manifest = yaml.load(await readFile(path.join(workspace, 'dist', 'foo', 'deployment-manifest.yml'), 'utf8')) as { readme: string };
      expect(manifest.readme).toBe('README.md');
    });

    it('derives the bundle id from --repo-slug, collection id, and version', async () => {
      const result = await run([
        'bundle', 'build', '--version', '1.0.0', '--repo-slug', 'owner/repo', '-o', 'json'
      ]);
      expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(parseJson<{ bundleId: string }>(result.stdout).data.bundleId).toBe('owner-repo-foo-v1.0.0');
    });

    it('fails with exit 1 on a planning error other than missing license evidence', async () => {
      await writeFile(
        path.join(workspace, 'collections', 'foo.collection.yml'),
        `id: foo
name: Foo Collection
items:
  - path: prompts/hello.prompt.md
    kind: unknown-kind
`
      );
      commitFixtureChanges();

      const result = await run([
        'bundle', 'build', '--version', '1.0.0', '-o', 'json'
      ]);
      expect(result.exitCode).toBe(1);
      const envelope = JSON.parse(result.stdout) as { status: string; errors: { code: string; message: string }[] };
      expect(envelope.status).toBe('error');
      expect(envelope.errors[0]).toMatchObject({
        code: 'INTERNAL.UNEXPECTED',
        message: 'Collection item kind is not a canonical primitive kind: unknown-kind'
      });
    });

    describe('plugin items', () => {
      const SCHEMA_URI = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
      const validManifest = (name: string): Record<string, unknown> => ({
        $schema: SCHEMA_URI,
        name,
        version: '1.0.0',
        description: 'Test plugin.',
        author: { name: 'Test' }
      });
      const writeManifest = async (manifestDir: string, manifest: Record<string, unknown>): Promise<void> => {
        await mkdir(path.join(workspace, manifestDir), { recursive: true });
        await writeFile(path.join(workspace, manifestDir, 'plugin.json'), JSON.stringify(manifest));
      };
      const writePluginFixture = async (
        name: string,
        manifest: Record<string, unknown>,
        { manifestDir = `plugins/${name}`, id = name }: { manifestDir?: string; id?: string } = {}
      ): Promise<string> => {
        await writeManifest(manifestDir, manifest);
        await mkdir(path.join(workspace, 'plugins', name, 'skills', 'demo'), { recursive: true });
        await writeFile(path.join(workspace, 'plugins', name, 'skills', 'demo', 'SKILL.md'), '# Demo\n');
        await writeFile(path.join(workspace, 'README.md'), '# Plug\n');
        const collectionFile = `collections/${id}.collection.yml`;
        await writeFile(
          path.join(workspace, collectionFile),
          `id: ${id}\nname: ${id}\nreadme:\n  path: README.md\nitems:\n  - path: ${manifestDir}/plugin.json\n    kind: plugin\n`
        );
        commitFixtureChanges();
        return collectionFile;
      };
      const buildJson = (collectionFile: string): ReturnType<typeof run> => run([
        'bundle', 'build', '--version', '1.0.0', '--collection-file', collectionFile, '-o', 'json'
      ]);
      const validateJson = async (collectionFile: string): Promise<{ errors: string[]; warnings: string[] }> => {
        const result = await run(['collection', 'validate', '--collection-file', collectionFile, '-o', 'json']);
        const envelope = parseJson<{ errors: string[] }>(result.stdout);
        return { errors: envelope.data.errors, warnings: envelope.warnings };
      };
      const artifactsExist = (id: string): boolean[] => [
        existsSync(path.join(workspace, 'dist', id, `${id}.bundle.zip`)),
        existsSync(path.join(workspace, 'dist', id, 'deployment-manifest.yml'))
      ];
      interface ErrorEnvelope {
        status: string;
        errors: { code: string; message: string; context: { errors: string[] } }[];
      }
      const { $schema: _schema, ...withoutSchema } = validManifest('no-schema');

      it.each([
        { label: 'a missing "$schema"', name: 'no-schema', id: 'no-schema', manifest: withoutSchema, manifestDir: undefined },
        { label: 'an invalid "name"', name: 'Bad_Name', id: 'bad-name', manifest: validManifest('Bad_Name'), manifestDir: undefined },
        { label: 'a string "author"', name: 'bad-author', id: 'bad-author', manifest: { ...validManifest('bad-author'), author: 'someone' }, manifestDir: undefined },
        { label: 'a plugin.json outside the plugin root', name: 'nested', id: 'nested', manifest: validManifest('nested'), manifestDir: 'plugins/nested/.github/plugin' }
      ])('fails with exit 1 and writes no artifacts for $label', async ({ name, id, manifest, manifestDir }) => {
        const collectionFile = await writePluginFixture(name, manifest, { manifestDir, id });

        const result = await buildJson(collectionFile);

        expect(result.exitCode).toBe(1);
        const envelope = JSON.parse(result.stdout) as ErrorEnvelope;
        expect(envelope.status).toBe('error');
        expect(envelope.errors[0].code).toBe('PLUGIN.INVALID_MANIFEST');
        const validation = await validateJson(collectionFile);
        expect(validation.errors.length).toBeGreaterThan(0);
        expect(envelope.errors[0].context.errors).toEqual(validation.errors);
        expect(envelope.errors[0].message).toBe(validation.errors.join('\n'));
        expect(artifactsExist(id)).toEqual([false, false]);
      });

      it('reports the plugin error in text mode', async () => {
        const collectionFile = await writePluginFixture('bad-author', { ...validManifest('bad-author'), author: 'someone' });

        const result = await run(['bundle', 'build', '--version', '1.0.0', '--collection-file', collectionFile]);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(
          'error[PLUGIN.INVALID_MANIFEST]: collections/bad-author.collection.yml: items[0] plugin plugins/bad-author/plugin.json: "author" must be an object'
        );
      });

      it('validates the committed plugin.json, not the working tree', async () => {
        const collectionFile = await writePluginFixture('demo', { ...validManifest('demo'), author: 'someone' });
        await writeManifest('plugins/demo', validManifest('demo'));
        expect((await buildJson(collectionFile)).exitCode).toBe(1);

        commitFixtureChanges();
        await writeManifest('plugins/demo', { ...validManifest('demo'), author: 'someone' });
        const result = await buildJson(collectionFile);
        expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0);
      });

      it('builds with warnings for non-fatal plugin issues', async () => {
        const collectionFile = await writePluginFixture('extra-field', { ...validManifest('extra-field'), hooks: 'hooks.json' });

        const result = await buildJson(collectionFile);

        expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0);
        const envelope = parseJson<{ zipAsset: string }>(result.stdout);
        expect(envelope.status).toBe('warning');
        expect(envelope.warnings).toEqual((await validateJson(collectionFile)).warnings);
        expect(envelope.warnings).toEqual([expect.stringContaining('unknown top-level field "hooks"')]);
        expect(existsSync(envelope.data.zipAsset)).toBe(true);
      });

      it('builds a spec-compliant plugin into the archive', async () => {
        const collectionFile = await writePluginFixture('demo', validManifest('demo'));

        const result = await buildJson(collectionFile);

        expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0);
        const envelope = parseJson<{ zipAsset: string }>(result.stdout);
        expect(envelope.status).toBe('ok');
        expect(envelope.warnings).toEqual([]);
        const files = await new ZipBundleExtractor().extract(await readFile(envelope.data.zipAsset));
        const manifest = validateManifest(files, { expectedId: 'demo', expectedVersion: '1.0.0' });
        expect([...files.keys()]).toEqual(expect.arrayContaining([
          'plugins/demo/plugin.json',
          'plugins/demo/skills/demo/SKILL.md'
        ]));
        expect(manifest.items).toMatchObject([{ id: 'demo', kind: 'plugin', path: 'plugins/demo/plugin.json' }]);
      });
    });

    describe('file modes', () => {
      const SCRIPT = 'plugins/exec-demo/scripts/launch.sh';
      const SCRIPT_BYTES = '#!/bin/sh\necho launch\n';
      const COLLECTION = 'collections/exec-demo.collection.yml';

      /**
       * Write a spec-valid plugin with a script, then commit with the script
       * recorded as 100755 (`update-index --chmod` works on every platform).
       */
      const writeExecutablePlugin = async (): Promise<void> => {
        await mkdir(path.join(workspace, 'plugins', 'exec-demo', 'scripts'), { recursive: true });
        await mkdir(path.join(workspace, 'plugins', 'exec-demo', 'hooks'), { recursive: true });
        await writeFile(
          path.join(workspace, 'plugins', 'exec-demo', 'plugin.json'),
          JSON.stringify({
            $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
            name: 'exec-demo',
            version: '1.0.0',
            description: 'Exec bit demo'
          })
        );
        await writeFile(path.join(workspace, SCRIPT), SCRIPT_BYTES);
        await writeFile(path.join(workspace, 'plugins', 'exec-demo', 'hooks', 'hooks.json'), '{}\n');
        await writeFile(
          path.join(workspace, COLLECTION),
          `id: exec-demo
name: Exec Demo
items:
  - path: prompts/hello.prompt.md
    kind: prompt
  - path: plugins/exec-demo/plugin.json
    kind: plugin
`
        );
        execFileSync('git', ['add', '.'], { cwd: workspace });
        execFileSync('git', ['update-index', '--chmod=+x', SCRIPT], { cwd: workspace });
        execFileSync('git', ['commit', '-m', 'executable plugin'], { cwd: workspace, stdio: 'ignore' });
      };

      const build = async (): Promise<JsonEnvelope<{ zipAsset: string }>> => {
        const result = await run([
          'bundle', 'build', '--version', '1.0.0', '--collection-file', COLLECTION, '-o', 'json'
        ]);
        expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0);
        return parseJson<{ zipAsset: string }>(result.stdout);
      };

      it('records committed executable files as 0755 and all other entries as 0644', async () => {
        await writeExecutablePlugin();

        const zip = await readFile((await build()).data.zipAsset);
        expect(Object.fromEntries(readZipEntryModes(zip))).toEqual({
          'deployment-manifest.yml': 0o644,
          LICENSE: 0o644,
          'metadata/source/collections/exec-demo.collection.yml': 0o644,
          'plugins/exec-demo/hooks/hooks.json': 0o644,
          'plugins/exec-demo/plugin.json': 0o644,
          [SCRIPT]: 0o755,
          'prompts/hello.prompt.md': 0o644
        });
        const files = await new ZipBundleExtractor().extract(zip);
        expect(new TextDecoder().decode(files.get(SCRIPT))).toBe(SCRIPT_BYTES);
        const manifest = validateManifest(files, { expectedId: 'exec-demo', expectedVersion: '1.0.0' }) as {
          files: Record<string, unknown>[];
        };
        for (const file of manifest.files) {
          expect(Object.keys(file)).toEqual(['path', 'role', 'size', 'sha256']);
        }
      });

      it('produces byte-identical archives across rebuilds with executable entries', async () => {
        await writeExecutablePlugin();

        const zipAsset = (await build()).data.zipAsset;
        const first = await readFile(zipAsset);
        await rm(path.join(workspace, 'dist'), { recursive: true, force: true });
        const second = await readFile((await build()).data.zipAsset);
        expect(Buffer.compare(first, second)).toBe(0);
      });

      it.skipIf(process.platform === 'win32')('records working-tree executable bits in a legacy build', async () => {
        await writeExecutablePlugin();
        await rm(path.join(workspace, 'LICENSE'));
        commitFixtureChanges();
        await chmod(path.join(workspace, SCRIPT), 0o755);

        const envelope = await build();
        expect(envelope.status).toBe('warning');
        expect(Object.fromEntries(readZipEntryModes(await readFile(envelope.data.zipAsset)))).toEqual({
          'deployment-manifest.yml': 0o644,
          'plugins/exec-demo/hooks/hooks.json': 0o644,
          'plugins/exec-demo/plugin.json': 0o644,
          [SCRIPT]: 0o755,
          'prompts/hello.prompt.md': 0o644
        });
      });
    });

    it('defaults to the first collection file under collections/ when --collection-file is omitted', async () => {
      const result = await run([
        'bundle', 'build', '--version', '1.0.0', '-o', 'json'
      ]);
      expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0);
      const envelope = parseJson<{ zipAsset: string; manifestAsset: string }>(result.stdout);
      expect(envelope.data.manifestAsset).toContain('deployment-manifest.yml');
      expect(envelope.data.zipAsset).toContain('foo.bundle.zip');
      const zipStat = await stat(envelope.data.zipAsset);
      expect(zipStat.size).toBeGreaterThan(0);
    });
  });

  describe('version compute', () => {
    beforeEach(async () => {
      await run(['bundle', 'manifest', '--version', '1.0.0', '-o', 'json']);
    });

    it('computes 1.0.0 as the initial version with no existing git tags', async () => {
      const result = await run([
        'version', 'compute', '--collection-file', 'collections/foo.collection.yml', '-o', 'json'
      ]);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ collectionId: string; nextVersion: string; tag: string }>(result.stdout);
      expect(envelope.data).toMatchObject({ collectionId: 'foo', nextVersion: '1.0.0', tag: 'foo-v1.0.0' });
    });
  });

  describe('skill new', () => {
    it('creates a new skill folder with SKILL.md', async () => {
      const result = await run([
        'skill', 'new', '--skill-name', 'my-skill', '--description', 'A test skill', '-o', 'json'
      ]);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ path: string }>(result.stdout);
      const content = await readFile(path.join(envelope.data.path, 'SKILL.md'), 'utf8');
      expect(content.length).toBeGreaterThan(0);
    });

    it('fails with exit 1 when --skill-name is omitted', async () => {
      const result = await run(['skill', 'new', '--description', 'A test skill', '-o', 'json']);
      expect(result.exitCode).toBe(1);
    });
  });
});
