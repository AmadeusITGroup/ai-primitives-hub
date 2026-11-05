/**
 * Tests for infra/writers/repo-scope-writer.ts.
 *
 * Ported from the reference branch's real-tempdir-backed test to use
 * this suite's established `InMemoryFileSystem` double instead (per
 * `test/AGENTS.md`'s "test behavior not implementation" rule — same
 * assertions, faster + no real disk IO).
 */
import {
  statSync,
} from 'node:fs';
import * as path from 'node:path';
import type {
  Target,
} from '@ai-primitives-hub/core';
import {
  withFileMode,
} from '@ai-primitives-hub/core';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  createGovernedReleaseArchive,
  createLegacyReleaseArchive,
} from '../../../core/test/fixtures/release-archives';
import {
  NodeFileSystem,
} from '../../src/fs/node-filesystem';
import {
  RepositoryScopeWriter,
  RepositoryScopeWriterAdapter,
} from '../../src/writers/repo-scope-writer';
import {
  seedGitDir,
} from '../helpers/git-dir';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';
import {
  createTempDir,
} from '../helpers/temp-dir';

const WORKSPACE_ROOT = '/workspace';

const SAMPLE_MANIFEST = `id: test-bundle
version: 1.0.0
name: Test Bundle
description: A test bundle
prompts:
  - id: test-prompt
    file: prompts/test.md
    type: prompt
instructions:
  - id: test-instruction
    file: instructions/test.md
    type: instruction
agents:
  - id: test-agent
    file: agents/test.md
    type: agent
skills:
  - id: test-skill
    file: skills/test-skill/skill.json
    type: skill`;

/** In-memory filesystem whose workspace is a git repository. */
const gitWorkspaceFs = (): InMemoryFileSystem => {
  const fs = new InMemoryFileSystem();
  seedGitDir(fs, path.join(WORKSPACE_ROOT, '.git'));
  return fs;
};

