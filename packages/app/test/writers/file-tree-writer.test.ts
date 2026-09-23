/**
 * Tests for app/writers/file-tree-writer.ts.
 *
 * No direct equivalent test existed at this module's current location
 * in the reference branch (the only test found there,
 * `infra/test/writers/file-tree-writer.test.ts.skip`, referenced the
 * module at its *old* pre-refactor `infra` location and stale
 * `infra`-internal import paths — see the module doc for the
 * `default-layouts.json` single-source-of-truth history). Written
 * fresh against this module's actual current behavior.
 */
import * as path from 'node:path';
import type {
  ResourceTransformer,
  Target,
} from '@ai-primitives-hub/core';
import {
  BuiltInOnlyLayoutConfigLoader,
} from '@ai-primitives-hub/infra';
import {
  describe,
  expect,
  it,
} from 'vitest';
import type {
  ManifestPlacementItem,
} from '../../src/writers/file-tree-writer';
import {
  expandPath,
  FileTreeTargetWriter,
  resolveLayout,
  resolveLayoutAsync,
} from '../../src/writers/file-tree-writer';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

const localPath = (...segments: string[]): string => path.join(...segments);

class FailAfterFirstWriteFileSystem extends InMemoryFileSystem {
  private writeCount = 0;

  public override async writeFile(filePath: string, contents: string): Promise<void> {
    this.writeCount += 1;
    await super.writeFile(filePath, contents);
    if (this.writeCount === 2) {
      throw new Error('disk full after write');
    }
  }
}

describe('resolveLayout', () => {
  it('resolves vscode user scope layout from built-in defaults', () => {
    const target: Target = { name: 'test', type: 'vscode', scope: 'user', path: '/custom/path' };
    const layout = resolveLayout(target);
    expect(layout.baseDir).toBe('/custom/path');
    expect(layout.kindRoutes).toHaveProperty('prompts/');
    expect(layout.kindRoutes).toHaveProperty('skills/');
  });

  it('uses the generic Copilot root for stable and Insiders user targets', () => {
    for (const type of ['vscode', 'vscode-insiders'] as const) {
      const layout = resolveLayout({ name: type, type, scope: 'user' });
      expect(layout.baseDir).toBe('${HOME}/.copilot');
      expect(layout.kindRoutes['skills/']).toBe('skills/');
      expect(layout.kindRoutes['agents/']).toBe('agents/');
    }
  });

  it('resolves kiro repository scope to baseDir ${workspaceRoot}/.kiro with relative routes', () => {
    const target: Target = { name: 'test', type: 'kiro', scope: 'repository', rootPath: '/ws' };
    const layout = resolveLayout(target);
    // Folder now lives in baseDir; routes are relative (mirrors user scope).
    expect(layout.baseDir).toBe('/ws/.kiro');
    expect(layout.kindRoutes['prompts/']).toBe('steering/');
  });

  it('throws for an unknown target type', () => {
    const target = { name: 'test', type: 'nonexistent', scope: 'user' } as unknown as Target;
    expect(() => resolveLayout(target)).toThrow('No layout defined for target type "nonexistent"');
  });

  it('resolves cursor repository scope to ${workspaceRoot}', () => {
    const target: Target = { name: 'test', type: 'cursor', scope: 'repository', rootPath: '/ws' };
    const layout = resolveLayout(target);
    expect(layout.baseDir).toBe('/ws');
    expect(layout.kindRoutes).toHaveProperty('.cursor/rules/');
  });

  it('resolves kiro repository scope with .kiro/steering and .kiro/specs routes', () => {
    const target: Target = { name: 'test', type: 'kiro', scope: 'repository', rootPath: '/ws' };
    const layout = resolveLayout(target);
    expect(layout.baseDir).toBe('/ws/.kiro');
    expect(layout.kindRoutes['.kiro/steering/']).toBe('steering/');
    expect(layout.kindRoutes['.kiro/specs/']).toBe('specs/');
  });

  it('resolves claude-code repository scope with claude commands and output-styles', () => {
    const target: Target = { name: 'test', type: 'claude-code', scope: 'repository', rootPath: '/ws' };
    const layout = resolveLayout(target);
    expect(layout.baseDir).toBe('/ws/.claude');
    expect(layout.kindRoutes['.claude/commands/']).toBe('commands/');
    expect(layout.kindRoutes['.claude/output-styles/']).toBe('output-styles/');
  });
});

