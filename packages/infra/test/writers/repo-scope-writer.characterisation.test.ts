/**
 * Characterisation tests for infra/writers/repo-scope-writer.ts.
 *
 * Pin today's repository-scope output for every primitive kind (issue
 * #552, ADR-0009 step M1): the `write()` and `preflight()` results, the
 * files written and the exact `.git/info/exclude` bytes in `local-only`
 * mode. These values were captured before the install-category refactor
 * and must not change. Kept apart from `repo-scope-writer.test.ts` so the
 * two suites can evolve independently.
 */
import type {
  PrimitiveKind,
  Target,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  RepositoryScopeWriter,
  RepositoryScopeWriterAdapter,
} from '../../src/writers/repo-scope-writer';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

const WORKSPACE_ROOT = '/workspace';
const EXCLUDE_PATH = '/workspace/.git/info/exclude';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Build an extracted-bundle map from text contents.
 * @param manifest - `deployment-manifest.yml` text.
 * @param files - Bundle-relative path → text contents.
 */
const bundle = (manifest: string, files: Record<string, string>): Map<string, Uint8Array> => new Map([
  ['deployment-manifest.yml', encoder.encode(manifest)],
  ...Object.entries(files).map(([file, text]): [string, Uint8Array] => [file, encoder.encode(text)])
]);

/**
 * Every file below `root`, as a sorted `path → text` record.
 * @param fs - Filesystem double.
 * @param root - Directory to list.
 */
const listFiles = async (fs: InMemoryFileSystem, root: string): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readDirEntries(dir)) {
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(child);
      } else {
        out[child] = decoder.decode(await fs.readFileBytes(child));
      }
    }
  };
  if (await fs.exists(root)) {
    await walk(root);
  }
  return Object.fromEntries(Object.entries(out).toSorted(([a], [b]) => (a < b ? -1 : (a > b ? 1 : 0))));
};

const readExclude = async (fs: InMemoryFileSystem): Promise<string | null> =>
  (await fs.exists(EXCLUDE_PATH)) ? fs.readFile(EXCLUDE_PATH) : null;

/**
 * An absolute output path with `/` separators. The writer joins paths with
 * the platform's separator, so Windows reports `\workspace\.github\…`.
 * @param filePath - Absolute path from a write result.
 */
const toPosix = (filePath: string): string => filePath.replaceAll('\\', '/');

/** Item files of the per-kind fixture, one item per primitive kind. */
const KIND_FILES: Record<string, string> = {
  'prompts/x.prompt.md': '# Prompt\n',
  'instructions/x.instructions.md': '# Instruction\n',
  'chatmodes/x.chatmode.md': '# Chat mode\n',
  'agents/x.agent.md': '# Agent\n',
  'skills/foo/SKILL.md': '# Skill\n',
  'skills/foo/references/ref.md': '# Reference\n',
  'skills/foo/scripts/run.sh': '#!/bin/sh\n',
  'skills/baz/SKILL.md': '# Renamed skill\n',
  'plugins/bar/plugin.json': '{"name":"bar"}\n',
  'plugins/bar/skills/s/SKILL.md': '# Plugin skill\n',
  'hooks/x.json': '{}\n',
  'mcp-servers/x.mcp.json': '{}\n',
  '.kiro/steering/x.md': '# Steering\n',
  '.kiro/specs/feature/requirements.md': '# Spec\n',
  'commands/x.md': '# Command\n',
  'rules/x.md': '# Rule\n',
  'output-styles/x.md': '# Output style\n',
  'tools/x.md': '# Tool\n',
  'powers/stripe/POWER.md': '# Power\n',
  'powers/stripe/steering/payments.md': '# Payments\n',
  'knowledge/x.md': '# Knowledge\n',
  'playbooks/x.md': '# Playbook\n',
  'README.md': '# Bundle\n'
};

