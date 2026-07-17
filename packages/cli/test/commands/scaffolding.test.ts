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
 * its own dedicated test afterward.
 *
 * Uses a real `NodeFileSystem` against a real temp directory (not
 * `createTestContext`'s default in-memory `fs` stub, which rejects
 * every call) since these commands do real file IO.
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
  AgentCreateCommand,
} from '../../src/commands/agent-create';
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
  HookCreateCommand
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
