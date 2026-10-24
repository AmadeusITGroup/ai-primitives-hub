/**
 * `NodeReleaseSourceReader` tests against a real temporary Git repository.
 */
import {
  execFileSync,
} from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  NodeReleaseSourceReader,
} from '../../src/release-source/node-release-source-reader';

// Git-backed fixtures can exceed Vitest's default hook timeout on Windows CI.
const REAL_FS_HOOK_TIMEOUT_MS = 30_000;

const writeFile = (root: string, relativePath: string, content: string): void => {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
};

const git = (root: string, args: string[]): string =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('NodeReleaseSourceReader', () => {
  let repo: string;
  const reader = new NodeReleaseSourceReader();

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'release-source-test-'));
    writeFile(repo, 'LICENSE', 'Example license\n');
    writeFile(repo, 'prompts/hello.prompt.md', '# Hello\n');
    writeFile(repo, 'skills/example/SKILL.md', '# Example skill\n');
    writeFile(repo, 'skills/example/references/reference.md', '# Reference\n');
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 'test@example.invalid']);
    git(repo, ['config', 'user.name', 'Release Source Test']);
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'Fixture']);
  }, REAL_FS_HOOK_TIMEOUT_MS);

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  }, REAL_FS_HOOK_TIMEOUT_MS);

  describe('openRevision()', () => {
    it('resolves HEAD to the full lowercase commit id', async () => {
      const tree = await reader.openRevision(repo);
      expect(tree.revision).toBe(git(repo, ['rev-parse', 'HEAD']));
      expect(tree.revision).toMatch(/^[a-f0-9]{40,64}$/);
    });

    it('reads committed bytes rather than working-tree edits', async () => {
      writeFile(repo, 'prompts/hello.prompt.md', '# Edited\n');
      const tree = await reader.openRevision(repo);
      expect(decode(await tree.readFile('prompts/hello.prompt.md'))).toBe('# Hello\n');
    });

    it('lists committed files at the root and under a directory', async () => {
      writeFile(repo, 'skills/example/untracked.md', '# Untracked\n');
      const tree = await reader.openRevision(repo);
      expect((await tree.listFiles('.')).toSorted()).toEqual([
        'LICENSE',
        'prompts/hello.prompt.md',
        'skills/example/SKILL.md',
        'skills/example/references/reference.md'
      ]);
      expect((await tree.listFiles('skills/example')).toSorted()).toEqual([
        'skills/example/SKILL.md',
        'skills/example/references/reference.md'
      ]);
    });

    it('lists and reads committed files with non-ASCII names without C-quoting', async () => {
      writeFile(repo, 'skills/example/café.md', '# Café\n');
      git(repo, ['add', '.']);
      git(repo, ['commit', '-m', 'Non-ASCII file']);

      const tree = await reader.openRevision(repo);
      expect(await tree.listFiles('skills/example')).toContain('skills/example/café.md');
      expect(decode(await tree.readFile('skills/example/café.md'))).toBe('# Café\n');
    });

    it('reads a committed binary asset larger than 1 MiB byte-for-byte', async () => {
      // Exceeds Node's default spawnSync maxBuffer; includes invalid UTF-8.
      const asset = Buffer.alloc(3 * 1024 * 1024);
      for (let index = 0; index < asset.length; index += 1) {
        asset[index] = (index * 131 + 7) % 256;
      }
      asset.set([0x89, 0x50, 0x4E, 0x47, 0xFF, 0xFE, 0x80], 0);
      fs.mkdirSync(path.join(repo, 'skills/example/assets'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'skills/example/assets/large.png'), asset);
      git(repo, ['add', '.']);
      git(repo, ['commit', '-m', 'Large asset']);

      const tree = await reader.openRevision(repo);
      const bytes = await tree.readFile('skills/example/assets/large.png');
      expect(bytes.byteLength).toBe(asset.length);
      expect(Buffer.from(bytes).equals(asset)).toBe(true);
    });

    it('rejects a file that is absent at the revision', async () => {
      const tree = await reader.openRevision(repo);
      await expect(tree.readFile('prompts/missing.prompt.md')).rejects.toThrow(
        `Source file is not present at revision ${tree.revision}: prompts/missing.prompt.md`
      );
    });

    it('reports committed 100755 files as executable', async () => {
      writeFile(repo, 'skills/example/scripts/run.sh', '#!/bin/sh\necho run\n');
      git(repo, ['add', '.']);
      git(repo, ['update-index', '--chmod=+x', 'skills/example/scripts/run.sh']);
      git(repo, ['commit', '-m', 'Executable script']);

      const tree = await reader.openRevision(repo);
      expect(await tree.isExecutable?.('skills/example/scripts/run.sh')).toBe(true);
      expect(await tree.isExecutable?.('skills/example/SKILL.md')).toBe(false);
      expect(await tree.isExecutable?.('LICENSE')).toBe(false);
    });

    it.skipIf(process.platform === 'win32')('reads the committed mode, not the working-tree mode', async () => {
      fs.chmodSync(path.join(repo, 'skills/example/SKILL.md'), 0o755);
      const tree = await reader.openRevision(repo);
      expect(await tree.isExecutable?.('skills/example/SKILL.md')).toBe(false);
    });

    it('keeps committed symlinks as non-executable regular entries', async () => {
      // Stage a 120000 entry directly so the test needs no filesystem symlink support.
      const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], {
        cwd: repo,
        input: '../SKILL.md',
        encoding: 'utf8'
      }).trim();
      git(repo, ['update-index', '--add', '--cacheinfo', `120000,${oid},skills/example/link.md`]);
      git(repo, ['commit', '-m', 'Symlink']);

      const tree = await reader.openRevision(repo);
      expect(await tree.listFiles('skills/example')).toContain('skills/example/link.md');
      expect(decode(await tree.readFile('skills/example/link.md'))).toBe('../SKILL.md');
      expect(await tree.isExecutable?.('skills/example/link.md')).toBe(false);
    });

    it('reports a path absent at the revision as not executable', async () => {
      const tree = await reader.openRevision(repo);
      expect(await tree.isExecutable?.('skills/example/missing.sh')).toBe(false);
    });

    it('rejects outside a Git repository', async () => {
      const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'release-source-plain-'));
      try {
        await expect(reader.openRevision(plain)).rejects.toThrow(
          'Git command failed: git rev-parse --verify HEAD^{commit}'
        );
      } finally {
        fs.rmSync(plain, { recursive: true, force: true });
      }
    });
  });

  describe('readRemoteUrl()', () => {
    it('returns the origin URL, or an empty string without a remote', async () => {
      expect(await reader.readRemoteUrl(repo)).toBe('');
      git(repo, ['remote', 'add', 'origin', 'https://github.com/example/example.git']);
      expect(await reader.readRemoteUrl(repo)).toBe('https://github.com/example/example.git');
    });
  });

  describe('openWorkingTree()', () => {
    it('reads uncommitted edits', async () => {
      writeFile(repo, 'prompts/hello.prompt.md', '# Edited\n');
      expect(decode(await reader.openWorkingTree(repo).readFile('prompts/hello.prompt.md'))).toBe('# Edited\n');
    });

    it('rejects a missing file', async () => {
      await expect(reader.openWorkingTree(repo).readFile('prompts/missing.prompt.md')).rejects.toThrow('ENOENT');
    });

    it('lists files recursively and resolves [] for a missing directory', async () => {
      writeFile(repo, 'skills/example/untracked.md', '# Untracked\n');
      const tree = reader.openWorkingTree(repo);
      expect((await tree.listFiles('skills/example')).toSorted()).toEqual([
        'skills/example/SKILL.md',
        'skills/example/references/reference.md',
        'skills/example/untracked.md'
      ]);
      expect(await tree.listFiles('skills/missing')).toEqual([]);
    });

    it.skipIf(process.platform === 'win32')('reports the owner execute bit of working-tree files', async () => {
      const file = path.join(repo, 'skills/example/SKILL.md');
      const tree = reader.openWorkingTree(repo);
      fs.chmodSync(file, 0o755);
      expect(await tree.isExecutable?.('skills/example/SKILL.md')).toBe(true);
      fs.chmodSync(file, 0o644);
      expect(await tree.isExecutable?.('skills/example/SKILL.md')).toBe(false);
    });
  });
});