describe('RepositoryScopeWriter', () => {
  it('writes prompts to .github/prompts/', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });

    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', new TextEncoder().encode(SAMPLE_MANIFEST)],
      ['prompts/test.md', new TextEncoder().encode('# Test Prompt')]
    ]);

    const result = await writer.write(files);

    const expected = path.join(WORKSPACE_ROOT, '.github', 'prompts', 'test.md');
    expect(result.written).toContain(expected);
    expect(await fs.exists(expected)).toBe(true);
  });

  it('writes canonical collection items to the repository target', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });

    const manifest = `id: collection-bundle
version: 1.0.0
name: Collection Bundle
items:
  - path: prompts/hello.prompt.md
    kind: prompt`;
    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', new TextEncoder().encode(manifest)],
      ['prompts/hello.prompt.md', new TextEncoder().encode('# Hello')]
    ]);

    const result = await writer.write(files);

    const expected = path.join(WORKSPACE_ROOT, '.github', 'prompts', 'hello.prompt.md');
    expect(result.written).toContain(expected);
    expect(await fs.exists(expected)).toBe(true);
  });

  it('uses canonical items once for governed manifests with a legacy projection', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });
    const manifest = `formatVersion: 1
id: collection-bundle
version: 1.0.0
name: Collection Bundle
items:
  - id: hello
    path: prompts/hello.prompt.md
    kind: prompt
prompts:
  - id: hello
    file: prompts/hello.prompt.md
    type: prompt`;
    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', new TextEncoder().encode(manifest)],
      ['prompts/hello.prompt.md', new TextEncoder().encode('# Hello')]
    ]);

    const result = await writer.write(files);

    expect(result.writtenBundlePaths).toEqual(['prompts/hello.prompt.md']);
    expect(result.written).toHaveLength(1);
  });

  it('routes the complete legacy archive fixture through its legacy projection', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });

    const result = await writer.write(createLegacyReleaseArchive({ id: 'legacy-bundle' }));

    expect(result.writtenBundlePaths).toEqual(['prompts/hello.prompt.md']);
    expect(result.written).toEqual([
      path.join(WORKSPACE_ROOT, '.github', 'prompts', 'hello.prompt.md')
    ]);
  });

  it('routes only canonical installable items from the complete governed archive fixture', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });

    const result = await writer.write(createGovernedReleaseArchive({ id: 'governed-bundle' }));

    expect(result.writtenBundlePaths).toEqual(['prompts/hello.prompt.md']);
    expect(result.written).toEqual([
      path.join(WORKSPACE_ROOT, '.github', 'prompts', 'hello.prompt.md')
    ]);
  });

  it('writes instructions to .github/instructions/', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });

    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', new TextEncoder().encode(SAMPLE_MANIFEST)],
      ['instructions/test.md', new TextEncoder().encode('# Test Instruction')]
    ]);

    const result = await writer.write(files);

    const expected = path.join(WORKSPACE_ROOT, '.github', 'instructions', 'test.md');
    expect(result.written).toContain(expected);
    expect(await fs.exists(expected)).toBe(true);
  });

  it('writes instructions with plural "instructions" type to .github/instructions/', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });

    const manifest = `id: test-bundle
version: 1.0.0
name: Test
instructions:
  - id: test-instruction
    file: instructions/test.md
    type: instructions`;

    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', new TextEncoder().encode(manifest)],
      ['instructions/test.md', new TextEncoder().encode('# Test Instruction')]
    ]);

    const result = await writer.write(files);

    const expected = path.join(WORKSPACE_ROOT, '.github', 'instructions', 'test.md');
    expect(result.written).toContain(expected);
    expect(await fs.exists(expected)).toBe(true);
  });

  it('writes chatmode items to .github/agents/', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });
    const manifest = `id: test-bundle
version: 1.0.0
name: Test
prompts:
  - id: review-mode
    file: chat-modes/review.chatmode.md
    type: chatmode`;
    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', new TextEncoder().encode(manifest)],
      ['chat-modes/review.chatmode.md', new TextEncoder().encode('# Review')]
    ]);

    const result = await writer.write(files);

    const expected = path.join(WORKSPACE_ROOT, '.github', 'agents', 'review.chatmode.md');
    expect(result.written).toContain(expected);
    expect(await fs.exists(expected)).toBe(true);
  });

  it('writes agents to .github/agents/', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });
    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', new TextEncoder().encode(SAMPLE_MANIFEST)],
      ['agents/test.md', new TextEncoder().encode('# Test Agent')]
    ]);

    const result = await writer.write(files);

    const expected = path.join(WORKSPACE_ROOT, '.github', 'agents', 'test.md');
    expect(result.written).toContain(expected);
    expect(await fs.exists(expected)).toBe(true);
  });

  it('writes skills to .github/skills/<skill-id>/', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });

    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', new TextEncoder().encode(SAMPLE_MANIFEST)],
      ['skills/test-skill/skill.json', new TextEncoder().encode('{"name": "Test Skill"}')],
      ['skills/test-skill/api.ts', new TextEncoder().encode('// API code')]
    ]);

    const result = await writer.write(files);

    const skillDir = path.join(WORKSPACE_ROOT, '.github', 'skills', 'test-skill');
    expect(result.skillDirs).toContain(skillDir);
    expect(await fs.exists(path.join(skillDir, 'skill.json'))).toBe(true);
    expect(await fs.exists(path.join(skillDir, 'api.ts'))).toBe(true);
  });

  it('returns empty result when manifest is missing', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });

    const files = new Map<string, Uint8Array>([
      ['prompts/test.md', new TextEncoder().encode('# Test Prompt')]
    ]);

    const result = await writer.write(files);

    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.skillDirs).toEqual([]);
  });

  it('adds files to .git/info/exclude in local-only mode', async () => {
    const fs = gitWorkspaceFs();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'local-only' });

    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', new TextEncoder().encode(SAMPLE_MANIFEST)],
      ['prompts/test.md', new TextEncoder().encode('# Test Prompt')]
    ]);

    await writer.write(files);

    const excludePath = path.join(WORKSPACE_ROOT, '.git', 'info', 'exclude');
    expect(await fs.exists(excludePath)).toBe(true);
    expect(await fs.readFile(excludePath)).toContain('# Prompt Registry (local)');
  });

  it('does not add files to .git/info/exclude in commit mode', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });

    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', new TextEncoder().encode(SAMPLE_MANIFEST)],
      ['prompts/test.md', new TextEncoder().encode('# Test Prompt')]
    ]);

    await writer.write(files);

    const excludePath = path.join(WORKSPACE_ROOT, '.git', 'info', 'exclude');
    expect(await fs.exists(excludePath)).toBe(false);
  });

  it('removes a single file through its repository route', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });

    const routed = path.join(WORKSPACE_ROOT, '.github', 'prompts', 'test.md');
    const unrouted = path.join(WORKSPACE_ROOT, '.github', 'copilot', 'prompts', 'test.md');
    fs.seed(routed, '# Test');
    fs.seed(unrouted, '# Test');

    await writer.removeFile('prompts/test.md');
    await writer.removeFile('copilot/prompts/test.md');

    expect(await fs.exists(routed)).toBe(false);
    expect(await fs.exists(unrouted)).toBe(true);
  });

  it('removes a bundle-relative prompt path from the repository output route', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });

    const testFile = path.join(WORKSPACE_ROOT, '.github', 'prompts', 'test.md');
    fs.seed(testFile, '# Test');

    await writer.removeBundleFile('prompts/test.md');

    expect(await fs.exists(testFile)).toBe(false);
  });

  it('removes bundle files from their Copilot repository directories', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });
    const files = [
      ['instructions/test.instructions.md', '.github/instructions/test.instructions.md'],
      ['agents/test.agent.md', '.github/agents/test.agent.md'],
      ['skills/demo/SKILL.md', '.github/skills/demo/SKILL.md']
    ] as const;

    for (const [bundlePath, repositoryPath] of files) {
      const targetPath = path.join(WORKSPACE_ROOT, repositoryPath);
      fs.seed(targetPath, '# Test');

      await writer.removeBundleFile(bundlePath);

      expect(await fs.exists(targetPath)).toBe(false);
    }
  });

  it('removes files for a bundle from manifest', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });

    const promptFile = path.join(WORKSPACE_ROOT, '.github', 'prompts', 'test.md');
    fs.seed(promptFile, '# Test');

    const manifest = {
      id: 'test-bundle',
      prompts: [{ id: 'test-prompt', file: 'prompts/test.md', type: 'prompt' }]
    };

    await writer.remove('test-bundle', manifest);

    expect(await fs.exists(promptFile)).toBe(false);
  });

  it('removes governed canonical items without relying on legacy projections', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });
    const promptFile = path.join(WORKSPACE_ROOT, '.github', 'prompts', 'governed.md');
    fs.seed(promptFile, '# Governed');

    await writer.remove('governed-bundle', {
      formatVersion: 1,
      items: [{ id: 'governed', path: 'prompts/governed.md', kind: 'prompt' }]
    });

    expect(await fs.exists(promptFile)).toBe(false);
  });

  it('removes skill directories', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });

    const skillDir = path.join(WORKSPACE_ROOT, '.github', 'skills', 'test-skill');
    fs.seed(path.join(skillDir, 'skill.json'), '{"name": "Test"}');

    const manifest = {
      id: 'test-bundle',
      skills: [{ id: 'test-skill', file: 'skills/test-skill/skill.json', type: 'skill' }]
    };

    await writer.remove('test-bundle', manifest);

    expect(await fs.exists(skillDir)).toBe(false);
  });

  it('removes from .git/info/exclude in local-only mode', async () => {
    const fs = gitWorkspaceFs();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'local-only' });

    const excludePath = path.join(WORKSPACE_ROOT, '.git', 'info', 'exclude');
    fs.seed(excludePath, '# Prompt Registry (local)\n.github/prompts/test.md');

    const manifest = {
      id: 'test-bundle',
      prompts: [{ id: 'test-prompt', file: 'prompts/test.md', type: 'prompt' }]
    };

    await writer.remove('test-bundle', manifest);

    const content = await fs.readFile(excludePath);
    expect(content).not.toContain('.github/prompts/test.md');
  });

  it('switches commit mode from commit to local-only', async () => {
    const fs = gitWorkspaceFs();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });

    const paths = [path.join(WORKSPACE_ROOT, '.github', 'prompts', 'test.md')];

    await writer.switchCommitMode(paths, 'local-only');

    const excludePath = path.join(WORKSPACE_ROOT, '.git', 'info', 'exclude');
    expect(await fs.exists(excludePath)).toBe(true);
  });

  it('switches commit mode from local-only to commit', async () => {
    const fs = gitWorkspaceFs();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'local-only' });

    const paths = [path.join(WORKSPACE_ROOT, '.github', 'prompts', 'test.md')];
    await writer.switchCommitMode(paths, 'local-only');
    await writer.switchCommitMode(paths, 'commit');

    const excludePath = path.join(WORKSPACE_ROOT, '.git', 'info', 'exclude');
    const content = await fs.readFile(excludePath);
    expect(content).not.toContain('.github/prompts/test.md');
  });

  it('sanitizes skill IDs', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });

    const manifest = `id: test-bundle
skills:
  - id: My_Skill_123
    file: skills/My_Skill_123/skill.json
    type: skill`;

    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', new TextEncoder().encode(manifest)],
      ['skills/My_Skill_123/skill.json', new TextEncoder().encode('{"name": "Test"}')]
    ]);

    const result = await writer.write(files);

    expect(result.skillDirs).toContain(path.join(WORKSPACE_ROOT, '.github', 'skills', 'my-skill-123'));
  });

  it('writes skill with ID override from manifest', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });

    const manifest = `id: test-bundle
skills:
  - id: custom-skill-id
    file: skills/source-skill/skill.json
    type: skill`;

    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', new TextEncoder().encode(manifest)],
      ['skills/source-skill/skill.json', new TextEncoder().encode('{"name": "Test"}')],
      ['skills/source-skill/api.ts', new TextEncoder().encode('// code')]
    ]);

    const result = await writer.write(files);

    // The skill ID is extracted from the file path (source-skill), not from the manifest id field
    const skillDir = path.join(WORKSPACE_ROOT, '.github', 'skills', 'source-skill');
    expect(result.skillDirs).toContain(skillDir);
    expect(await fs.exists(path.join(skillDir, 'skill.json'))).toBe(true);
  });

  it('handles removal when git/info/exclude does not exist', async () => {
    const fs = gitWorkspaceFs();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'local-only' });

    const manifest = {
      id: 'test-bundle',
      prompts: [{ id: 'test-prompt', file: 'prompts/test.md', type: 'prompt' }]
    };

    // Should not throw even though .git/info/exclude doesn't exist
    await expect(writer.remove('test-bundle', manifest)).resolves.not.toThrow();
  });

  it('handles removal when git/info/exclude has no Prompt Registry section', async () => {
    const fs = gitWorkspaceFs();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'local-only' });

    const excludePath = path.join(WORKSPACE_ROOT, '.git', 'info', 'exclude');
    fs.seed(excludePath, 'other/exclude\n');

    const manifest = {
      id: 'test-bundle',
      prompts: [{ id: 'test-prompt', file: 'prompts/test.md', type: 'prompt' }]
    };

    await expect(writer.remove('test-bundle', manifest)).resolves.not.toThrow();
  });

  it('handles unknown item types gracefully', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });

    const manifest = `id: test-bundle
prompts:
  - id: test-prompt
    file: prompts/test.md
    type: unknown-type`;

    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', new TextEncoder().encode(manifest)]
    ]);

    const result = await writer.write(files);

    // Unknown types should be skipped
    expect(result.written).toEqual([]);
  });

  it('writes binary skill assets byte-for-byte (issue #357)', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });

    // Zip local-header magic followed by bytes that are NOT valid UTF-8;
    // a lossy TextDecoder round-trip would replace them with U+FFFD.
    const binaryBytes = new Uint8Array([0x50, 0x4B, 0x03, 0x04, 0xFF, 0xFE, 0x00, 0x9D, 0xC7, 0x80]);
    const manifest = `id: test-bundle
skills:
  - id: deck-skill
    file: skills/deck-skill/SKILL.md
    type: skill`;

    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', new TextEncoder().encode(manifest)],
      ['skills/deck-skill/SKILL.md', new TextEncoder().encode('# Deck skill')],
      ['skills/deck-skill/assets/template.pptx', binaryBytes]
    ]);

    const result = await writer.write(files);

    const installedPath = path.join(WORKSPACE_ROOT, '.github', 'skills', 'deck-skill', 'assets', 'template.pptx');
    expect(result.written).toContain(installedPath);
    expect(await fs.readFileBytes(installedPath)).toEqual(binaryBytes);
  });

  it('writes binary manifest items byte-for-byte', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });

    const binaryBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0xFF, 0xD8, 0x00, 0xC0]);
    const manifest = `id: test-bundle
hooks:
  - id: binary-hook
    file: hooks/tool.bin
    type: hook`;

    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', new TextEncoder().encode(manifest)],
      ['hooks/tool.bin', binaryBytes]
    ]);

    await writer.write(files);

    const installedPath = path.join(WORKSPACE_ROOT, '.github', 'hooks', 'tool.bin');
    expect(await fs.readFileBytes(installedPath)).toEqual(binaryBytes);
  });

  it('handles file paths with special characters', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });

    const manifest = `id: test-bundle
prompts:
  - id: test-prompt
    file: prompts/test-file.md
    type: prompt`;

    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', new TextEncoder().encode(manifest)],
      ['prompts/test-file.md', new TextEncoder().encode('# Test')]
    ]);

    const result = await writer.write(files);

    expect(result.written.length).toBeGreaterThan(0);
  });
});

