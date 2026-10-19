/**
 * Scaffolding generator command tests: `agent create`, `instruction
 * create`, `prompt create`, `skill create`, `plugin create`, `hook
 * create`.
 *
 * All six share an identical TemplateEngine-backed structure (see each
 * command file's module doc), so the common behavior — create with
 * description substitution, --collection integration, --collection
 * pointing at a missing file, and the required <name> positional — is
 * exercised once per command via a small data table instead of
 * duplicating the same four tests six times. Each command's unique
 * extra flag (skill's --author, plugin's --version, hook's --type) gets
 * its own dedicated test afterward. `plugin create` also has a block for
 * its Agent Plugins 1.0.0 contract: `plugins/<name>/plugin.json` passes
 * `collection validate`, invalid names are rejected before anything is
 * written, and an existing manifest is never overwritten.
 *
 * Uses a real `NodeFileSystem` against a real temp directory (not
 * `createTestContext`'s default in-memory `fs` stub, which rejects
 * every call) since these commands do real file IO.
 */
import {
  existsSync,
} from 'node:fs';
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
  AGENT_PLUGIN_MANIFEST_SCHEMA_URI,
} from '@ai-primitives-hub/core';
import {
  NodeFileSystem,
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
  AgentCreateCommand,
} from '../../src/commands/agent-create';
import {
  CollectionValidateCommand,
} from '../../src/commands/collection-validate';
import {
  HookCreateCommand,
} from '../../src/commands/hook-create';
import {
  InstructionCreateCommand,
} from '../../src/commands/instruction-create';
import {
  PluginCreateCommand,
} from '../../src/commands/plugin-create';
import {
  PromptCreateCommand,
} from '../../src/commands/prompt-create';
import {
  SkillCreateCommand,
} from '../../src/commands/skill-create';
import {
  runCommand,
} from '../../src/framework';

const COMMAND_CLASSES = [
  AgentCreateCommand,
  InstructionCreateCommand,
  PromptCreateCommand,
  SkillCreateCommand,
  PluginCreateCommand,
  HookCreateCommand,
  CollectionValidateCommand
];

interface JsonEnvelope<T> {
  status: string;
  data: T;
}

interface ScaffoldData {
  name: string;
  path: string;
  createdFiles: string[];
  collection?: string;
}

interface ScaffoldSpec {
  label: string;
  createArgs: string[];
  defaultDir: string;
}

const SPECS: ScaffoldSpec[] = [
  { label: 'agent', createArgs: ['agent', 'create'], defaultDir: 'agents' },
  { label: 'instruction', createArgs: ['instruction', 'create'], defaultDir: 'instructions' },
  { label: 'prompt', createArgs: ['prompt', 'create'], defaultDir: 'prompts' },
  { label: 'skill', createArgs: ['skill', 'create'], defaultDir: 'skills' },
  { label: 'plugin', createArgs: ['plugin', 'create'], defaultDir: 'plugins' },
  { label: 'hook', createArgs: ['hook', 'create'], defaultDir: 'hooks' }
];

