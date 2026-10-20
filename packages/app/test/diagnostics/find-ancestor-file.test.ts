/**
 * `findAncestorFile` tests: the preflight walk of `doctor diagnostics
 * --primitives` finds a stray project config, layouts file or lockfile
 * above the run workspace, and never writes.
 */
import * as path from 'node:path';
import {
  LAYOUTS_CONFIG_FILE,
} from '@ai-primitives-hub/infra';
import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  findAncestorFile,
  LOCAL_LOCKFILE_NAME,
  LOCKFILE_NAME,
  PRIMITIVE_DIAGNOSTICS_PREFLIGHT_FILES,
} from '../../src';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

/**
 * Native absolute path of a rooted POSIX-style fixture path: on win32 it
 * gains the current drive, as every `path.join`/`path.dirname` result does.
 * @param posix - Rooted fixture path.
 * @returns Absolute path for this platform.
 */
const abs = (posix: string): string => path.resolve(posix);

describe('findAncestorFile', () => {
  it('lists the project config, layouts file and both lockfiles as preflight names', () => {
    expect(PRIMITIVE_DIAGNOSTICS_PREFLIGHT_FILES).toEqual([
      'ai-primitives-hub.yml',
      'ai-primitives-hub.yaml',
      LAYOUTS_CONFIG_FILE,
      LOCKFILE_NAME,
      LOCAL_LOCKFILE_NAME
    ]);
  });

  it.each([...PRIMITIVE_DIAGNOSTICS_PREFLIGHT_FILES])('finds %s in an ancestor of the start dir', async (name) => {
    const fs = new InMemoryFileSystem();
    fs.seed(abs(`/home/user/${name}`), 'x');

    await expect(findAncestorFile(fs, abs('/home/user/tmp/run'), PRIMITIVE_DIAGNOSTICS_PREFLIGHT_FILES))
      .resolves.toBe(abs(`/home/user/${name}`));
  });

  it('checks the start dir itself and walks up to the filesystem root', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(abs('/ai-primitives-hub.yaml'), 'x');
    fs.seed(abs('/a/b/prompt-registry.lock.json'), '{}');

    await expect(findAncestorFile(fs, abs('/a/b'), PRIMITIVE_DIAGNOSTICS_PREFLIGHT_FILES)).resolves.toBe(abs('/a/b/prompt-registry.lock.json'));
    await expect(findAncestorFile(fs, abs('/a'), PRIMITIVE_DIAGNOSTICS_PREFLIGHT_FILES)).resolves.toBe(abs('/ai-primitives-hub.yaml'));
  });

  it('returns undefined when no ancestor has a listed file, and ignores descendants', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(abs('/a/b/c/ai-primitives-hub.yml'), 'x');
    fs.seed(abs('/a/other.yml'), 'x');

    await expect(findAncestorFile(fs, abs('/a/b'), PRIMITIVE_DIAGNOSTICS_PREFLIGHT_FILES)).resolves.toBeUndefined();
  });

  it('writes nothing', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(abs('/a/ai-primitives-hub.yml'), 'x');
    const writes = [
      vi.spyOn(fs, 'writeFile'),
      vi.spyOn(fs, 'writeFileBytes'),
      vi.spyOn(fs, 'writeJson'),
      vi.spyOn(fs, 'mkdir'),
      vi.spyOn(fs, 'remove')
    ];

    await findAncestorFile(fs, abs('/a/b/c'), PRIMITIVE_DIAGNOSTICS_PREFLIGHT_FILES);

    for (const spy of writes) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});
