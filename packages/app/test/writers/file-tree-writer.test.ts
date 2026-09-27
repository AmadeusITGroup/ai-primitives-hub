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
import {
  createHash,
} from 'node:crypto';
import * as disk from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  ResourceTransformer,
  Target,
} from '@ai-primitives-hub/core';
import {
  BuiltInOnlyLayoutConfigLoader,
  NodeFileSystem,
} from '@ai-primitives-hub/infra';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  writeTargetSafely,
} from '../../src/install/target-write';
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
  checksumWrittenFiles,
} from '../../src/writers/lockfile-files';
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

class ExternalKnowledgeParentFileSystem extends InMemoryFileSystem {
  public override realpath(filePath: string): Promise<string> {
    const resolvedPath = path.resolve(filePath);
    const externalParent = path.resolve('/ws', '.github', 'knowledge', 'linked');
    return Promise.resolve(resolvedPath === externalParent ? path.resolve('/outside') : resolvedPath);
  }
}

class FailWriteAndRollbackFileSystem extends InMemoryFileSystem {
  public override async writeFile(filePath: string, contents: string): Promise<void> {
    await super.writeFile(filePath, contents);
    throw new Error('write failed');
  }

  public override async writeFileBytes(_filePath: string, _bytes: Uint8Array): Promise<void> {
    throw new Error('rollback failed');
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

  it('restores overwritten files when a later write throws after persisting', async () => {
    const fs = new FailAfterFirstWriteFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const firstPath = localPath('/out', 'prompts', 'first.md');
    const secondPath = localPath('/out', 'prompts', 'second.md');
    fs.seed(firstPath, '# Original first');
    fs.seed(secondPath, '# Original second');
    const files = new Map<string, Uint8Array>([
      ['prompts/first.md', new TextEncoder().encode('# First')],
      ['prompts/second.md', new TextEncoder().encode('# Second')]
    ]);

    await expect(writer.write(target, files)).rejects.toThrow('disk full after write');

    expect(await fs.readFile(firstPath)).toBe('# Original first');
    expect(await fs.readFile(secondPath)).toBe('# Original second');
  });

  it('surfaces the original write failure together with a rollback failure', async () => {
    const fs = new FailWriteAndRollbackFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const outPath = localPath('/out', 'prompts', 'existing.md');
    fs.seed(outPath, '# Original');
    const result = await writer.write(target, new Map([
      ['prompts/existing.md', new TextEncoder().encode('# Replacement')]
    ])).catch((error: unknown) => error);

    expect(result).toBeInstanceOf(AggregateError);
    const errors = (result as AggregateError).errors;
    expect(errors.some((error) => error instanceof Error && error.message === 'write failed')).toBe(true);
    expect(errors.some((error) => String(error).includes('rollback failed'))).toBe(true);
  });

  it('rejects non-empty rollback when no write journal exists while allowing an empty request', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env: {} });