describe('scaffolding generator commands', () => {
  let workspace: string;

  const run = (argv: string[]): ReturnType<typeof runCommand> => runCommand(argv, {
    commandClasses: COMMAND_CLASSES,
    context: { cwd: workspace, fs: new NodeFileSystem(), env: {} }
  });

  const parseJson = <T>(stdout: string): JsonEnvelope<T> => JSON.parse(stdout) as JsonEnvelope<T>;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'cli-scaffold-test-'));
    await mkdir(path.join(workspace, 'collections'), { recursive: true });
    await writeFile(path.join(workspace, 'collections', 'foo.collection.yml'), 'id: foo\nname: Foo\nitems: []\n');
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  describe.each(SPECS)('$label create', (spec) => {
    it('creates the file under the default directory with the description embedded', async () => {
      const result = await run([...spec.createArgs, 'my-thing', '--description', 'A test description', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<ScaffoldData>(result.stdout);
      expect(envelope.data.path.startsWith(path.join(workspace, spec.defaultDir))).toBe(true);
      const content = await readFile(envelope.data.path, 'utf8');
      expect(content).toContain('A test description');
    });

    it('honors --path to override the output directory', async () => {
      const customDir = path.join(workspace, 'custom-out');
      const result = await run([...spec.createArgs, 'my-thing', '--path', customDir, '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<ScaffoldData>(result.stdout);
      expect(envelope.data.path.startsWith(customDir)).toBe(true);
    });

    it('adds an item to an existing collection when --collection is given', async () => {
      const result = await run([...spec.createArgs, 'my-thing', '--collection', 'foo', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const collectionContent = await readFile(path.join(workspace, 'collections', 'foo.collection.yml'), 'utf8');
      expect(collectionContent).toContain('my-thing');
    });

    it('fails with exit 1 when --collection points to a nonexistent collection', async () => {
      const result = await run([...spec.createArgs, 'my-thing', '--collection', 'does-not-exist', '-o', 'json']);
      expect(result.exitCode).toBe(1);
    });

    it('fails with a clipanion usage error (exit 64) when <name> is omitted', async () => {
      const result = await run([...spec.createArgs, '-o', 'json']);
      expect(result.exitCode).toBe(64);
    });
  });

  describe('skill create --author', () => {
    it('embeds the author in SKILL.md', async () => {
      const result = await run(['skill', 'create', 'my-skill', '--author', 'Jane Doe', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<ScaffoldData>(result.stdout);
      const content = await readFile(envelope.data.path, 'utf8');
      expect(content).toContain('Jane Doe');
    });
  });

  describe('plugin create --version', () => {
    it('embeds the version in plugin.json', async () => {
      const result = await run(['plugin', 'create', 'my-plugin', '--version', '2.3.4', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<ScaffoldData>(result.stdout);
      const content = await readFile(envelope.data.path, 'utf8');
      expect(content).toContain('2.3.4');
    });
  });

  describe('plugin create — Agent Plugins 1.0.0 layout', () => {
    const collectionFile = (): string => path.join(workspace, 'collections', 'foo.collection.yml');

    it('writes plugins/<name>/plugin.json with $schema, name and an object author', async () => {
      const result = await run(['plugin', 'create', 'my-plugin', '--author', 'Jane Doe', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const manifestPath = path.join(workspace, 'plugins', 'my-plugin', 'plugin.json');
      expect(parseJson<ScaffoldData>(result.stdout).data.path).toBe(manifestPath);
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
      expect(manifest).toMatchObject({
        $schema: AGENT_PLUGIN_MANIFEST_SCHEMA_URI,
        name: 'my-plugin',
        author: { name: 'Jane Doe' }
      });
      expect(existsSync(path.join(workspace, 'plugins', 'plugin.json'))).toBe(false);
    });

    it('passes collection validate after --collection adds the item', async () => {
      expect((await run(['plugin', 'create', 'my-plugin', '--collection', 'foo'])).exitCode).toBe(0);
      const collection = yaml.load(await readFile(collectionFile(), 'utf8')) as { items: Record<string, unknown>[] };
      expect(collection.items).toEqual([expect.objectContaining({ path: 'plugins/my-plugin/plugin.json', kind: 'plugin' })]);
      const validate = await run(['collection', 'validate']);
      // The fixture collection has no readme, so a readme warning is expected; no plugin issue is.
      expect(validate.stderr).not.toMatch(/plugin/i);
      expect(validate.exitCode).toBe(0);
    });

    it('passes collection validate when the description contains quotes', async () => {
      const create = await run(['plugin', 'create', 'my-plugin', '--description', 'Say "hi"', '--collection', 'foo']);
      expect(create.exitCode).toBe(0);
      expect((await run(['collection', 'validate'])).exitCode).toBe(0);
    });

    it('rejects an invalid name with an actionable error and writes nothing', async () => {
      const before = await readFile(collectionFile(), 'utf8');
      const result = await run(['plugin', 'create', 'My_Plugin', '--collection', 'foo']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('PRIMITIVE.INVALID_NAME');
      expect(result.stderr).toContain('"my-plugin"');
      expect(existsSync(path.join(workspace, 'plugins'))).toBe(false);
      expect(await readFile(collectionFile(), 'utf8')).toBe(before);
    });

    it('refuses to overwrite an existing plugin.json', async () => {
      expect((await run(['plugin', 'create', 'my-plugin'])).exitCode).toBe(0);
      const manifestPath = path.join(workspace, 'plugins', 'my-plugin', 'plugin.json');
      const before = await readFile(manifestPath, 'utf8');
      const second = await run(['plugin', 'create', 'my-plugin', '--description', 'other']);
      expect(second.exitCode).toBe(1);
      expect(second.stderr).toContain('PRIMITIVE.ALREADY_EXISTS');
      expect(await readFile(manifestPath, 'utf8')).toBe(before);
    });
  });

  describe('hook create --type', () => {
    it('embeds the type in hook.json', async () => {
      const result = await run(['hook', 'create', 'my-hook', '--type', 'pre-commit', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<ScaffoldData>(result.stdout);
      const content = await readFile(envelope.data.path, 'utf8');
      expect(content).toContain('pre-commit');
    });
  });
});