const GOVERNED_MANIFEST = `formatVersion: 1
id: kinds
version: 1.0.0
name: Kinds
items:
  - { path: prompts/x.prompt.md, kind: prompt, id: x.prompt }
  - { path: instructions/x.instructions.md, kind: instruction, id: x.instructions }
  - { path: chatmodes/x.chatmode.md, kind: chat-mode, id: x.chatmode }
  - { path: agents/x.agent.md, kind: agent, id: x.agent }
  - { path: skills/foo/SKILL.md, kind: skill, id: foo }
  - { path: skills/baz/SKILL.md, kind: skill, id: baz-renamed }
  - { path: plugins/bar/plugin.json, kind: plugin, id: bar }
  - { path: hooks/x.json, kind: hook, id: x }
  - { path: mcp-servers/x.mcp.json, kind: mcp-server, id: x.mcp }
  - { path: .kiro/steering/x.md, kind: steering, id: x }
  - { path: .kiro/specs/feature/requirements.md, kind: spec, id: requirements }
  - { path: commands/x.md, kind: command, id: x }
  - { path: rules/x.md, kind: rule, id: x }
  - { path: output-styles/x.md, kind: output-style, id: x }
  - { path: tools/x.md, kind: tool, id: x }
  - { path: powers/stripe/POWER.md, kind: power, id: POWER }
  - { path: knowledge/x.md, kind: knowledge, id: x }
  - { path: playbooks/x.md, kind: playbook, id: x }
`;

const LEGACY_MANIFEST = `id: legacy
version: 1.0.0
name: Legacy
prompts:
  - { id: x.prompt, file: prompts/x.prompt.md, type: prompt }
instructions:
  - { id: x.instructions, file: instructions/x.instructions.md, type: instructions }
agents:
  - { id: x.agent, file: agents/x.agent.md, type: agent }
  - { id: x.chatmode, file: chatmodes/x.chatmode.md, type: chatmode }
hooks:
  - { id: x, file: hooks/x.json, type: hook }
plugins:
  - { id: bar, file: plugins/bar/plugin.json, type: plugin }
skills:
  - { id: ignored-legacy-id, file: skills/foo/SKILL.md, type: skill }
`;

const ALIAS_MANIFEST = `formatVersion: 1
id: aliases
version: 1.0.0
name: Aliases
items:
  - { path: skills/foo/SKILL.md, kind: Skill, id: foo }
  - { path: skills/baz/SKILL.md, kind: skills, id: baz }
  - { path: chatmodes/x.chatmode.md, kind: chatmode, id: x.chatmode }
  - { path: agents/x.agent.md, kind: chat-mode, id: x.agent }
  - { path: instructions/x.instructions.md, kind: instructions, id: x.instructions }
  - { path: powers/stripe/POWER.md, kind: power, id: POWER }
  - { path: mcp-servers/x.mcp.json, kind: mcp-server, id: x.mcp }
`;

const MANIFESTS: Record<string, string> = {
  governed: GOVERNED_MANIFEST,
  legacy: LEGACY_MANIFEST,
  aliases: ALIAS_MANIFEST
};

const ALLOWED: Record<string, readonly PrimitiveKind[] | undefined> = {
  'all-kinds': undefined,
  'prompt-and-skill': ['prompt', 'skill']
};

describe('characterisation: RepositoryScopeWriter output per manifest', () => {
  for (const [manifestName, manifest] of Object.entries(MANIFESTS)) {
    for (const [allowedName, allowedKinds] of Object.entries(ALLOWED)) {
      it(`${manifestName} manifest, ${allowedName}`, async () => {
        const fs = new InMemoryFileSystem();
        const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });
        const files = bundle(manifest, KIND_FILES);
        const preflight = await writer.preflight(files, allowedKinds);
        const result = await writer.write(files, allowedKinds);
        const write = {
          ...result,
          written: result.written.map((filePath) => toPosix(filePath)),
          skillDirs: result.skillDirs.map((dir) => toPosix(dir))
        };
        const disk = await listFiles(fs, WORKSPACE_ROOT);
        await expect(`${JSON.stringify({ preflight, write, disk }, null, 2)}\n`).toMatchFileSnapshot(
          `./__snapshots__/repo-scope-writer.characterisation/${manifestName}.${allowedName}.json`
        );
      });
    }
  }
});

const SMALL_MANIFEST = `formatVersion: 1
id: small
version: 1.0.0
name: Small
items:
  - { path: prompts/x.prompt.md, kind: prompt, id: x.prompt }
  - { path: skills/foo/SKILL.md, kind: skill, id: foo }
`;

const SMALL_FILES: Record<string, string> = {
  'prompts/x.prompt.md': '# Prompt\n',
  'skills/foo/SKILL.md': '# Skill\n',
  'skills/foo/references/ref.md': '# Reference\n'
};