describe('RepositoryScopeWriterAdapter', () => {
  const dummyTarget = { name: 't', type: 'vscode', scope: 'repository' } as unknown as Target;

  it('adapts RepositoryScopeWriter to TargetWriter interface', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });
    const adapter = new RepositoryScopeWriterAdapter(writer);

    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', new TextEncoder().encode(SAMPLE_MANIFEST)],
      ['prompts/test.md', new TextEncoder().encode('# Test Prompt')]
    ]);

    const result = await adapter.write(dummyTarget, files);

    expect(result.written.length).toBeGreaterThan(0);
    expect(await fs.exists(path.join(WORKSPACE_ROOT, '.github', 'prompts', 'test.md'))).toBe(true);
  });

  it('reports a file it replaced and restores it on rollback, removing the files it created', async () => {
    const fs = new InMemoryFileSystem();
    const adapter = new RepositoryScopeWriterAdapter(new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' }));
    const prompt = path.join(WORKSPACE_ROOT, '.github', 'prompts', 'test.md');
    fs.seed(prompt, 'user work\n');
    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', new TextEncoder().encode(SAMPLE_MANIFEST)],
      ['prompts/test.md', new TextEncoder().encode('# Test Prompt')],
      ['agents/test.md', new TextEncoder().encode('# Test Agent')]
    ]);

    const result = await adapter.write(dummyTarget, files);
    expect(Object.keys(result.replaced ?? {})).toEqual([prompt]);

    await adapter.rollback(dummyTarget, result.written, result.replaced);
    expect(await fs.readFile(prompt)).toBe('user work\n');
    expect(await fs.exists(path.join(WORKSPACE_ROOT, '.github', 'agents', 'test.md'))).toBe(false);
  });

  it('removes nothing for a path with no repository route', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });
    const adapter = new RepositoryScopeWriterAdapter(writer);

    const testFile = path.join(WORKSPACE_ROOT, '.github', 'copilot', 'prompts', 'test.md');
    fs.seed(testFile, '# Test');

    await adapter.remove(dummyTarget, 'copilot/prompts/test.md');

    expect(await fs.exists(testFile)).toBe(true);
  });

  it('translates bundle-relative paths during pipeline removal', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });
    const adapter = new RepositoryScopeWriterAdapter(writer);

    const testFile = path.join(WORKSPACE_ROOT, '.github', 'prompts', 'test.md');
    fs.seed(testFile, '# Test');

    await adapter.remove(dummyTarget, 'prompts/test.md');

    expect(await fs.exists(testFile)).toBe(false);
  });

  it('handles non-existent file removal gracefully', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });
    const adapter = new RepositoryScopeWriterAdapter(writer);

    await expect(adapter.remove(dummyTarget, 'copilot/prompts/nonexistent.md')).resolves.not.toThrow();
  });
});

