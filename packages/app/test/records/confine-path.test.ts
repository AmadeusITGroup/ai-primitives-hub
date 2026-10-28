/**
 * Tests for app/records/confine-path.ts (Layer B, NFR4.1, NFR4.2).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  NodeRecordFs,
} from '@ai-primitives-hub/infra';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  confinePath,
  resolveDeleteTarget,
} from '../../src/records/confine-path';
import {
  canSymlink,
  canSymlinkFile,
  createTempDir,
  expectRecordError,
  symlinkDir,
} from './record-test-utils';

describe('confine-path', () => {
  let base: string;
  let root: string;
  let outside: string;
  let cleanup: () => void;
  const recordFs = new NodeRecordFs();

  beforeEach(() => {
    [base, cleanup] = createTempDir('confine-path-');
    root = path.join(base, 'repo');
    outside = path.join(base, 'outside');
    fs.mkdirSync(path.join(root, '.github', 'prompts'), { recursive: true });
    fs.mkdirSync(outside);
  });

  afterEach(() => {
    cleanup();
  });

  describe('confinePath', () => {
    it('accepts a path whose folders do not exist yet and normalizes separators', async () => {
      expect(await confinePath(recordFs, root, '.kiro\\steering\\style.md')).toBe('.kiro/steering/style.md');
      expect(await confinePath(recordFs, root, '.github/prompts/a.prompt.md')).toBe('.github/prompts/a.prompt.md');
    });

    it('refuses text-level problems before touching the disk (Layer A)', async () => {
      const error = await expectRecordError(confinePath(recordFs, root, '../outside/x.md', 'ai-primitives-hub.lock.json'), 'RECORD.PATH_OUTSIDE_ROOT');
      expect(error.context?.file).toBe('ai-primitives-hub.lock.json');
      await expectRecordError(confinePath(recordFs, root, '.git/config'), 'RECORD.PATH_OUTSIDE_ROOT');
    });

    it('refuses a path through a symlinked parent that points outside the root', async (context) => {
      if (!canSymlink(base)) {
        context.skip();
      }
      symlinkDir(outside, path.join(root, 'escape'));
      const error = await expectRecordError(confinePath(recordFs, root, 'escape/deep/x.md'), 'RECORD.PATH_OUTSIDE_ROOT');
      expect(String(error.context?.detail)).toContain('resolves outside the root');
    });

    it('refuses a path through a symlinked parent that resolves into .git', async (context) => {
      if (!canSymlink(base)) {
        context.skip();
      }
      fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
      symlinkDir(path.join(root, '.git', 'hooks'), path.join(root, 'hooks'));
      const error = await expectRecordError(confinePath(recordFs, root, 'hooks/pre-commit'), 'RECORD.PATH_OUTSIDE_ROOT');
      expect(String(error.context?.detail)).toContain('.git');
    });

    it('accepts a path through a symlinked parent that stays inside the root', async (context) => {
      if (!canSymlink(base)) {
        context.skip();
      }
      symlinkDir(path.join(root, '.github'), path.join(root, 'gh'));
      expect(await confinePath(recordFs, root, 'gh/prompts/a.md')).toBe('gh/prompts/a.md');
    });

    it('does not follow the leaf: a recorded symlink to a file outside is accepted', async (context) => {
      if (!canSymlinkFile(base)) {
        context.skip();
      }
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, '.github', 'prompts', 'link.md'), 'file');
      expect(await confinePath(recordFs, root, '.github/prompts/link.md')).toBe('.github/prompts/link.md');
    });

    it('refuses when the root does not resolve', async () => {
      await expectRecordError(confinePath(recordFs, path.join(base, 'no-such-root'), 'a.md'), 'RECORD.PATH_OUTSIDE_ROOT');
    });

    it.skipIf(process.platform !== 'darwin')('accepts paths under a macOS /var temp root that realpaths to /private/var', async () => {
      expect(root.startsWith('/var/')).toBe(true);
      expect(fs.realpathSync(root).startsWith('/private/var/')).toBe(true);
      expect(await confinePath(recordFs, root, '.github/prompts/a.prompt.md')).toBe('.github/prompts/a.prompt.md');
      expect(await confinePath(recordFs, fs.realpathSync(root), 'new/folder/a.md')).toBe('new/folder/a.md');
    });
  });

  describe('resolveDeleteTarget', () => {
    it('allows a regular file and returns its real absolute path', async () => {
      fs.writeFileSync(path.join(root, '.github', 'prompts', 'a.md'), 'x');
      expect(await resolveDeleteTarget(recordFs, root, '.github/prompts/a.md')).toEqual({
        status: 'delete',
        absolute: path.join(fs.realpathSync(root), '.github', 'prompts', 'a.md')
      });
    });

    it('skips a folder', async () => {
      expect(await resolveDeleteTarget(recordFs, root, '.github/prompts')).toEqual({ status: 'skip', reason: 'it is a folder' });
    });

    it('reports a missing file or a missing folder as missing', async () => {
      expect(await resolveDeleteTarget(recordFs, root, '.github/prompts/gone.md')).toEqual({ status: 'missing' });
      expect(await resolveDeleteTarget(recordFs, root, 'no/such/folder/gone.md')).toEqual({ status: 'missing' });
    });

    it('skips a text-level problem', async () => {
      expect(await resolveDeleteTarget(recordFs, root, '.git/config')).toEqual({ status: 'skip', reason: '".git" segment' });
      expect((await resolveDeleteTarget(recordFs, root, '.'))).toMatchObject({ status: 'skip' });
    });

    it('allows unlinking a symlink leaf that points outside the root', async (context) => {
      if (!canSymlinkFile(base)) {
        context.skip();
      }
      fs.writeFileSync(path.join(outside, 'target.txt'), 'x');
      fs.symlinkSync(path.join(outside, 'target.txt'), path.join(root, '.github', 'prompts', 'link.md'), 'file');
      const target = await resolveDeleteTarget(recordFs, root, '.github/prompts/link.md');
      expect(target).toEqual({ status: 'delete', absolute: path.join(fs.realpathSync(root), '.github', 'prompts', 'link.md') });
    });

    it('skips a path whose parent folder became a symlink outside the root', async (context) => {
      if (!canSymlink(base)) {
        context.skip();
      }
      fs.writeFileSync(path.join(outside, 'a.md'), 'keep me');
      fs.rmSync(path.join(root, '.github', 'prompts'), { recursive: true });
      symlinkDir(outside, path.join(root, '.github', 'prompts'));
      expect(await resolveDeleteTarget(recordFs, root, '.github/prompts/a.md')).toEqual({
        status: 'skip',
        reason: 'its folder resolves outside the root'
      });
      expect(fs.readFileSync(path.join(outside, 'a.md'), 'utf8')).toBe('keep me');
    });

    it('skips a path whose parent folder resolves into .git', async (context) => {
      if (!canSymlink(base)) {
        context.skip();
      }
      fs.mkdirSync(path.join(root, '.git'));
      fs.writeFileSync(path.join(root, '.git', 'config'), 'x');
      symlinkDir(path.join(root, '.git'), path.join(root, 'g'));
      expect(await resolveDeleteTarget(recordFs, root, 'g/config')).toEqual({
        status: 'skip',
        reason: 'its folder resolves to a path with a ".git" segment'
      });
    });
  });
});
