import {
  createHash,
} from 'node:crypto';
import {
  mkdtemp,
  symlink,
} from 'node:fs/promises';
import {
  tmpdir,
} from 'node:os';
import * as path from 'node:path';
import type {
  Target,
  TargetWriteOperation,
  TargetWritePlan,
} from '@ai-primitives-hub/core';
import {
  NodeFileSystem,
} from '@ai-primitives-hub/infra';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  FileTreeTargetWriter,
  resolveLayout,
  resolveLayoutAsync,
} from '../../src/writers/file-tree-writer';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

const target: Target = { name: 'test', type: 'vscode', scope: 'user' };

const checksum = (bytes: Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const operation = (
  destinationRelativePath: string,
  bytes: Uint8Array,
  overrides: Partial<TargetWriteOperation> = {}
): TargetWriteOperation => ({
  itemId: 'review',
  kind: 'agent',
  sourcePath: 'arbitrary/review.md',
  destinationPath: path.join('/out', destinationRelativePath),
  destinationRelativePath,
  bytes,
  sourceChecksum: 'sha256:source',
  ...overrides
});

const writePlan = (operations: readonly TargetWriteOperation[]): TargetWritePlan => ({
  target,
  operations
});

describe('resolveLayout', () => {
  it('resolves canonical semantic routes', () => {
    const layout = resolveLayout(target);

    expect(layout.routes.prompt).toBe('prompts/');
    expect(layout.routes.agent).toBe('agents/');
    expect(layout.routes.skill).toBe('skills/');
  });

  it('resolves repository routes and bases', () => {
    const layout = resolveLayout({
      name: 'repo',
      type: 'vscode',
      scope: 'repository',
      rootPath: '/workspace'
    });

    expect(layout.baseDir).toBe('/workspace/.github');
    expect(layout.routes.agent).toBe('agents/');
  });

  it('resolves layouts from an injected loader', async () => {
    const layout = await resolveLayoutAsync(target, {
      load: async () => [{
        layouts: {
          vscode: {
            user: {
              baseDir: '/custom',
              kindRoutes: { prompt: 'custom-prompts/' },
              skipPaths: []
            }
          }
        }
      }]
    });

    expect(layout.baseDir).toBe('/custom');
    expect(layout.routes.prompt).toBe('custom-prompts/');
  });
});

describe('FileTreeTargetWriter', () => {
  it('writes exact destination bytes and returns installed records', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const bytes = new Uint8Array([0, 255, 1]);

    const result = await writer.write(writePlan([operation('assets/data.bin', bytes)]));

    expect(await fs.readFileBytes('/out/assets/data.bin')).toEqual(bytes);
    expect(result.installed).toEqual([expect.objectContaining({
      destinationPath: path.join('/out', 'assets/data.bin'),
      destinationRelativePath: 'assets/data.bin',
      installedChecksum: expect.stringMatching(/^sha256:/u)
    })]);
  });

  it('records transformed text checksums after transformation', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({
      fs,
      env: {},
      transformer: {
        transform: ({ content }) => ({ content: `${content}!` })
      }
    });

    const result = await writer.write(writePlan([operation('agents/review.agent.md', new TextEncoder().encode('review'))]));

    expect(await fs.readFile('/out/agents/review.agent.md')).toBe('review!');
    expect(result.installed[0].installedChecksum).not.toBe('sha256:source');
  });

  it.each(['../escape.md', '..\\escape.md'])('preflight rejects unsafe operation %s without writing', async (relativePath) => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const unsafe = operation(relativePath, new TextEncoder().encode('no'));

    await expect(writer.preflight(writePlan([unsafe]))).rejects.toThrow('unsafe');
    expect(await fs.exists('/out/escape.md')).toBe(false);
  });

  it('rejects unmanaged existing destinations and permits checksum-matching managed replacements', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed('/out/agents/review.agent.md', 'existing');
    const plan = writePlan([operation('agents/review.agent.md', new TextEncoder().encode('replacement'))]);

    await expect(new FileTreeTargetWriter({ fs, env: {} }).preflight(plan))
      .rejects.toThrow('unmanaged existing destination');

    const managedWriter = new FileTreeTargetWriter({
      fs,
      env: {},
      managedFiles: [{
        itemId: 'review',
        kind: 'agent',
        sourcePath: 'agents/review.agent.md',
        destinationPath: '/out/agents/review.agent.md',
        destinationRelativePath: 'agents/review.agent.md',
        installedChecksum: checksum(new TextEncoder().encode('existing'))
      }]
    });
    await expect(managedWriter.preflight(plan)).resolves.toBeUndefined();
  });

  it('rejects writes and removals through a routed symlink outside the target root', async () => {
    const fs = new NodeFileSystem();
    const root = await mkdtemp(path.join(tmpdir(), 'file-tree-writer-root-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'file-tree-writer-outside-'));
    const externalFile = path.join(outside, 'review.agent.md');
    await fs.writeFile(externalFile, 'outside');
    await symlink(outside, path.join(root, 'agents'));
    const writer = new FileTreeTargetWriter({
      fs,
      env: {},
      managedFiles: [
        {
          itemId: 'one', kind: 'prompt', sourcePath: 'one.md',
          destinationPath: '/out/one.md', destinationRelativePath: 'one.md',
          installedChecksum: checksum(new TextEncoder().encode('original one'))
        },
        {
          itemId: 'two', kind: 'prompt', sourcePath: 'two.md',
          destinationPath: '/out/two.md', destinationRelativePath: 'two.md',
          installedChecksum: checksum(new TextEncoder().encode('original two'))
        }
      ]
    });
    const unsafeOperation = operation('agents/review.agent.md', new TextEncoder().encode('replacement'), {
      destinationPath: path.join(root, 'agents', 'review.agent.md')
    });
    const unsafeRecord = {
      itemId: unsafeOperation.itemId,
      kind: unsafeOperation.kind,
      sourcePath: unsafeOperation.sourcePath,
      destinationPath: unsafeOperation.destinationPath,
      destinationRelativePath: unsafeOperation.destinationRelativePath,
      installedChecksum: unsafeOperation.sourceChecksum
    };

    try {
      await expect(writer.preflight(writePlan([unsafeOperation]))).rejects.toThrow('escapes target root');
      await expect(writer.remove([unsafeRecord])).rejects.toThrow('escapes target root');
      expect(await fs.readFile(externalFile)).toBe('outside');
    } finally {
      await fs.remove(root, { recursive: true });
      await fs.remove(outside, { recursive: true });
    }
  });

  it('rolls back all files after a partial write failure', async () => {
    const fs = new InMemoryFileSystem();
    const originalWrite = fs.writeFile.bind(fs);
    let writes = 0;
    fs.writeFile = async (filePath, contents) => {
      await originalWrite(filePath, contents);
      writes += 1;
      if (writes === 2) {
        throw new Error('disk full');
      }
    };
    const writer = new FileTreeTargetWriter({ fs, env: {} });

    await expect(writer.write(writePlan([
      operation('one.md', new TextEncoder().encode('one')),
      operation('two.md', new TextEncoder().encode('two'))
    ]))).rejects.toThrow('disk full');
    expect(await fs.exists('/out/one.md')).toBe(false);
    expect(await fs.exists('/out/two.md')).toBe(false);
  });

  it('restores pre-existing files after a partial write failure', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed('/out/one.md', 'original one');
    fs.seed('/out/two.md', 'original two');
    const originalWrite = fs.writeFile.bind(fs);
    let writes = 0;
    fs.writeFile = async (filePath, contents) => {
      await originalWrite(filePath, contents);
      writes += 1;
      if (writes === 2) {
        throw new Error('disk full');
      }
    };
    const writer = new FileTreeTargetWriter({
      fs,
      env: {},
      managedFiles: [
        {
          itemId: 'one', kind: 'prompt', sourcePath: 'one.md',
          destinationPath: '/out/one.md', destinationRelativePath: 'one.md',
          installedChecksum: checksum(new TextEncoder().encode('original one'))
        },
        {
          itemId: 'two', kind: 'prompt', sourcePath: 'two.md',
          destinationPath: '/out/two.md', destinationRelativePath: 'two.md',
          installedChecksum: checksum(new TextEncoder().encode('original two'))
        }
      ]
    });

    await expect(writer.write(writePlan([
      operation('one.md', new TextEncoder().encode('replacement one')),
      operation('two.md', new TextEncoder().encode('replacement two'))
    ]))).rejects.toThrow('disk full');
    expect(await fs.readFile('/out/one.md')).toBe('original one');
    expect(await fs.readFile('/out/two.md')).toBe('original two');
  });

  it('prunes empty skill directories after a partial write failure', async () => {
    const fs = new NodeFileSystem();
    const root = await mkdtemp(path.join(tmpdir(), 'file-tree-writer-'));
    const skillRoot = path.join(root, 'skills', 'review');
    const originalWrite = fs.writeFileBytes.bind(fs);
    let writes = 0;
    fs.writeFileBytes = async (filePath, bytes) => {
      await originalWrite(filePath, bytes);
      writes += 1;
      if (writes === 2) {
        throw new Error('disk full');
      }
    };
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const plan = writePlan([
      operation('skills/review/SKILL.md', new TextEncoder().encode('# Review'), {
        itemId: 'review',
        kind: 'skill',
        destinationPath: path.join(skillRoot, 'SKILL.md')
      }),
      operation('skills/review/assets/rubric.json', new TextEncoder().encode('{}'), {
        itemId: 'review',
        kind: 'skill',
        destinationPath: path.join(skillRoot, 'assets', 'rubric.json')
      })
    ]);

    try {
      await expect(writer.write(plan)).rejects.toThrow('disk full');
      expect(await fs.exists(skillRoot)).toBe(false);
    } finally {
      await fs.remove(root, { recursive: true });
    }
  });

  it('produces deterministic results for repeated input', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const plan = writePlan([
      operation('z.md', new TextEncoder().encode('z')),
      operation('a.md', new TextEncoder().encode('a'))
    ]);

    const first = await writer.write(plan);
    const second = await new FileTreeTargetWriter({ fs, env: {}, managedFiles: first.installed }).write(plan);

    expect(first.installed.map((file) => file.destinationRelativePath)).toEqual(['z.md', 'a.md']);
    expect(second.installed).toEqual(first.installed);
  });

  it('removes exactly the recorded destinations', async () => {
    const fs = new InMemoryFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const plan = writePlan([operation('keep.md', new TextEncoder().encode('keep'))]);
    const result = await writer.write(plan);
    fs.seed('/out/unrelated.md', 'unrelated');

    await writer.remove(result.installed);

    expect(await fs.exists('/out/keep.md')).toBe(false);
    expect(await fs.exists('/out/unrelated.md')).toBe(true);
  });

  it('prunes empty managed skill directories without removing unrelated siblings', async () => {
    const fs = new NodeFileSystem();
    const root = await mkdtemp(path.join(tmpdir(), 'file-tree-writer-'));
    const skillRoot = path.join(root, 'skills', 'review');
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const plan = writePlan([
      operation('skills/review/SKILL.md', new TextEncoder().encode('# Review'), {
        itemId: 'review',
        kind: 'skill',
        destinationPath: path.join(skillRoot, 'SKILL.md')
      }),
      operation('skills/review/assets/rubric.json', new TextEncoder().encode('{}'), {
        itemId: 'review',
        kind: 'skill',
        destinationPath: path.join(skillRoot, 'assets', 'rubric.json')
      })
    ]);

    try {
      const result = await writer.write(plan);
      await fs.writeFile(path.join(root, 'skills', 'unrelated.txt'), 'keep');

      await writer.remove(result.installed);

      expect(await fs.exists(skillRoot)).toBe(false);
      expect(await fs.exists(path.join(root, 'skills', 'unrelated.txt'))).toBe(true);
    } finally {
      await fs.remove(root, { recursive: true });
    }
  });

  it('prunes the skill root when the final retained record is nested', async () => {
    const fs = new NodeFileSystem();
    const root = await mkdtemp(path.join(tmpdir(), 'file-tree-writer-'));
    const skillRoot = path.join(root, 'skills', 'review');
    const writer = new FileTreeTargetWriter({ fs, env: {} });
    const plan = writePlan([operation('skills/review/assets/notes.md', new TextEncoder().encode('notes'), {
      itemId: 'review',
      kind: 'skill',
      destinationPath: path.join(skillRoot, 'assets', 'notes.md')
    })]);

    try {
      const result = await writer.write(plan);
      await fs.writeFile(path.join(root, 'skills', 'unrelated.txt'), 'keep');

      await writer.remove(result.installed);

      expect(await fs.exists(skillRoot)).toBe(false);
      expect(await fs.exists(path.join(root, 'skills', 'unrelated.txt'))).toBe(true);
    } finally {
      await fs.remove(root, { recursive: true });
    }
  });
});