const localOnlyWriter = (fs: InMemoryFileSystem): RepositoryScopeWriter =>
  new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'local-only' });

/** Exact `.git/info/exclude` text after each step, captured before the refactor. */
const EXCLUDE_EXPECTED: Record<string, (string | null)[]> = {
  writeThenRollback: [
    '# Prompt Registry (local)\n.github/prompts/x.prompt.md\n.github/skills/foo/SKILL.md\n.github/skills/foo/references/ref.md',
    '# Prompt Registry (local)'
  ],
  writeThenRemove: [
    '# Prompt Registry (local)\n.github/prompts/x.prompt.md\n.github/skills/foo/SKILL.md\n.github/skills/foo/references/ref.md',
    '# Prompt Registry (local)'
  ],
  switchCommitMode: [
    null,
    '# Prompt Registry (local)\n.github/prompts/x.prompt.md\n.github/skills/foo/SKILL.md\n.github/skills/foo/references/ref.md',
    '# Prompt Registry (local)'
  ],
  existingWithoutHeader: [
    'node_modules\n\n# Prompt Registry (local)\n.github/skills/foo/references/ref.md\n.github/skills/foo/SKILL.md\n.github/prompts/x.prompt.md'
  ],
  existingWithHeader: [
    'node_modules\n# Prompt Registry (local)\n.github/skills/foo/references/ref.md\n.github/skills/foo/SKILL.md\n.github/prompts/x.prompt.md\n.github/prompts/old.prompt.md\n'
  ],
  emptyWrite: [
    '# Prompt Registry (local)'
  ]
};

describe('characterisation: .git/info/exclude bytes in local-only mode', () => {
  const capture = async (run: (fs: InMemoryFileSystem, steps: (string | null)[]) => Promise<void>, seed?: string) => {
    const fs = new InMemoryFileSystem();
    if (seed !== undefined) {
      fs.seed(EXCLUDE_PATH, seed);
    }
    const steps: (string | null)[] = [];
    await run(fs, steps);
    return steps;
  };

  it('write then rollback', async () => {
    const steps = await capture(async (fs, out) => {
      const writer = localOnlyWriter(fs);
      const result = await writer.write(bundle(SMALL_MANIFEST, SMALL_FILES));
      out.push(await readExclude(fs));
      await writer.rollback(result.written);
      out.push(await readExclude(fs));
    });
    expect(steps).toEqual(EXCLUDE_EXPECTED.writeThenRollback);
  });

  it('write then removeBundleFile for every written bundle path', async () => {
    const steps = await capture(async (fs, out) => {
      const writer = localOnlyWriter(fs);
      const result = await writer.write(bundle(SMALL_MANIFEST, SMALL_FILES));
      out.push(await readExclude(fs));
      for (const bundlePath of result.writtenBundlePaths) {
        await writer.removeBundleFile(bundlePath);
      }
      out.push(await readExclude(fs));
      expect(await listFiles(fs, `${WORKSPACE_ROOT}/.github`)).toEqual({});
    });
    expect(steps).toEqual(EXCLUDE_EXPECTED.writeThenRemove);
  });

  it('switchCommitMode both ways', async () => {
    const steps = await capture(async (fs, out) => {
      const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });
      const result = await writer.write(bundle(SMALL_MANIFEST, SMALL_FILES));
      out.push(await readExclude(fs));
      await writer.switchCommitMode(result.written, 'local-only');
      out.push(await readExclude(fs));
      await writer.switchCommitMode(result.written, 'commit');
      out.push(await readExclude(fs));
    });
    expect(steps).toEqual(EXCLUDE_EXPECTED.switchCommitMode);
  });

  it('write into a pre-existing exclude file without the section header', async () => {
    const steps = await capture(async (fs, out) => {
      await localOnlyWriter(fs).write(bundle(SMALL_MANIFEST, SMALL_FILES));
      out.push(await readExclude(fs));
    }, 'node_modules\n');
    expect(steps).toEqual(EXCLUDE_EXPECTED.existingWithoutHeader);
  });

  it('write into a pre-existing exclude file with the section header', async () => {
    const steps = await capture(async (fs, out) => {
      await localOnlyWriter(fs).write(bundle(SMALL_MANIFEST, SMALL_FILES));
      out.push(await readExclude(fs));
    }, 'node_modules\n# Prompt Registry (local)\n.github/prompts/old.prompt.md\n');
    expect(steps).toEqual(EXCLUDE_EXPECTED.existingWithHeader);
  });

  it('a write that writes nothing still creates the section header', async () => {
    const steps = await capture(async (fs, out) => {
      const result = await localOnlyWriter(fs).write(bundle(SMALL_MANIFEST, {}));
      expect(result.written).toEqual([]);
      out.push(await readExclude(fs));
    });
    expect(steps).toEqual(EXCLUDE_EXPECTED.emptyWrite);
  });
});

