/**
 * Publish Collections CLI Tests
 *
 * Tests for the publish-collections.js CLI script functions.
 * These tests cover the critical CI/CD workflow functionality.
 */
import * as assert from 'node:assert';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

// Import the publish-collections module - use require for CommonJS
// When compiled to dist-test/test/, need to resolve back to lib/bin/
const libRoot = path.resolve(__dirname, '..', '..');
const publishModule = require(path.join(libRoot, 'bin', 'publish-collections.js'));

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(root: string, relativePath: string, content: string): void {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('Publish Collections CLI', () => {
  describe('computeChangedPathsFromGitDiff()', () => {
    const { computeChangedPathsFromGitDiff } = publishModule;

    it('should parse and de-dupe git output', () => {
      const mockSpawnSync = (cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'rev-parse') {
          return { status: 0 };
        }
        if (cmd === 'git' && args[0] === 'diff') {
          return {
            status: 0,
            stdout: 'prompts/a.md\nprompts/b.md\nprompts/a.md\n'
          };
        }
        return { status: 1 };
      };

      const result = computeChangedPathsFromGitDiff({
        repoRoot: '/tmp/test',
        base: 'abc123',
        head: 'def456',
        env: {},
        spawnSync: mockSpawnSync
      });

      assert.strictEqual(result.isInitialCommit, false);
      assert.deepStrictEqual(result.paths, ['prompts/a.md', 'prompts/b.md']);
    });

    it('should return isInitialCommit=true when HEAD~1 does not exist (initial commit)', () => {
      const mockSpawnSync = () => ({ status: 1 });

      const result = computeChangedPathsFromGitDiff({
        repoRoot: '/tmp/test',
        base: '0000000000000000000000000000000000000000',
        head: 'abc123',
        env: {},
        spawnSync: mockSpawnSync
      });

      assert.strictEqual(result.isInitialCommit, true);
      assert.deepStrictEqual(result.paths, []);
    });

    it('should return isInitialCommit=true when base SHA is empty string and no HEAD~1', () => {
      const mockSpawnSync = () => ({ status: 1 });

      const result = computeChangedPathsFromGitDiff({
        repoRoot: '/tmp/test',
        base: '',
        head: 'abc123',
        env: {},
        spawnSync: mockSpawnSync
      });

      assert.strictEqual(result.isInitialCommit, true);
    });

    it('should fall back to HEAD~1 when base commit does not exist (force-push scenario)', () => {
      let diffCalled = false;
      const mockSpawnSync = (cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'rev-parse') {
          const ref = args[2];
          if (ref === 'nonexistent^{commit}') {
            return { status: 1 };
          }
          if (ref === 'abc123~1^{commit}') {
            return { status: 0 };
          }
          return { status: 0 };
        }
        if (cmd === 'git' && args[0] === 'diff') {
          diffCalled = true;
          assert.ok(args.includes('abc123~1'), 'Should fall back to HEAD~1');
          return { status: 0, stdout: 'prompts/changed.md\n' };
        }
        return { status: 1 };
      };

      const result = computeChangedPathsFromGitDiff({
        repoRoot: '/tmp/test',
        base: 'nonexistent',
        head: 'abc123',
        env: {},
        spawnSync: mockSpawnSync
      });

      assert.strictEqual(diffCalled, true);
      assert.strictEqual(result.isInitialCommit, false);
      assert.deepStrictEqual(result.paths, ['prompts/changed.md']);
    });

    it('should return empty paths when head is not provided', () => {
      const result = computeChangedPathsFromGitDiff({
        repoRoot: '/tmp/test',
        base: 'abc123',
        head: '',
        env: {},
        spawnSync: () => ({ status: 0 })
      });

      assert.strictEqual(result.isInitialCommit, false);
      assert.deepStrictEqual(result.paths, []);
    });
  });

  describe('listZipEntries()', () => {
    const { listZipEntries } = publishModule;
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir('zip-test-');
    });

    afterEach(() => {
      cleanup(tempDir);
    });

    it('should return entry names from a zip file', async function () {
      this.timeout(5000);

      const archiver = require('archiver');
      const zipPath = path.join(tempDir, 'test.zip');
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      await new Promise<void>((resolve, reject) => {
        output.on('close', resolve);
        output.on('error', reject);
        archive.on('error', reject);

        archive.pipe(output);
        archive.append('content1', { name: 'file1.txt' });
        archive.append('content2', { name: 'dir/file2.txt' });
        archive.finalize();
      });

      const result = await listZipEntries(zipPath);

      assert.ok(Array.isArray(result.entries));
      assert.ok(result.entries.includes('file1.txt'));
      assert.ok(result.entries.includes('dir/file2.txt'));
    });
  });

  describe('validateGovernedReleaseAssets()', () => {
    const { validateGovernedReleaseAssets, PublishError } = publishModule;
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir('governed-release-validation-');
    });

    afterEach(() => {
      cleanup(tempDir);
    });

    it('accepts an exact standalone manifest and complete archive inventory', async () => {
      const prompt = Buffer.from('# Hello\n');
      const manifest = {
        formatVersion: 1,
        files: [{
          path: 'prompts/hello.md',
          role: 'installable',
          size: prompt.byteLength,
          sha256: `sha256:${crypto.createHash('sha256').update(prompt).digest('hex')}`
        }],
        provenance: { source: 'https://example.test/repo', revision: 'a'.repeat(40) }
      };
      const manifestPath = path.join(tempDir, 'deployment-manifest.yml');
      const manifestText = yaml.dump(manifest, { lineWidth: -1 });
      fs.writeFileSync(manifestPath, manifestText);

      await assert.doesNotReject(validateGovernedReleaseAssets({
        manifestAsset: manifestPath,
        zipAsset: path.join(tempDir, 'bundle.zip'),
        readArchive: async () => new Map([
          ['deployment-manifest.yml', Buffer.from(manifestText)],
          ['prompts/hello.md', prompt]
        ])
      }));
    });

    it('rejects an archive integrity mismatch before publication', async () => {
      const manifest = {
        formatVersion: 1,
        files: [{ path: 'prompts/hello.md', role: 'installable', size: 1, sha256: `sha256:${'0'.repeat(64)}` }],
        provenance: { source: 'https://example.test/repo', revision: 'a'.repeat(40) }
      };
      const manifestPath = path.join(tempDir, 'deployment-manifest.yml');
      const manifestText = yaml.dump(manifest, { lineWidth: -1 });
      fs.writeFileSync(manifestPath, manifestText);

      await assert.rejects(
        validateGovernedReleaseAssets({
          manifestAsset: manifestPath,
          zipAsset: path.join(tempDir, 'bundle.zip'),
          readArchive: async () => new Map([
            ['deployment-manifest.yml', Buffer.from(manifestText)],
            ['prompts/hello.md', Buffer.from('bad')]
          ])
        }),
        (error: unknown) => {
          if (!(error instanceof PublishError)) {
            return false;
          }
          return (error as { code?: string }).code === 'ARCHIVE_INTEGRITY_MISMATCH';
        }
      );
    });

    it('rejects archive content that is not declared by the inventory', async () => {
      const prompt = Buffer.from('# Hello\n');
      const manifest = {
        formatVersion: 1,
        files: [{
          path: 'prompts/hello.md',
          role: 'installable',
          size: prompt.byteLength,
          sha256: `sha256:${crypto.createHash('sha256').update(prompt).digest('hex')}`
        }],
        provenance: { source: 'https://example.test/repo', revision: 'a'.repeat(40) }
      };
      const manifestPath = path.join(tempDir, 'deployment-manifest.yml');
      const manifestText = yaml.dump(manifest, { lineWidth: -1 });
      fs.writeFileSync(manifestPath, manifestText);

      await assert.rejects(
        validateGovernedReleaseAssets({
          manifestAsset: manifestPath,
          zipAsset: path.join(tempDir, 'bundle.zip'),
          readArchive: async () => new Map([
            ['deployment-manifest.yml', Buffer.from(manifestText)],
            ['prompts/hello.md', prompt],
            ['metadata/untracked.txt', Buffer.from('not declared')]
          ])
        }),
        (error: unknown) => error instanceof PublishError
          && (error as { code?: string }).code === 'INCOMPLETE_ARCHIVE_INVENTORY'
      );
    });

    it('rejects a historical legacy manifest at the governed publication gate', async () => {
      const manifestText = yaml.dump({
        id: 'legacy-bundle',
        version: '1.0.0',
        name: 'Legacy Bundle',
        prompts: [{ id: 'hello', file: 'prompts/hello.md', type: 'prompt' }]
      });
      const manifestPath = path.join(tempDir, 'deployment-manifest.yml');
      fs.writeFileSync(manifestPath, manifestText);

      await assert.rejects(
        validateGovernedReleaseAssets({
          manifestAsset: manifestPath,
          zipAsset: path.join(tempDir, 'bundle.zip'),
          readArchive: async () => new Map([
            ['deployment-manifest.yml', Buffer.from(manifestText)],
            ['prompts/hello.md', Buffer.from('# Hello\n')]
          ])
        }),
        (error: unknown) => error instanceof PublishError
          && (error as { code?: string }).code === 'INVALID_RELEASE_MANIFEST'
      );
    });
  });

  describe('getAllCollectionFiles()', () => {
    const { getAllCollectionFiles } = publishModule;
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir('collections-test-');
    });

    afterEach(() => {
      cleanup(tempDir);
    });

    it('should return all collection files with their IDs', () => {
      writeFile(tempDir, 'collections/first.collection.yml', `
id: first-collection
name: First Collection
items: []
`);
      writeFile(tempDir, 'collections/second.collection.yml', `
id: second-collection
name: Second Collection
items: []
`);

      const result = getAllCollectionFiles(tempDir);

      assert.strictEqual(result.length, 2);
      assert.ok(result.some((r: any) => r.id === 'first-collection'));
      assert.ok(result.some((r: any) => r.id === 'second-collection'));
    });

    it('should return empty array when no collections exist', () => {
      fs.mkdirSync(path.join(tempDir, 'collections'), { recursive: true });

      const result = getAllCollectionFiles(tempDir);

      assert.strictEqual(result.length, 0);
    });
  });

  describe('main() --dry-run', () => {
    const { main } = publishModule;
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir('publish-dry-run-');
    });

    afterEach(() => {
      cleanup(tempDir);
    });

    it('should not invoke gh release create in dry-run mode', async function () {
      this.timeout(10_000);

      writeFile(tempDir, 'package.json', JSON.stringify({
        name: 'test',
        description: 'test',
        license: 'MIT',
        repository: { url: 'https://example.com/test' },
        keywords: []
      }));
      writeFile(tempDir, 'collections/test.collection.yml', `
id: test-collection
name: Test Collection
items:
  - path: prompts/test.md
    kind: prompt
`);
      writeFile(tempDir, 'prompts/test.md', '# Test Prompt');
      writeFile(tempDir, 'LICENSE', 'Test fixture license\n');

      const { spawnSync } = require('node:child_process');
      spawnSync('git', ['init'], { cwd: tempDir });
      spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tempDir });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir });
      spawnSync('git', ['add', '.'], { cwd: tempDir });
      spawnSync('git', ['commit', '-m', 'initial'], { cwd: tempDir });

      let ghReleaseCalled = false;
      const mockSpawnSync = (cmd: string, args: string[], opts: any) => {
        if (cmd === 'gh' && args[0] === 'release' && args[1] === 'create') {
          ghReleaseCalled = true;
          return { status: 0, stdout: '' };
        }
        return spawnSync(cmd, args, opts);
      };

      await main({
        repoRoot: tempDir,
        argv: ['--dry-run', '--changed-path', 'collections/test.collection.yml', '--repo-slug', 'test-owner/test-repo'],
        env: { GITHUB_TOKEN: 'fake-token' },
        spawnSync: mockSpawnSync
      });

      assert.strictEqual(ghReleaseCalled, false, 'gh release create should not be called in dry-run mode');
    });
  });
});