describe('resolveLayoutAsync', () => {
  it('resolves using an injected loader', async () => {
    const target: Target = { name: 'test', type: 'vscode', scope: 'user' };
    const layout = await resolveLayoutAsync(target, new BuiltInOnlyLayoutConfigLoader());
    expect(layout.kindRoutes).toHaveProperty('prompts/');
  });

  it('uses an injected layout loader when writing', async () => {
    const fs = new InMemoryFileSystem();
    const target: Target = { name: 'test', type: 'vscode', scope: 'user' };
    const loader = {
      load: async () => [{
        layouts: {
          vscode: {
            user: {
              baseDir: '/custom',
              kindRoutes: { 'prompts/': 'custom-prompts/' },
              skipPaths: []
            }
          }
        }
      }]
    };
    const writer = new FileTreeTargetWriter({ fs, env: {}, layoutLoader: loader });

    await writer.write(target, new Map([
      ['prompts/test.md', new TextEncoder().encode('# Test')]
    ]));

    expect(await fs.readFile(localPath('/custom', 'custom-prompts', 'test.md'))).toBe('# Test');
  });
});

describe('expandPath', () => {
  it('expands ${VAR} tokens from the env map', () => {
    expect(expandPath('${HOME}/.config', { HOME: '/home/alice' })).toBe('/home/alice/.config');
  });

  it('expands a leading ~ using HOME', () => {
    expect(expandPath('~/.config', { HOME: '/home/alice' })).toBe('/home/alice/.config');
  });

  it('falls back to USERPROFILE when HOME is unset', () => {
    expect(expandPath('~/.config', { USERPROFILE: 'C:/Users/alice' })).toBe('C:/Users/alice/.config');
  });

  it('leaves unmatched tokens blank rather than throwing', () => {
    expect(expandPath('${UNKNOWN}/x', {})).toBe('/x');
  });
});