    await expect(writer.rollback(target, [])).resolves.toBeUndefined();
    await expect(writer.rollback(target, [localPath('/out', 'prompts', 'unwritten.md')]))
      .rejects.toThrow(/journal/i);
  });

  it('rejects paths from an older write journal without changing either write', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const writeBundle = (name: string): Map<string, Uint8Array> => new Map([
      ['deployment-manifest.yml', new TextEncoder().encode(`id: ${name}\nversion: 1.0.0\nname: ${name}\nprompts:\n  - id: ${name}\n    file: prompts/${name}.md\n    type: prompt\n`)],
      [`prompts/${name}.md`, new TextEncoder().encode(`# ${name}`)]
    ]);
    const first = await writer.write(target, writeBundle('first'));
    const second = await writer.write(target, writeBundle('second'));
    const firstPath = localPath('/out', 'prompts', 'first.md');
    const secondPath = localPath('/out', 'prompts', 'second.md');

    await expect(writer.rollback(target, first.written)).rejects.toThrow(/journal/i);
    expect(await fs.readFile(firstPath)).toBe('# first');
    expect(await fs.readFile(secondPath)).toBe('# second');

    await writer.rollback(target, second.written);
    expect(await fs.readFile(firstPath)).toBe('# first');
    expect(await fs.exists(secondPath)).toBe(false);
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

  it('removes ordinary skill and prompt routes with a knowledge-named directory', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const skillFile = localPath('/out', 'skills', 'knowledge', 'SKILL.md');
    const promptFile = localPath('/out', 'prompts', 'knowledge', 'guide.md');
    fs.seed(skillFile, '# Skill');
    fs.seed(promptFile, '# Prompt');

    await writer.remove(target, 'skills/knowledge/SKILL.md');
    await writer.remove(target, 'prompts/knowledge/guide.md');

    expect(await fs.exists(skillFile)).toBe(false);
    expect(await fs.exists(promptFile)).toBe(false);
  });

  it('no-ops removing an unrouted file', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env: {} });

    await expect(writer.remove(target, 'unrouted/thing.bin')).resolves.not.toThrow();
  });

  it('preflights and removes legacy and repository-relative Kiro knowledge lock paths', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const kiroTarget: Target = { name: 'test', type: 'kiro', scope: 'repository', rootPath: '/ws' };
    const legacyPath = localPath('/ws', '.kiro', 'knowledge', 'legacy', 'guide.md');
    const repositoryPath = localPath('/ws', '.kiro', 'knowledge', 'canonical', 'guide.md');
    fs.seed(legacyPath, '# Legacy');
    fs.seed(repositoryPath, '# Canonical');

    await writer.preflightRemoval(kiroTarget, [
      'knowledge/legacy/guide.md',
      '.kiro/knowledge/canonical/guide.md'
    ]);
    await expect(writer.preflightRemoval(kiroTarget, ['.kiro/knowledge/../steering/victim.md']))
      .rejects.toThrow(/escapes repository root/);
    await writer.remove(kiroTarget, 'knowledge/legacy/guide.md');
    await writer.remove(kiroTarget, '.kiro/knowledge/canonical/guide.md');

    expect(await fs.exists(legacyPath)).toBe(false);
    expect(await fs.exists(repositoryPath)).toBe(false);

    const vscodeTarget: Target = { name: 'test', type: 'vscode', scope: 'repository', rootPath: '/ws' };
    const githubPath = localPath('/ws', '.github', 'knowledge', 'physical', 'guide.md');
    fs.seed(githubPath, '# Physical');
    await writer.preflightRemoval(vscodeTarget, ['.github/knowledge/physical/guide.md']);
    await writer.remove(vscodeTarget, '.github/knowledge/physical/guide.md');
    expect(await fs.exists(githubPath)).toBe(false);
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

  it('routes knowledge files into .github/knowledge for vscode repository scope', async () => {
    const fs = new InMemoryFileSystem();
    const knowledgeTarget: Target = { name: 'test', type: 'vscode', scope: 'repository', rootPath: '/ws' };
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const files = new Map<string, Uint8Array>([
      ['knowledge/specifications.md', new TextEncoder().encode('# Specifications')]
    ]);

    const result = await writer.write(knowledgeTarget, files);

    expect(result.written).toContain(localPath('/ws', '.github', 'knowledge', 'specifications.md'));
    expect(await fs.readFile(localPath('/ws', '.github', 'knowledge', 'specifications.md')))
      .toBe('# Specifications');
  });

  it('routes knowledge files into .kiro/knowledge for kiro repository scope', async () => {
    const fs = new InMemoryFileSystem();
    const knowledgeTarget: Target = { name: 'test', type: 'kiro', scope: 'repository', rootPath: '/ws' };
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const files = new Map<string, Uint8Array>([
      ['knowledge/specifications.md', new TextEncoder().encode('# Specifications')]
    ]);

    const result = await writer.write(knowledgeTarget, files);

    expect(result.written).toContain(localPath('/ws', '.kiro', 'knowledge', 'specifications.md'));
    expect(await fs.readFile(localPath('/ws', '.kiro', 'knowledge', 'specifications.md')))
      .toBe('# Specifications');
  });

  it('rejects an external knowledge parent before writing earlier bundle files', async () => {
    const fs = new ExternalKnowledgeParentFileSystem();
    const repositoryTarget: Target = { name: 'test', type: 'vscode', scope: 'repository', rootPath: '/ws' };
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const files = new Map<string, Uint8Array>([
      ['prompts/first.md', new TextEncoder().encode('# First')],
      ['knowledge/linked/guide.md', new TextEncoder().encode('# Guide')]
    ]);

    await expect(writer.write(repositoryTarget, files)).rejects.toThrow(/escapes repository root/);

    expect(await fs.exists(localPath('/ws', '.github', 'prompts', 'first.md'))).toBe(false);
  });
});

describe('checksumWrittenFiles', () => {
  it('checksums virtual knowledge bytes and records the physical repository destination', () => {
    const bytes = new TextEncoder().encode('# Knowledge');
    const filePath = 'knowledge/specifications/RDP/guide.md';
    const result = {
      written: ['/ws/.github/knowledge/specifications/RDP/guide.md'],
      skipped: [],
      writtenBundlePaths: [filePath]
    };

    expect(checksumWrittenFiles(new Map([[filePath, bytes]]), result, {
      name: 'vscode', type: 'vscode', scope: 'repository', rootPath: '/ws'
    }, '/ws')).toEqual([{
      path: '.github/knowledge/specifications/RDP/guide.md',
      checksum: createHash('sha256').update(bytes).digest('hex')
    }]);
  });

  it('rejects missing writer-to-bundle alignment', () => {
    expect(() => checksumWrittenFiles(new Map(), { written: ['/ws/file'], skipped: [] }, {
      name: 'vscode', type: 'vscode', scope: 'repository', rootPath: '/ws'
    }, '/ws')).toThrow(/does not align/);
  });
});

