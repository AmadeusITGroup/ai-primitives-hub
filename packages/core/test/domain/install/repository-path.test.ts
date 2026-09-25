import * as path from 'node:path';
import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  assertSafeRepositoryDirectoryPath,
  assertSafeRepositoryRemovalPath,
  UnsafeRepositoryPathError,
} from '../../../src/domain/install/repository-path';

const root = path.resolve('/repo');
const missing = (): Error => Object.assign(new Error('not found'), { code: 'ENOENT' });

describe('repository path containment', () => {
  it('rejects the root itself, traversal, and a sibling sharing its prefix before resolving symlinks', async () => {
    const realpath = vi.fn((filePath: string) => Promise.resolve(filePath));

    for (const candidate of [root, path.join(root, '..', 'victim'), `${root}-backup/victim`]) {
      await expect(assertSafeRepositoryRemovalPath(root, candidate, realpath))
        .rejects.toThrow(UnsafeRepositoryPathError);
    }
    expect(realpath).not.toHaveBeenCalled();
  });

  it('rejects a parent resolving outside the root even when the final file is absent', async () => {
    const parent = path.join(root, '.github', 'linked');
    const realpath = vi.fn((filePath: string) => Promise.resolve(filePath === parent ? '/outside' : filePath));

    await expect(assertSafeRepositoryRemovalPath(root, path.join(parent, 'missing.md'), realpath))
      .rejects.toThrow(/escapes repository root/);
    expect(realpath).not.toHaveBeenCalledWith(path.join(parent, 'missing.md'));
  });

  it('climbs missing parents to detect a symlink before them', async () => {
    const link = path.join(root, '.github', 'linked');
    const realpath = vi.fn((filePath: string) => {
      if (filePath === path.join(link, 'missing')) {
        return Promise.reject(missing());
      }
      return Promise.resolve(filePath === link ? '/outside' : filePath);
    });

    await expect(assertSafeRepositoryRemovalPath(root, path.join(link, 'missing', 'file.md'), realpath))
      .rejects.toThrow(/escapes repository root/);
  });

  it('allows a symlinked root and an internal parent without resolving the final link', async () => {
    const alias = '/repo-alias';
    const link = path.join(alias, '.github', 'linked');
    const candidate = path.join(link, 'final-link');
    const realpath = vi.fn((filePath: string) => {
      if (filePath === alias) {
        return Promise.resolve(root);
      }
      if (filePath === link) {
        return Promise.resolve(path.join(root, 'internal'));
      }
      return Promise.reject(new Error(`Unexpected realpath for ${filePath}`));
    });

    await expect(assertSafeRepositoryRemovalPath(alias, candidate, realpath)).resolves.toBeUndefined();
    expect(realpath).not.toHaveBeenCalledWith(candidate);
  });

  it('fails closed when the root or a parent cannot be resolved', async () => {
    const candidate = path.join(root, '.github', 'victim.md');
    await expect(assertSafeRepositoryRemovalPath(root, candidate, () => Promise.reject(new Error('permission denied'))))
      .rejects.toThrow(/cannot be checked/);
    await expect(assertSafeRepositoryRemovalPath(root, candidate, (filePath) => {
      if (filePath !== root) {
        return Promise.reject(new Error('permission denied'));
      }
      return Promise.resolve(root);
    })).rejects.toThrow(/cannot be checked/);
  });

  it('validates the final directory when a managed directory will be traversed', async () => {
    const directory = path.join(root, '.github', 'skills');
    const realpath = (filePath: string): Promise<string> => Promise.resolve(filePath === directory ? '/outside' : filePath);

    await expect(assertSafeRepositoryDirectoryPath(root, directory, realpath))
      .rejects.toThrow(/escapes repository root/);
  });
});
