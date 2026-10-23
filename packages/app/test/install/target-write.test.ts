/**
 * Tests for manifest-driven bundle placement (`writeBundleSafely`,
 * `manifestPlacementItems`).
 */
import * as path from 'node:path';
import type {
  Target,
  ValidatedManifest,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  manifestPlacementItems,
  TargetWriteRejectedError,
  writeBundleSafely,
} from '../../src/install/target-write';
import {
  FileTreeTargetWriter,
} from '../../src/writers/file-tree-writer';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

const localPath = (...segments: string[]): string => path.join(...segments);
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const env = { HOME: '/home/u' };

/** A Copilot-layout bundle: every file lives under `.github/`. */
const copilotBundle = (): Map<string, Uint8Array> => new Map([
  ['deployment-manifest.yml', text('id: sample-skills\n')],
  ['.github/skills/sample-skill/SKILL.md', text('---\nname: sample-skill\n---\n# Skill')],
  ['.github/skills/sample-skill/references/notes.md', text('# Notes')],
  ['.github/instructions/sample-rules.instructions.md', text('# Rules')],
  ['.github/copilot-instructions.md', text('# Workspace policy')]
]);

const copilotManifest = (): ValidatedManifest => ({
  id: 'sample-skills',
  version: '1.0.0',
  name: 'Sample Skills',
  prompts: [
    { id: 'sample-skill', name: 'Skill', file: '.github/skills/sample-skill/SKILL.md', type: 'skill' },
    {
      id: 'sample-rules.instructions',
      name: 'Rules',
      file: '.github/instructions/sample-rules.instructions.md',
      type: 'instructions'
    },
    { id: 'copilot-instructions', name: 'Policy', file: '.github/copilot-instructions.md', type: 'instructions' }
  ],
  mcpServers: { 'sample-server': { type: 'http', url: 'https://example.invalid/sse' } }
});

describe('manifestPlacementItems', () => {
  it('keeps file-backed Copilot items and drops entries without a file or with a non-Copilot type', () => {
    const items = manifestPlacementItems({
      id: 'sample-skills',
      version: '1.0.0',
      name: 'Sample',
      prompts: [
        { id: 'a', file: 'prompts/a.prompt.md', type: 'prompt' },
        { id: 'b', file: 'hooks/b.json', type: 'hook' },
        { id: 'c', type: 'prompt' },
        { id: 42, file: 'prompts/42.md' }
      ]
    });

    expect(items).toEqual([
      { id: 'a', file: 'prompts/a.prompt.md', type: 'prompt' },
      { id: '42', file: 'prompts/42.md' }
    ]);
  });

  it('drops a trailing type marker from ids so names are not doubled', () => {
    const items = manifestPlacementItems(copilotManifest());

    expect(items.map((item) => item.id)).toEqual(['sample-skill', 'sample-rules', 'copilot-instructions']);
  });

  it('returns no items when the manifest has no prompts list', () => {
    expect(manifestPlacementItems({ id: 'sample-skills', version: '1.0.0', name: 'Sample' })).toEqual([]);
  });
});