describe('RepositoryScopeWriter recorded placements', () => {
  const target = { name: 't', type: 'vscode', scope: 'repository', rootPath: WORKSPACE_ROOT } as unknown as Target;
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
  const github = (...segments: string[]): string => path.join(WORKSPACE_ROOT, '.github', ...segments);

  const governed = (items: string): Map<string, Uint8Array> => new Map([
    ['deployment-manifest.yml', encode(`formatVersion: 1\nid: placements\nversion: 1.0.0\nname: Placements\nitems:\n${items}`)]
  ]);

  const CASES: {
    name: string;
    files: Map<string, Uint8Array>;
    expected: Record<string, { written: string; installedPath?: string }>;
  }[] = [
    {
      name: 'a nested prompt is flattened',
      files: new Map([...governed('  - { path: prompts/sub/a.prompt.md, kind: prompt }\n'),
        ['prompts/sub/a.prompt.md', encode('# A\n')]]),
      expected: { 'prompts/sub/a.prompt.md': { written: github('prompts', 'a.prompt.md'), installedPath: 'prompts/a.prompt.md' } }
    },
    {
      name: 'an agent below prompts/ goes to agents/',
      files: new Map([...governed('  - { path: prompts/x.agent.md, kind: agent }\n'),
        ['prompts/x.agent.md', encode('# X\n')]]),
      expected: { 'prompts/x.agent.md': { written: github('agents', 'x.agent.md'), installedPath: 'agents/x.agent.md' } }
    },
    {
      name: 'a plugin whose id differs from its directory',
      files: new Map([...governed('  - { path: plugins/src-dir/plugin.json, kind: plugin, id: demo }\n'),
        ['plugins/src-dir/plugin.json', encode('{}\n')],
        ['plugins/src-dir/scripts/run.sh', encode('echo\n')]]),
      expected: {
        'plugins/src-dir/plugin.json': { written: github('plugins', 'demo', 'plugin.json'), installedPath: 'plugins/demo/plugin.json' },
        'plugins/src-dir/scripts/run.sh': {
          written: github('plugins', 'demo', 'scripts', 'run.sh'),
          installedPath: 'plugins/demo/scripts/run.sh'
        }
      }
    },
    {
      name: 'a plugin directory with a sanitised id',
      files: new Map([...governed('  - { path: plugins/My_Plugin/plugin.json, kind: plugin }\n'),
        ['plugins/My_Plugin/plugin.json', encode('{}\n')]]),
      expected: {
        'plugins/My_Plugin/plugin.json': { written: github('plugins', 'my-plugin', 'plugin.json'), installedPath: 'plugins/my-plugin/plugin.json' }
      }
    },
    {
      name: 'a top-level prompt',
      files: new Map([...governed('  - { path: prompts/a.prompt.md, kind: prompt }\n'),
        ['prompts/a.prompt.md', encode('# A\n')]]),
      expected: { 'prompts/a.prompt.md': { written: github('prompts', 'a.prompt.md') } }
    },
    {
      name: 'a skill whose id equals its directory',
      files: new Map([...governed('  - { path: skills/demo/SKILL.md, kind: skill, id: demo }\n'),
        ['skills/demo/SKILL.md', encode('# Demo\n')]]),
      expected: { 'skills/demo/SKILL.md': { written: github('skills', 'demo', 'SKILL.md') } }
    }
  ];

  it.each(CASES)('records, locates and removes $name', async ({ files, expected }) => {
    const fs = new InMemoryFileSystem();
    const adapter = new RepositoryScopeWriterAdapter(
      new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' })
    );

    const result = await adapter.write(target, files);

    const bundlePaths = result.writtenBundlePaths ?? [];
    expect(bundlePaths.toSorted()).toEqual(Object.keys(expected).toSorted());
    const expectedInstalledPaths = Object.fromEntries(Object.entries(expected)
      .filter(([, value]) => value.installedPath !== undefined)
      .map(([bundlePath, value]) => [bundlePath, value.installedPath]));
    expect(result.installedPaths ?? {}).toEqual(expectedInstalledPaths);

    const recorded = bundlePaths.map((bundlePath) => ({
      path: bundlePath,
      ...(result.installedPaths?.[bundlePath] === undefined ? {} : { installedPath: result.installedPaths[bundlePath] })
    }));
    const located = await adapter.locate(target, recorded);
    expect(located.root).toBe(github());
    expect(located.paths).toEqual(bundlePaths.map((bundlePath) => expected[bundlePath].written));
    expect(located.paths).toEqual(result.written);

    for (const file of recorded) {
      await adapter.remove(target, file.path, file.installedPath);
    }
    for (const written of result.written) {
      expect(await fs.exists(written)).toBe(false);
    }
  });

  it('never removes a recorded path outside .github or with no route', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });
    const outside = path.resolve(WORKSPACE_ROOT, '..', 'outside');
    const readme = path.join(WORKSPACE_ROOT, 'README.md');
    fs.seed(outside, 'sentinel');
    fs.seed(readme, 'sentinel');

    await writer.removeBundleFile('../../outside');
    await writer.removeBundleFile('../outside');
    await writer.removeBundleFile('README.md');
    await new RepositoryScopeWriterAdapter(writer).remove(target, 'prompts/x.md', '../../outside');

    expect(await fs.exists(outside)).toBe(true);
    expect(await fs.exists(readme)).toBe(true);
  });

  it('still removes a legacy workspace-relative .github entry', async () => {
    const fs = new InMemoryFileSystem();
    const adapter = new RepositoryScopeWriterAdapter(
      new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' })
    );
    const legacy = github('prompts', 'x.prompt.md');
    fs.seed(legacy, '# X');

    expect((await adapter.locate(target, [{ path: '.github/prompts/x.prompt.md' }])).paths).toEqual([legacy]);
    await adapter.remove(target, '.github/prompts/x.prompt.md');

    expect(await fs.exists(legacy)).toBe(false);
  });

  it('locates an unrouted or escaping record as null', async () => {
    const adapter = new RepositoryScopeWriterAdapter(
      new RepositoryScopeWriter({ fs: new InMemoryFileSystem(), workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' })
    );

    const located = await adapter.locate(target, [
      { path: 'README.md' },
      { path: '../outside' },
      { path: 'prompts/a.md', installedPath: '/abs/a.md' }
    ]);

    expect(located.paths).toEqual([null, null, null]);
  });
});

