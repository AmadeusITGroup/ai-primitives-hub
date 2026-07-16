/**
 * Tests for infra/writers/repo-scope-writer.ts.
 *
 * Ported from the reference branch's real-tempdir-backed test to use
 * this suite's established `InMemoryFileSystem` double instead (per
 * `test/AGENTS.md`'s "test behavior not implementation" rule — same
 * assertions, faster + no real disk IO).
 */
import * as path from 'node:path';
import type {
  Target,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  RepositoryScopeWriter,
  RepositoryScopeWriterAdapter,
} from '../../src/writers/repo-scope-writer';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

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

describe('RepositoryScopeWriter', () => {
  it('writes prompts to .github/copilot/prompts/', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });

    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', new TextEncoder().encode(SAMPLE_MANIFEST)],
      ['prompts/test.md', new TextEncoder().encode('# Test Prompt')]
    ]);

    const result = await writer.write(files);

    const expected = path.join(WORKSPACE_ROOT, '.github', 'copilot', 'prompts', 'test.md');
    expect(result.written).toContain(expected);
    expect(await fs.exists(expected)).toBe(true);
  });

  it('writes instructions to .github/copilot/instructions/', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });

    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', new TextEncoder().encode(SAMPLE_MANIFEST)],
      ['instructions/test.md', new TextEncoder().encode('# Test Instruction')]
    ]);

    const result = await writer.write(files);

    const expected = path.join(WORKSPACE_ROOT, '.github', 'copilot', 'instructions', 'test.md');
    expect(result.written).toContain(expected);
    expect(await fs.exists(expected)).toBe(true);
  });

  it('writes agents to .github/copilot/agents/', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });

    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', new TextEncoder().encode(SAMPLE_MANIFEST)],
      ['agents/test.md', new TextEncoder().encode('# Test Agent')]
    ]);

    const result = await writer.write(files);

    const expected = path.join(WORKSPACE_ROOT, '.github', 'copilot', 'agents', 'test.md');
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
    const fs = new InMemoryFileSystem();
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

  it('removes a single file', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });

    const testFile = path.join(WORKSPACE_ROOT, '.github', 'copilot', 'prompts', 'test.md');
    fs.seed(testFile, '# Test');

    await writer.removeFile('copilot/prompts/test.md');

    expect(await fs.exists(testFile)).toBe(false);
  });

  it('removes files for a bundle from manifest', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });

    const promptFile = path.join(WORKSPACE_ROOT, '.github', 'copilot', 'prompts', 'test.md');
    fs.seed(promptFile, '# Test');

    const manifest = {
      id: 'test-bundle',
      prompts: [{ id: 'test-prompt', file: 'prompts/test.md', type: 'prompt' }]
    };

    await writer.remove('test-bundle', manifest);

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
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'local-only' });

    const excludePath = path.join(WORKSPACE_ROOT, '.git', 'info', 'exclude');
    fs.seed(excludePath, '# Prompt Registry (local)\n.github/copilot/prompts/test.md');

    const manifest = {
      id: 'test-bundle',
      prompts: [{ id: 'test-prompt', file: 'prompts/test.md', type: 'prompt' }]
    };

    await writer.remove('test-bundle', manifest);

    const content = await fs.readFile(excludePath);
    expect(content).not.toContain('.github/copilot/prompts/test.md');
  });

  it('switches commit mode from commit to local-only', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });

    const paths = [path.join(WORKSPACE_ROOT, '.github', 'copilot', 'prompts', 'test.md')];

    await writer.switchCommitMode(paths, 'local-only');

    const excludePath = path.join(WORKSPACE_ROOT, '.git', 'info', 'exclude');
    expect(await fs.exists(excludePath)).toBe(true);
  });

  it('switches commit mode from local-only to commit', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'local-only' });

    const paths = [path.join(WORKSPACE_ROOT, '.github', 'copilot', 'prompts', 'test.md')];
    await writer.switchCommitMode(paths, 'local-only');
    await writer.switchCommitMode(paths, 'commit');

    const excludePath = path.join(WORKSPACE_ROOT, '.git', 'info', 'exclude');
    const content = await fs.readFile(excludePath);
    expect(content).not.toContain('.github/copilot/prompts/test.md');
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
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'local-only' });

    const manifest = {
      id: 'test-bundle',
      prompts: [{ id: 'test-prompt', file: 'prompts/test.md', type: 'prompt' }]
    };

    // Should not throw even though .git/info/exclude doesn't exist
    await expect(writer.remove('test-bundle', manifest)).resolves.not.toThrow();
  });

  it('handles removal when git/info/exclude has no Prompt Registry section', async () => {
    const fs = new InMemoryFileSystem();
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
    expect(await fs.exists(path.join(WORKSPACE_ROOT, '.github', 'copilot', 'prompts', 'test.md'))).toBe(true);
  });

  it('delegates remove to RepositoryScopeWriter.removeFile', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });
    const adapter = new RepositoryScopeWriterAdapter(writer);

    const testFile = path.join(WORKSPACE_ROOT, '.github', 'copilot', 'prompts', 'test.md');
    fs.seed(testFile, '# Test');

    await adapter.remove(dummyTarget, 'copilot/prompts/test.md');

    expect(await fs.exists(testFile)).toBe(false);
  });

  it('handles non-existent file removal gracefully', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit' });
    const adapter = new RepositoryScopeWriterAdapter(writer);

    await expect(adapter.remove(dummyTarget, 'copilot/prompts/nonexistent.md')).resolves.not.toThrow();
  });
});