describe('FileTreeTargetWriter scope and layout behavior', () => {
  it('does not create an absent user base when preflight rejects unsupported content', async () => {
    const fs = new InMemoryFileSystem();
    const baseDir = '/absent-user-base';
    const target: Target = {
      name: 'copilot', type: 'copilot-cli', scope: 'user', path: baseDir, allowedKinds: ['prompt']
    };
    const writer = new FileTreeTargetWriter({ fs, env: {} });

    await expect(writeTargetSafely(writer, target, new Map([
      ['prompts/allowed.prompt.md', new TextEncoder().encode('# Prompt')],
      ['knowledge/rejected.md', new TextEncoder().encode('# Knowledge')]
    ]))).rejects.toMatchObject({ code: 'BUNDLE.UNSUPPORTED_CONTENT' });

    expect(await fs.exists(baseDir)).toBe(false);
  });

  it('does not create an absent workspace base when preflight rejects unsupported content', async () => {
    const fs = new InMemoryFileSystem();
    const baseDir = '/absent-workspace-base';
    const target: Target = {
      name: 'workspace-vscode', type: 'vscode', scope: 'workspace', path: baseDir, allowedKinds: ['prompt']
    };
    const writer = new FileTreeTargetWriter({ fs, env: {} });

    await expect(writeTargetSafely(writer, target, new Map([
      ['prompts/allowed.prompt.md', new TextEncoder().encode('# Prompt')],
      ['knowledge/rejected.md', new TextEncoder().encode('# Knowledge')]
    ]))).rejects.toMatchObject({ code: 'BUNDLE.UNSUPPORTED_CONTENT' });

    expect(await fs.exists(baseDir)).toBe(false);
  });

  it('writes, rolls back, and uninstalls workspace-scope files using the user layout root', async () => {
    const fs = new InMemoryFileSystem();
    const target: Target = { name: 'workspace-vscode', type: 'vscode', scope: 'workspace', path: '/workspace-target' };
    const installedPath = localPath('/workspace-target', 'prompts', 'existing.md');
    fs.seed(installedPath, '# Original');
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const result = await writer.write(target, new Map([
      ['prompts/existing.md', new TextEncoder().encode('# Installed')]
    ]));

    expect(await fs.readFile(installedPath)).toBe('# Installed');
    await writer.rollback(target, result.written);
    expect(await fs.readFile(installedPath)).toBe('# Original');
    await writer.remove(target, 'prompts/existing.md');
    expect(await fs.exists(installedPath)).toBe(false);
  });

  it('rejects a foreign-host physical knowledge lockfile path without touching the Kiro target', async () => {
    const fs = new InMemoryFileSystem();
    const target: Target = { name: 'kiro', type: 'kiro', scope: 'repository', rootPath: '/ws' };
    const victim = localPath('/ws', '.kiro', 'knowledge', 'guide.md');
    fs.seed(victim, '# Kiro knowledge');
    const writer = new FileTreeTargetWriter({ fs, env: {} });

    await expect(writer.preflightRemoval(target, ['.github/knowledge/guide.md']))
      .rejects.toThrow(/does not match this target layout/);
    expect(await fs.readFile(victim)).toBe('# Kiro knowledge');
  });

  it('round-trips the configured physical knowledge route through its lockfile path', async () => {
    const fs = new InMemoryFileSystem();
    const target: Target = { name: 'kiro', type: 'kiro', scope: 'repository', rootPath: '/ws' };
    const layoutLoader = {
      load: async () => [{
        layouts: {
          kiro: {
            repository: {
              baseDir: '${workspaceRoot}/custom',
              kindRoutes: { 'knowledge/': 'docs/' },
              skipPaths: []
            }
          }
        }
      }]
    };
    const writer = new FileTreeTargetWriter({ fs, env: {}, layoutLoader });
    const bundlePath = 'knowledge/specifications/guide.md';
    const files = new Map([[bundlePath, new TextEncoder().encode('# Guide')]]);
    const result = await writer.write(target, files);
    const lockfileEntry = checksumWrittenFiles(files, result, target, '/ws')[0];

    expect(result.written).toEqual([localPath('/ws', 'custom', 'docs', 'specifications', 'guide.md')]);
    expect(lockfileEntry?.path).toBe('custom/docs/specifications/guide.md');
    await writer.preflightRemoval(target, [lockfileEntry?.path]);
    await writer.remove(target, lockfileEntry?.path);
    expect(await fs.exists(result.written[0])).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('FileTreeTargetWriter filesystem containment', () => {
  it('rejects external and final knowledge symlinks, allows internal parents, and safely removes final links', async () => {
    const tempDir = await disk.mkdtemp(localPath(os.tmpdir(), 'file-tree-containment-'));
    const repository = localPath(tempDir, 'repository');
    const outside = localPath(tempDir, 'outside');
    const knowledgeDir = localPath(repository, '.github', 'knowledge');
    const target: Target = { name: 'vscode', type: 'vscode', scope: 'repository', rootPath: repository };
    const writer = new FileTreeTargetWriter({ fs: new NodeFileSystem(), env: {} });
    try {
      await disk.mkdir(knowledgeDir, { recursive: true });
      await disk.mkdir(outside, { recursive: true });
      const victim = localPath(outside, 'victim.md');
      await disk.writeFile(victim, '# Outside');
      await disk.symlink(outside, localPath(knowledgeDir, 'linked'), 'dir');
      await expect(writer.write(target, new Map([
        ['prompts/first.md', new TextEncoder().encode('# First')],
        ['knowledge/linked/victim.md', new TextEncoder().encode('# Replaced')]
      ]))).rejects.toThrow(/escapes repository root/);
      await expect(disk.readFile(localPath(repository, '.github', 'prompts', 'first.md'))).rejects.toThrow();
      await expect(disk.readFile(victim, 'utf8')).resolves.toBe('# Outside');
      await expect(writer.preflightRemoval(target, ['.github/knowledge/linked/victim.md']))
        .rejects.toThrow(/escapes repository root/);

      await disk.rm(localPath(knowledgeDir, 'linked'));
      await disk.symlink(victim, localPath(knowledgeDir, 'final-link.md'));
      await expect(writer.write(target, new Map([
        ['knowledge/final-link.md', new TextEncoder().encode('# Replaced')]
      ]))).rejects.toThrow(/symlink/);
      await expect(disk.readFile(victim, 'utf8')).resolves.toBe('# Outside');

      await disk.rm(localPath(knowledgeDir, 'final-link.md'));
      const internal = localPath(repository, 'internal-knowledge');
      await disk.mkdir(internal);
      await disk.symlink(internal, localPath(knowledgeDir, 'internal'), 'dir');
      await writer.write(target, new Map([
        ['knowledge/internal/nested/guide.md', new TextEncoder().encode('# Guide')]
      ]));
      await expect(disk.readFile(localPath(internal, 'nested', 'guide.md'), 'utf8')).resolves.toBe('# Guide');

      await disk.symlink(victim, localPath(knowledgeDir, 'removal-link.md'));
      await writer.remove(target, '.github/knowledge/removal-link.md');
      await expect(disk.lstat(localPath(knowledgeDir, 'removal-link.md'))).rejects.toThrow();
      await expect(disk.readFile(victim, 'utf8')).resolves.toBe('# Outside');
    } finally {
      await disk.rm(tempDir, { recursive: true, force: true });
    }
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

  it('routes knowledge items to knowledge while preserving source-relative paths', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const files = new Map<string, Uint8Array>([
      ['specifications/RDP/AGENT_INDEX.md', new TextEncoder().encode('# Index')],
      ['.github/knowledge/RDP/issue-tickets.md', new TextEncoder().encode('# Tickets')]
    ]);
    const items: ManifestPlacementItem[] = [
      { id: 'AGENT_INDEX', file: 'specifications/RDP/AGENT_INDEX.md', type: 'knowledge' },
      { id: 'issue-tickets', file: '.github/knowledge/RDP/issue-tickets.md', type: 'knowledge' }
    ];

    const result = await writer.writeManifestItems(repoTarget, files, items);

    expect(result.written).toEqual([
      localPath('/ws', '.github', 'knowledge', 'specifications', 'RDP', 'AGENT_INDEX.md'),
      localPath('/ws', '.github', 'knowledge', 'RDP', 'issue-tickets.md')
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('skips knowledge paths that escape the bundle root', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const files = new Map<string, Uint8Array>([
      ['../outside.md', new TextEncoder().encode('# Outside')]
    ]);
    const items: ManifestPlacementItem[] = [
      { id: 'outside', file: '../outside.md', type: 'knowledge' }
    ];

    const result = await writer.writeManifestItems(repoTarget, files, items);

    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual(['../outside.md']);
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