describe('RepositoryScopeWriter executable bits (#577)', () => {
  const unixOnly = it.skipIf(process.platform === 'win32');
  const MANIFEST = 'id: exec-demo\nversion: 1.0.0\nname: Exec Demo\n'
    + 'prompts:\n  - id: hello\n    file: prompts/hello.md\n    type: prompt\n'
    + 'skills:\n  - id: demo\n    file: skills/demo/SKILL.md\n    type: skill\n';
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
  // eslint-disable-next-line no-bitwise -- test reads the POSIX execute bits
  const isExecutable = (filePath: string): boolean => (statSync(filePath).mode & 0o111) !== 0;
  let workspace: string;
  let cleanup: () => void;

  beforeEach(() => {
    [workspace, cleanup] = createTempDir('repo-scope-writer-');
  });

  afterEach(() => {
    cleanup();
  });

  const bundle = (scriptMode: number): Map<string, Uint8Array> => new Map([
    ['deployment-manifest.yml', encode(MANIFEST)],
    ['prompts/hello.md', encode('# Hello\n')],
    ['skills/demo/SKILL.md', withFileMode(encode('# Demo\n'), 0o644)],
    ['skills/demo/scripts/run.sh', withFileMode(encode('#!/bin/sh\necho ok\n'), scriptMode)]
  ]);

  unixOnly('makes only files stored executable executable, bytes unchanged', async () => {
    const writer = new RepositoryScopeWriter({ fs: new NodeFileSystem(), workspaceRoot: workspace, commitMode: 'commit' });

    await writer.write(bundle(0o755));

    const github = path.join(workspace, '.github');
    expect(isExecutable(path.join(github, 'skills', 'demo', 'scripts', 'run.sh'))).toBe(true);
    expect(isExecutable(path.join(github, 'skills', 'demo', 'SKILL.md'))).toBe(false);
    expect(isExecutable(path.join(github, 'prompts', 'hello.md'))).toBe(false);
    expect(await new NodeFileSystem().readFile(path.join(github, 'skills', 'demo', 'scripts', 'run.sh')))
      .toBe('#!/bin/sh\necho ok\n');
  });

  unixOnly('clears the exec bit when a rewrite stores the file as non-executable', async () => {
    const writer = new RepositoryScopeWriter({ fs: new NodeFileSystem(), workspaceRoot: workspace, commitMode: 'commit' });
    await writer.write(bundle(0o755));

    await writer.write(bundle(0o644));

    expect(isExecutable(path.join(workspace, '.github', 'skills', 'demo', 'scripts', 'run.sh'))).toBe(false);
  });
});