describe('directory items without a repository subdirectory', () => {
  interface SubdirectoryLookup {
    getSubdirectory(type: string): string | null;
  }

  it('skips a directory-category item whose kind has no subdirectory, in write and preflight', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });
    const lookup = writer as unknown as SubdirectoryLookup;
    const original = lookup.getSubdirectory.bind(writer);
    vi.spyOn(lookup, 'getSubdirectory').mockImplementation((type) => (type.toLowerCase() === 'plugin' ? null : original(type)));
    const files = bundle(`formatVersion: 1
id: guard
version: 1.0.0
name: Guard
items:
  - { path: plugins/bar/plugin.json, kind: plugin, id: bar }
`, { 'plugins/bar/plugin.json': '{"name":"bar"}\n', 'plugins/bar/skills/s/SKILL.md': '# S\n' });

    expect(await writer.preflight(files)).toEqual({ writable: [], skipped: ['plugins/bar/plugin.json'] });
    const result = await writer.write(files);
    expect(result).toEqual({ written: [], skipped: ['plugins/bar/plugin.json'], skillDirs: [], writtenBundlePaths: [] });
    expect(await listFiles(fs, WORKSPACE_ROOT)).toEqual({});
  });
});

describe('directory items and id prefixes (#552)', () => {
  const PREFIX_MANIFEST = `formatVersion: 1
id: prefixes
version: 1.0.0
name: Prefixes
items:
  - { path: skills/foo/SKILL.md, kind: skill, id: foo }
  - { path: skills/foo-bar/SKILL.md, kind: skill, id: foo-bar }
  - { path: plugins/foo/plugin.json, kind: plugin, id: foo }
  - { path: plugins/foo-bar/plugin.json, kind: plugin, id: foo-bar }
`;
  const PREFIX_FILES: Record<string, string> = {
    'skills/foo/SKILL.md': '# foo\n',
    'skills/foo-bar/SKILL.md': '# foo-bar\n',
    'plugins/foo/plugin.json': '{"name":"foo"}\n',
    'plugins/foo-bar/plugin.json': '{"name":"foo-bar"}\n'
  };
  const target = { name: 't', type: 'vscode', scope: 'repository' } as unknown as Target;

  it('a directory item does not match files of an item whose id it prefixes (#552)', async () => {
    const fs = new InMemoryFileSystem();
    const adapter = new RepositoryScopeWriterAdapter(
      new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' })
    );
    const result = await adapter.write(target, bundle(PREFIX_MANIFEST, PREFIX_FILES));

    expect(await fs.exists('/workspace/.github/skills/foo/-bar/SKILL.md')).toBe(false);
    expect(await fs.exists('/workspace/.github/plugins/foo/-bar/plugin.json')).toBe(false);
    const recorded = result.writtenBundlePaths ?? [];
    expect(recorded.toSorted()).toEqual([...new Set(recorded)].toSorted());
    expect(await listFiles(fs, `${WORKSPACE_ROOT}/.github`)).toEqual({
      '/workspace/.github/plugins/foo-bar/plugin.json': '{"name":"foo-bar"}\n',
      '/workspace/.github/plugins/foo/plugin.json': '{"name":"foo"}\n',
      '/workspace/.github/skills/foo-bar/SKILL.md': '# foo-bar\n',
      '/workspace/.github/skills/foo/SKILL.md': '# foo\n'
    });

    for (const bundlePath of recorded) {
      await adapter.remove(target, bundlePath);
    }
    expect(await listFiles(fs, `${WORKSPACE_ROOT}/.github`)).toEqual({});
  });
});