describe('FileTreeTargetWriter', () => {
  const target: Target = { name: 'test', type: 'vscode', scope: 'user', path: '/out' };

  it('writes routed files into the resolved layout', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const files = new Map<string, Uint8Array>([
      ['prompts/test.md', new TextEncoder().encode('# Test')]
    ]);

    const result = await writer.write(target, files);

    expect(result.written).toContain(localPath('/out', 'prompts', 'test.md'));
    expect(result.skipped).toEqual([]);
    expect(await fs.readFile(localPath('/out', 'prompts', 'test.md'))).toBe('# Test');
  });

  it('rolls back files when a filesystem write throws after persisting', async () => {
    const fs = new FailAfterFirstWriteFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const files = new Map<string, Uint8Array>([
      ['prompts/first.md', new TextEncoder().encode('# First')],
      ['prompts/second.md', new TextEncoder().encode('# Second')]
    ]);

    await expect(writer.write(target, files)).rejects.toThrow('disk full after write');

    expect(await fs.exists(localPath('/out', 'prompts', 'first.md'))).toBe(false);
    expect(await fs.exists(localPath('/out', 'prompts', 'second.md'))).toBe(false);
  });

  it('routes the legacy chatmodes path alias to the canonical chat-modes route', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const files = new Map<string, Uint8Array>([
      ['chatmodes/review.chatmode.md', new TextEncoder().encode('# Review')]
    ]);

    const result = await writer.write(target, files);

    expect(result.written).toContain(localPath('/out', 'agents', 'review.chatmode.md'));
    expect(result.skipped).toEqual([]);
  });

  it('skips files in the layout skipPaths list', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', new TextEncoder().encode('id: x')]
    ]);

    const result = await writer.write(target, files);

    expect(result.written).toEqual([]);
  });

  it('skips unrouted files without erroring', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const files = new Map<string, Uint8Array>([
      ['unrouted/thing.bin', new TextEncoder().encode('data')]
    ]);

    const result = await writer.write(target, files);

    expect(result.written).toEqual([]);
    expect(result.skipped).toContain('unrouted/thing.bin');
  });

  it('honors target.allowedKinds by skipping excluded kinds', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const restrictedTarget: Target = { ...target, allowedKinds: ['skill'] };
    const files = new Map<string, Uint8Array>([
      ['prompts/test.md', new TextEncoder().encode('# Test')],
      ['skills/my-skill/SKILL.md', new TextEncoder().encode('# Skill')]
    ]);

    const result = await writer.write(restrictedTarget, files);

    expect(result.written).toContain(localPath('/out', 'skills', 'my-skill', 'SKILL.md'));
    expect(result.skipped).toContain('prompts/test.md');
  });

  it('writes binary files byte-for-byte without applying a transformer (issue #357)', async () => {
    const fs = new InMemoryFileSystem();
    const transformer: ResourceTransformer = {
      transform: (ctx) => ({ content: `${ctx.content}\n<!-- transformed -->`, modified: true })
    };
    const writer = new FileTreeTargetWriter({ fs, env: {}, transformer });
    // Invalid UTF-8 sequences: a lossy TextDecoder round-trip would
    // replace them with U+FFFD and corrupt the asset.
    const binaryBytes = new Uint8Array([0x50, 0x4B, 0x03, 0x04, 0xFF, 0xFE, 0x00, 0x9D, 0xC7, 0x80]);
    const files = new Map<string, Uint8Array>([
      ['skills/deck/assets/template.pptx', binaryBytes]
    ]);

    const result = await writer.write(target, files);

    const installedPath = localPath('/out', 'skills', 'deck', 'assets', 'template.pptx');
    expect(result.written).toContain(installedPath);
    expect(await fs.readFileBytes(installedPath)).toEqual(binaryBytes);
  });

  it('writes binary skill assets byte-for-byte in writeManifestItems', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const binaryBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0xFF, 0xD8, 0x00, 0xC0]);
    const files = new Map<string, Uint8Array>([
      ['skills/deck/SKILL.md', new TextEncoder().encode('# Deck')],
      ['skills/deck/assets/logo.png', binaryBytes]
    ]);
    const items: ManifestPlacementItem[] = [
      { id: 'deck', file: 'skills/deck/SKILL.md', type: 'skill' }
    ];

    await writer.writeManifestItems(target, files, items);

    expect(await fs.readFileBytes(localPath('/out', 'skills', 'deck', 'assets', 'logo.png'))).toEqual(binaryBytes);
  });

  it('applies a resource transformer to file content', async () => {
    const fs = new InMemoryFileSystem();
    const transformer: ResourceTransformer = {
      transform: (ctx) => ({ content: `${ctx.content}\n<!-- transformed -->`, modified: true })
    };
    const writer = new FileTreeTargetWriter({ fs, env: {}, transformer });
    const files = new Map<string, Uint8Array>([
      ['prompts/test.md', new TextEncoder().encode('# Test')]
    ]);

    await writer.write(target, files);

    expect(await fs.readFile(localPath('/out', 'prompts', 'test.md'))).toBe('# Test\n<!-- transformed -->');
  });

  it('falls back to original content when the transformer throws', async () => {
    const fs = new InMemoryFileSystem();
    const transformer: ResourceTransformer = {
      transform: () => {
        throw new Error('boom');
      }
    };
    const writer = new FileTreeTargetWriter({ fs, env: {}, transformer });
    const files = new Map<string, Uint8Array>([
      ['prompts/test.md', new TextEncoder().encode('# Test')]
    ]);

    await writer.write(target, files);

    expect(await fs.readFile(localPath('/out', 'prompts', 'test.md'))).toBe('# Test');
  });

  it('removes a routed file', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(localPath('/out', 'prompts', 'test.md'), '# Test');
    const writer = new FileTreeTargetWriter({ fs, env: {} });

    await writer.remove(target, 'prompts/test.md');

    expect(await fs.exists(localPath('/out', 'prompts', 'test.md'))).toBe(false);
  });

  it('no-ops removing an unrouted file', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env: {} });

    await expect(writer.remove(target, 'unrouted/thing.bin')).resolves.not.toThrow();
  });

  it('prefers the most specific route for .kiro/steering/', async () => {
    const fs = new InMemoryFileSystem();
    const kiroTarget: Target = { name: 'test', type: 'kiro', scope: 'repository', rootPath: '/ws' };
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const files = new Map<string, Uint8Array>([
      ['.kiro/steering/api.md', new TextEncoder().encode('# API')]
    ]);

    const result = await writer.write(kiroTarget, files);

    expect(result.written).toContain(localPath('/ws', '.kiro', 'steering', 'api.md'));
    expect(result.skipped).toEqual([]);
  });

  it('routes .cursor/rules/ for cursor repository scope', async () => {
    const fs = new InMemoryFileSystem();
    const cursorTarget: Target = { name: 'test', type: 'cursor', scope: 'repository', rootPath: '/ws' };
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const files = new Map<string, Uint8Array>([
      ['.cursor/rules/backend.mdc', new TextEncoder().encode('# Rules')]
    ]);

    const result = await writer.write(cursorTarget, files);

    expect(result.written).toContain(localPath('/ws', '.cursor', 'rules', 'backend.mdc'));
  });

  it('routes knowledge/ and playbooks/ for devin repository scope', async () => {
    const fs = new InMemoryFileSystem();
    const devinTarget: Target = { name: 'test', type: 'devin', scope: 'repository', rootPath: '/ws' };
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const files = new Map<string, Uint8Array>([
      ['knowledge/onboarding.md', new TextEncoder().encode('# Onboarding')],
      ['playbooks/bug-fix.md', new TextEncoder().encode('# Bug fix')]
    ]);

    const result = await writer.write(devinTarget, files);

    expect(result.written).toContain(localPath('/ws', '.devin', 'knowledge', 'onboarding.md'));
    expect(result.written).toContain(localPath('/ws', '.devin', 'playbooks', 'bug-fix.md'));
  });
});