describe('writeBundleSafely', () => {
  it('places a Copilot-layout bundle by type on a Kiro user target', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env });
    const target: Target = { name: 'kiro-ide', type: 'kiro', scope: 'user' };
    const kiroDir = localPath('/home/u', '.kiro');

    const { result, installableFiles } = await writeBundleSafely(writer, target, copilotBundle(), copilotManifest());

    expect(result.written.toSorted()).toEqual([
      localPath(kiroDir, 'skills', 'sample-skill', 'SKILL.md'),
      localPath(kiroDir, 'skills', 'sample-skill', 'references', 'notes.md'),
      localPath(kiroDir, 'steering', 'sample-rules.instructions.md'),
      localPath(kiroDir, 'steering', 'copilot-instructions.instructions.md')
    ].toSorted());
    expect(result.writtenBundlePaths?.toSorted()).toEqual([...installableFiles.keys()]
      .filter((p) => p !== 'deployment-manifest.yml')
      .toSorted());
    expect(result.installedPaths?.['.github/copilot-instructions.md']).toBe('steering/copilot-instructions.instructions.md');
    expect(await fs.readFile(localPath(kiroDir, 'steering', 'copilot-instructions.instructions.md'))).toBe('# Workspace policy');
    expect(await fs.exists(localPath(kiroDir, 'deployment-manifest.yml'))).toBe(false);
  });

  it('places the same bundle under the workspace .kiro directory for repository scope', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env });
    const target: Target = { name: 'kiro-repo', type: 'kiro', scope: 'repository', rootPath: '/ws' };

    const { result } = await writeBundleSafely(writer, target, copilotBundle(), copilotManifest());

    expect(result.written).toContain(localPath('/ws', '.kiro', 'skills', 'sample-skill', 'SKILL.md'));
    expect(result.written).toContain(localPath('/ws', '.kiro', 'steering', 'sample-rules.instructions.md'));
  });

  it('installs the same bundle into a VS Code user target', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env });
    const target: Target = { name: 'vsc', type: 'vscode', scope: 'user' };
    const copilotDir = localPath('/home/u', '.copilot');

    const { result } = await writeBundleSafely(writer, target, copilotBundle(), copilotManifest());

    expect(result.written).toContain(localPath(copilotDir, 'skills', 'sample-skill', 'references', 'notes.md'));
    expect(result.written).toContain(localPath(copilotDir, 'instructions', 'sample-rules.instructions.md'));
    expect(result.written).toContain(localPath(copilotDir, 'instructions', 'copilot-instructions.instructions.md'));
  });

  it('rejects before writing when allowedKinds excludes a listed item', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env });
    const target: Target = { name: 'kiro-ide', type: 'kiro', scope: 'user', allowedKinds: ['skill'] };

    await expect(writeBundleSafely(writer, target, copilotBundle(), copilotManifest()))
      .rejects.toBeInstanceOf(TargetWriteRejectedError);
    expect(await fs.exists(localPath('/home/u', '.kiro', 'skills', 'sample-skill', 'SKILL.md'))).toBe(false);
  });

  it('rejects before writing when a file no item covers cannot be routed', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env });
    const target: Target = { name: 'kiro-ide', type: 'kiro', scope: 'user' };
    const files = copilotBundle();
    files.set('.github/hooks/extra.json', text('{}'));

    const error = await writeBundleSafely(writer, target, files, copilotManifest()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TargetWriteRejectedError);
    expect((error as TargetWriteRejectedError).skipped).toEqual(['.github/hooks/extra.json']);
    expect(await fs.exists(localPath('/home/u', '.kiro', 'skills', 'sample-skill', 'SKILL.md'))).toBe(false);
  });

  it('rejects before writing when two items map to the same destination', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env });
    const target: Target = { name: 'kiro-ide', type: 'kiro', scope: 'user' };
    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', text('id: sample-rules\n')],
      ['instructions/alpha.md', text('# Alpha')],
      ['instructions/alpha.instructions.md', text('# Alpha instructions')]
    ]);
    const manifest: ValidatedManifest = {
      id: 'sample-rules',
      version: '1.0.0',
      name: 'Sample Rules',
      prompts: [
        { id: 'alpha', name: 'Alpha', file: 'instructions/alpha.md', type: 'instructions' },
        { id: 'alpha.instructions', name: 'Alpha 2', file: 'instructions/alpha.instructions.md', type: 'instructions' }
      ]
    };

    const error = await writeBundleSafely(writer, target, files, manifest).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TargetWriteRejectedError);
    expect((error as TargetWriteRejectedError).code).toBe('BUNDLE.UNSUPPORTED_CONTENT');
    expect((error as TargetWriteRejectedError).skipped).toEqual(['instructions/alpha.instructions.md']);
    expect(await fs.exists(localPath('/home/u', '.kiro', 'steering', 'alpha.instructions.md'))).toBe(false);
  });

  it.each(['../../.bashrc-x', 'sub/escape', '..\\evil', '..'])(
    'rejects before writing when an item id would leave the target directory (%s)',
    async (id) => {
      const fs = new InMemoryFileSystem();
      const writer = new FileTreeTargetWriter({ fs, env });
      const target: Target = { name: 'kiro-ide', type: 'kiro', scope: 'user' };
      const files = new Map<string, Uint8Array>([
        ['deployment-manifest.yml', text('id: sample-rules\n')],
        ['instructions/a.md', text('# A')]
      ]);
      const manifest: ValidatedManifest = {
        id: 'sample-rules',
        version: '1.0.0',
        name: 'Sample Rules',
        prompts: [{ id, name: 'A', file: 'instructions/a.md', type: 'instructions' }]
      };

      const error = await writeBundleSafely(writer, target, files, manifest).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TargetWriteRejectedError);
      expect((error as TargetWriteRejectedError).skipped).toEqual(['instructions/a.md']);
      const steering = localPath('/home/u', '.kiro', 'steering');
      expect(await fs.exists(localPath(steering, `${id}.instructions.md`))).toBe(false);
      expect(await fs.exists(localPath('/home/u', '.bashrc-x.instructions.md'))).toBe(false);
    }
  );

  it('places a skill item whose file names the skill directory', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env });
    const target: Target = { name: 'kiro-ide', type: 'kiro', scope: 'user' };
    const kiroDir = localPath('/home/u', '.kiro');
    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', text('id: sample-skills\n')],
      ['.github/skills/foo/SKILL.md', text('# Foo')],
      ['.github/skills/foo/references/notes.md', text('# Notes')]
    ]);
    const manifest: ValidatedManifest = {
      id: 'sample-skills',
      version: '1.0.0',
      name: 'Sample Skills',
      prompts: [{ id: 'renamed-foo', name: 'Foo', file: '.github/skills/foo', type: 'skill' }]
    };

    const { result } = await writeBundleSafely(writer, target, files, manifest);

    expect(result.written.toSorted()).toEqual([
      localPath(kiroDir, 'skills', 'renamed-foo', 'SKILL.md'),
      localPath(kiroDir, 'skills', 'renamed-foo', 'references', 'notes.md')
    ].toSorted());
    expect(result.installedPaths?.['.github/skills/foo/SKILL.md']).toBe('skills/renamed-foo/SKILL.md');
  });

  it('keeps path routing for a bundle whose manifest lists no items', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env });
    const target: Target = { name: 'kiro-ide', type: 'kiro', scope: 'user' };
    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', text('id: sample-collections\n')],
      ['skills/source-name/SKILL.md', text('# Skill')],
      ['instructions/own-name.md', text('# Rules')]
    ]);

    const { result } = await writeBundleSafely(writer, target, files, {
      id: 'sample-collections', version: '1.0.0', name: 'Sample'
    });

    expect(result.written.toSorted()).toEqual([
      localPath('/home/u', '.kiro', 'skills', 'source-name', 'SKILL.md'),
      localPath('/home/u', '.kiro', 'steering', 'own-name.md')
    ].toSorted());
    expect(result.installedPaths).toBeUndefined();
  });
});
