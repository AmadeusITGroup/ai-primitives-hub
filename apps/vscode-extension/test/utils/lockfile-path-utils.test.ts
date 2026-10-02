import * as assert from 'node:assert';
import * as path from 'node:path';
import {
  normalizeFilesystemPath,
  normalizeLockfilePath,
  resolveLockfilePath,
} from '../../src/utils/lockfile-path-utils';

suite('Lockfile path utilities', () => {
  const repositoryRoot = path.resolve(__dirname, 'test-repository');

  test('normalizes legacy Windows separators in lockfile paths', () => {
    assert.strictEqual(
      normalizeLockfilePath('.github\\prompts\\example.prompt.md'),
      '.github/prompts/example.prompt.md'
    );
  });

  test('converts only host separators when tracking paths obtained from the filesystem', () => {
    assert.strictEqual(
      normalizeFilesystemPath(path.join('.github', 'prompts', 'example.prompt.md')),
      '.github/prompts/example.prompt.md'
    );

    if (process.platform !== 'win32') {
      assert.throws(
        () => normalizeFilesystemPath('.github/prompts/foo\\bar.md'),
        /backslash.*not supported/i,
        'Literal backslashes cannot be safely round-tripped through legacy lockfiles'
      );
    }
  });

  test('resolves a repository-relative path inside the repository', () => {
    assert.strictEqual(
      resolveLockfilePath(repositoryRoot, '.github/prompts/example.prompt.md'),
      path.join(repositoryRoot, '.github', 'prompts', 'example.prompt.md')
    );
  });

  test('rejects parent traversal using slash and backslash separators', () => {
    for (const filePath of ['../outside.txt', '..\\outside.txt', 'nested/../../outside.txt']) {
      assert.throws(
        () => resolveLockfilePath(repositoryRoot, filePath),
        /Lockfile path escapes repository root/,
        `Expected ${JSON.stringify(filePath)} to be rejected`
      );
    }
  });

  test('rejects a sibling path even when its name shares the repository prefix', () => {
    const siblingName = `${path.basename(repositoryRoot)}-backup`;

    assert.throws(
      () => resolveLockfilePath(repositoryRoot, `../${siblingName}/outside.txt`),
      /Lockfile path escapes repository root/
    );
  });
});