describe('FileTreeTargetWriter.writeManifestItems', () => {
  const repoTarget: Target = { name: 'test', type: 'vscode', scope: 'repository', rootPath: '/ws' };

  it('renames a prompt to {id}.prompt.md under the resolved prompts route', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const files = new Map<string, Uint8Array>([
      ['some-source-name.md', new TextEncoder().encode('# Hello')]
    ]);
    const items: ManifestPlacementItem[] = [
      { id: 'my-prompt', file: 'some-source-name.md', type: 'prompt' }
    ];

    const result = await writer.writeManifestItems(repoTarget, files, items);

    expect(result.written).toEqual([localPath('/ws', '.github', 'prompts', 'my-prompt.prompt.md')]);
    expect(result.skipped).toEqual([]);
    expect(await fs.readFile(localPath('/ws', '.github', 'prompts', 'my-prompt.prompt.md'))).toBe('# Hello');
  });

  it('auto-detects the file type from tags when type is omitted', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const files = new Map<string, Uint8Array>([
      ['guidance.md', new TextEncoder().encode('# Guidance')]
    ]);
    const items: ManifestPlacementItem[] = [
      { id: 'my-instructions', file: 'guidance.md', tags: ['instructions'] }
    ];

    const result = await writer.writeManifestItems(repoTarget, files, items);

    expect(result.written).toEqual([localPath('/ws', '.github', 'instructions', 'my-instructions.instructions.md')]);
  });

  it('routes chatmode items alongside agents', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const files = new Map<string, Uint8Array>([
      ['mode.md', new TextEncoder().encode('# Mode')]
    ]);
    const items: ManifestPlacementItem[] = [
      { id: 'my-mode', file: 'mode.md', type: 'chatmode' }
    ];

    const result = await writer.writeManifestItems(repoTarget, files, items);

    expect(result.written).toEqual([localPath('/ws', '.github', 'agents', 'my-mode.chatmode.md')]);
  });

  it('routes agent items to the agents/ directory', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const files = new Map<string, Uint8Array>([
      ['agent-source.md', new TextEncoder().encode('# Agent')]
    ]);
    const items: ManifestPlacementItem[] = [
      { id: 'my-agent', file: 'agent-source.md', type: 'agent' }
    ];

    const result = await writer.writeManifestItems(repoTarget, files, items);

    expect(result.written).toEqual([localPath('/ws', '.github', 'agents', 'my-agent.agent.md')]);
  });

  it('skips items whose kind is excluded by target.allowedKinds', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const restrictedTarget: Target = { ...repoTarget, allowedKinds: ['skill'] };
    const files = new Map<string, Uint8Array>([
      ['some-source-name.md', new TextEncoder().encode('# Hello')]
    ]);
    const items: ManifestPlacementItem[] = [
      { id: 'my-prompt', file: 'some-source-name.md', type: 'prompt' }
    ];

    const result = await writer.writeManifestItems(restrictedTarget, files, items);

    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual(['some-source-name.md']);
  });

  it('routes agents into the windsurf layout', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const windsurfTarget: Target = { name: 'test', type: 'windsurf', scope: 'repository', rootPath: '/ws' };
    const files = new Map<string, Uint8Array>([
      ['agent-source.md', new TextEncoder().encode('# Agent')]
    ]);
    const items: ManifestPlacementItem[] = [
      { id: 'my-agent', file: 'agent-source.md', type: 'agent' }
    ];

    const result = await writer.writeManifestItems(windsurfTarget, files, items);

    expect(result.written).toEqual([localPath('/ws', '.windsurf', 'agents', 'my-agent.agent.md')]);
    expect(result.skipped).toEqual([]);
  });

  it('skips an item whose source file is missing from the extracted files map', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const items: ManifestPlacementItem[] = [
      { id: 'my-prompt', file: 'missing.md', type: 'prompt' }
    ];

    const result = await writer.writeManifestItems(repoTarget, new Map(), items);

    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual(['missing.md']);
  });

  it('applies a resource transformer to renamed file content', async () => {
    const fs = new InMemoryFileSystem();
    const transformer: ResourceTransformer = {
      transform: (ctx) => ({ content: `${ctx.content}\n<!-- transformed -->`, modified: true })
    };
    const writer = new FileTreeTargetWriter({ fs, env: {}, transformer });
    const files = new Map<string, Uint8Array>([
      ['some-source-name.md', new TextEncoder().encode('# Hello')]
    ]);
    const items: ManifestPlacementItem[] = [
      { id: 'my-prompt', file: 'some-source-name.md', type: 'prompt' }
    ];

    await writer.writeManifestItems(repoTarget, files, items);

    expect(await fs.readFile(localPath('/ws', '.github', 'prompts', 'my-prompt.prompt.md'))).toBe('# Hello\n<!-- transformed -->');
  });

  it('copies an entire skill directory into {id}/, renaming the directory but preserving relative paths', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const files = new Map<string, Uint8Array>([
      ['skills/source-skill/SKILL.md', new TextEncoder().encode('# Skill')],
      ['skills/source-skill/scripts/run.sh', new TextEncoder().encode('#!/bin/sh')]
    ]);
    const items: ManifestPlacementItem[] = [
      { id: 'my-skill', file: 'skills/source-skill/SKILL.md', type: 'skill' }
    ];

    const result = await writer.writeManifestItems(repoTarget, files, items);

    expect(result.written).toContain(localPath('/ws', '.github', 'skills', 'my-skill', 'SKILL.md'));
    expect(result.written).toContain(localPath('/ws', '.github', 'skills', 'my-skill', 'scripts', 'run.sh'));
    expect(result.skipped).toEqual([]);
    expect(await fs.readFile(localPath('/ws', '.github', 'skills', 'my-skill', 'SKILL.md'))).toBe('# Skill');
    expect(await fs.readFile(localPath('/ws', '.github', 'skills', 'my-skill', 'scripts', 'run.sh'))).toBe('#!/bin/sh');
  });

  it('skips a skill item when no bundle files match its source skill directory', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const items: ManifestPlacementItem[] = [
      { id: 'my-skill', file: 'skills/missing-skill/SKILL.md', type: 'skill' }
    ];

    const result = await writer.writeManifestItems(repoTarget, new Map(), items);

    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual(['skills/missing-skill/SKILL.md']);
  });
});
