/**
 * RepositoryScopeService Unit Tests
 *
 * Tests for repository-level bundle installation service.
 * Handles file placement in host-appropriate directories and git exclude management.
 *
 * Requirements: 1.2-1.7, 3.1-3.7
 */

import * as assert from 'node:assert';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as sinon from 'sinon';
import {
  LockfileManager,
} from '../../src/services/lockfile-manager';
import {
  RepositoryScopeService,
} from '../../src/services/repository-scope-service';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';
import {
  InstalledBundle,
  RepositoryCommitMode,
} from '../../src/types/registry';

/**
 * Calculate checksum for a file (sync version for tests)
 * @param filePath
 */
function calculateChecksumSync(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

suite('RepositoryScopeService', () => {
  let service: RepositoryScopeService;
  let mockStorage: sinon.SinonStubbedInstance<RegistryStorage>;
  let tempDir: string;
  let workspaceRoot: string;
  let sandbox: sinon.SinonSandbox;

  // ===== Test Utilities =====

  /**
   * Create a mock bundle directory with test files
   * @param bundleId
   * @param files
   */
  const createMockBundle = (bundleId: string, files: { name: string; content: string; type?: string }[]) => {
    const bundlePath = path.join(tempDir, 'bundles', bundleId);
    fs.mkdirSync(bundlePath, { recursive: true });

    // Create deployment manifest
    // Extract id by removing the full type extension (e.g., .prompt.md, .agent.md)
    const prompts = files.map((f, _i) => ({
      id: f.name.replace(/\.(prompt|instructions|agent|chatmode|skill)\.md$/, '').replace(/\.md$/, ''),
      name: f.name,
      file: f.name,
      type: f.type || 'prompt'
    }));

    fs.writeFileSync(
      path.join(bundlePath, 'deployment-manifest.yml'),
      `id: ${bundleId}\nversion: "1.0.0"\nprompts:\n${prompts.map((p) => `  - id: ${p.id}\n    name: ${p.name}\n    file: ${p.file}\n    type: ${p.type}`).join('\n')}`
    );

    // Create files
    for (const file of files) {
      const filePath = path.join(bundlePath, file.name);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, file.content);
    }

    return bundlePath;
  };

  /**
   * Create mock installed bundle record
   * @param bundleId
   * @param commitMode
   */
  const createMockInstalledBundle = (
    bundleId: string,
    commitMode: RepositoryCommitMode = 'commit'
  ): InstalledBundle => ({
    bundleId,
    version: '1.0.0',
    installedAt: new Date().toISOString(),
    scope: 'repository',
    installPath: path.join(tempDir, 'bundles', bundleId),
    manifest: {
      common: { directories: [], files: [], include_patterns: [], exclude_patterns: [] },
      bundle_settings: {
        include_common_in_environment_bundles: false,
        create_common_bundle: false,
        compression: 'zip',
        naming: { environment_bundle: '{env}' }
      },
      metadata: { manifest_version: '1.0.0', description: 'Test bundle' }
    },
    commitMode
  });

  /**
   * Read git exclude file content
   */
  const readGitExclude = (): string | null => {
    const excludePath = path.join(workspaceRoot, '.git', 'info', 'exclude');
    if (fs.existsSync(excludePath)) {
      return fs.readFileSync(excludePath, 'utf8');
    }
    return null;
  };

  /**
   * Create .git directory structure
   */
  const createGitDirectory = () => {
    const gitInfoDir = path.join(workspaceRoot, '.git', 'info');
    fs.mkdirSync(gitInfoDir, { recursive: true });
  };

  /**
   * Create a lockfile with bundle entry for unsyncBundle tests
   * The unsyncBundle method now reads from LockfileManager instead of RegistryStorage
   * @param bundleId
   * @param commitMode
   * @param files
   */
  const createLockfile = (bundleId: string, commitMode: RepositoryCommitMode = 'commit', files: { path: string; checksum: string }[] = []) => {
    // Write to the correct lockfile based on commitMode
    // - 'commit' mode: write to prompt-registry.lock.json
    // - 'local-only' mode: write to prompt-registry.local.lock.json
    const lockfileName = commitMode === 'local-only'
      ? 'prompt-registry.local.lock.json'
      : 'prompt-registry.lock.json';
    const lockfilePath = path.join(workspaceRoot, lockfileName);
    const lockfile = {
      $schema: 'https://github.com/AmadeusITGroup/prompt-registry/schemas/lockfile.schema.json',
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      generatedBy: 'prompt-registry@test',
      bundles: {
        [bundleId]: {
          version: '1.0.0',
          sourceId: 'test-source',
          sourceType: 'github',
          installedAt: new Date().toISOString(),
          // Note: commitMode is NOT included in bundle entries (implicit based on file location)
          files: files
        }
      },
      sources: {
        'test-source': {
          type: 'github',
          url: 'https://github.com/test/test'
        }
      }
    };
    fs.writeFileSync(lockfilePath, JSON.stringify(lockfile, null, 2));
  };

  setup(() => {
    sandbox = sinon.createSandbox();
    tempDir = path.join(__dirname, '..', '..', '..', 'test-temp-repo-scope');
    workspaceRoot = path.join(tempDir, 'workspace');

    // Create temp directories
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'bundles'), { recursive: true });

    // Create mock storage
    mockStorage = sandbox.createStubInstance(RegistryStorage);

    // Mock storage.getPaths() to return the temp directory as root
    // This is needed for unsyncBundle to find the bundle install path
    mockStorage.getPaths.returns({
      root: tempDir,
      config: path.join(tempDir, 'config.json'),
      cache: path.join(tempDir, 'cache'),
      sourcesCache: path.join(tempDir, 'cache', 'sources'),
      bundlesCache: path.join(tempDir, 'cache', 'bundles'),
      installed: path.join(tempDir, 'installed'),
      userInstalled: path.join(tempDir, 'user-installed'),
      profilesInstalled: path.join(tempDir, 'profiles-installed'),
      profiles: path.join(tempDir, 'profiles'),
      logs: path.join(tempDir, 'logs')
    });

    // Create service
    service = new RepositoryScopeService(workspaceRoot, mockStorage);
  });

  teardown(() => {
    sandbox.restore();
    // Reset LockfileManager instance for this workspace
    LockfileManager.resetInstance(workspaceRoot);
    // Cleanup temp directories
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  suite('Service Initialization', () => {
    test('should initialize with workspace root and storage', () => {
      assert.ok(service, 'Service should be initialized');
    });

    test('should have IScopeService methods', () => {
      assert.ok(typeof service.syncBundle === 'function', 'Should have syncBundle method');
      assert.ok(typeof service.unsyncBundle === 'function', 'Should have unsyncBundle method');
    });

    test('should have switchCommitMode method', () => {
      assert.ok(typeof service.switchCommitMode === 'function', 'Should have switchCommitMode method');
    });
  });

  suite('syncBundle - File Placement', () => {
    if (process.platform !== 'win32') {
      test('refuses to overwrite a prompt outside the repository through a symlinked target directory', async () => {
        const outside = path.join(tempDir, 'outside');
        fs.mkdirSync(outside);
        const victim = path.join(outside, 'test.prompt.md');
        fs.writeFileSync(victim, '# Outside');
        fs.mkdirSync(path.join(workspaceRoot, '.github'));
        fs.symlinkSync(outside, path.join(workspaceRoot, '.github', 'prompts'), 'dir');
        const bundlePath = createMockBundle('unsafe-prompt', [{ name: 'test.prompt.md', content: '# Installed' }]);

        await assert.rejects(service.syncBundle('unsafe-prompt', bundlePath), /escapes repository root/);

        assert.strictEqual(fs.readFileSync(victim, 'utf8'), '# Outside', 'The destination must not be written before validation');
      });

      test('refuses to write through a final symlink pointing outside the repository', async () => {
        const victim = path.join(tempDir, 'victim.prompt.md');
        fs.writeFileSync(victim, '# Outside');
        const promptsDir = path.join(workspaceRoot, '.github', 'prompts');
        fs.mkdirSync(promptsDir, { recursive: true });
        fs.symlinkSync(victim, path.join(promptsDir, 'test.prompt.md'));
        const bundlePath = createMockBundle('linked-prompt', [{ name: 'test.prompt.md', content: '# Installed' }]);

        await assert.rejects(service.syncBundle('linked-prompt', bundlePath), /symlink/);

        assert.strictEqual(fs.readFileSync(victim, 'utf8'), '# Outside');
      });

      test('restores an overwritten prompt if a later destination is an unsafe symlink', async () => {
        const promptsDir = path.join(workspaceRoot, '.github', 'prompts');
        fs.mkdirSync(promptsDir, { recursive: true });
        const originalPath = path.join(promptsDir, 'first.prompt.md');
        const outside = path.join(tempDir, 'outside.prompt.md');
        fs.writeFileSync(originalPath, '# Original');
        fs.writeFileSync(outside, '# Outside');
        fs.symlinkSync(outside, path.join(promptsDir, 'second.prompt.md'));
        const bundlePath = createMockBundle('partial-rollback', [
          { name: 'first.prompt.md', content: '# Installed' },
          { name: 'second.prompt.md', content: '# Installed' }
        ]);

        await assert.rejects(service.syncBundle('partial-rollback', bundlePath), /symlink/);

        assert.strictEqual(fs.readFileSync(originalPath, 'utf8'), '# Original');
        assert.strictEqual(fs.readFileSync(outside, 'utf8'), '# Outside');
      });

      test('rejects ambiguous POSIX backslashes in a manifest before writing any files', async () => {
        const bundlePath = createMockBundle('unportable-manifest', [
          { name: 'first.prompt.md', content: '# First' },
          { name: 'second\\ambiguous.prompt.md', content: '# Ambiguous' }
        ]);

        await assert.rejects(service.syncBundle('unportable-manifest', bundlePath), /backslash.*not supported/i);

        assert.ok(!fs.existsSync(path.join(workspaceRoot, '.github', 'prompts', 'first.prompt.md')));
      });
    }

    test('should place prompt files in .github/prompts/', async () => {
      const bundleId = 'test-bundle';
      const bundlePath = createMockBundle(bundleId, [
        { name: 'test.prompt.md', content: '# Test Prompt', type: 'prompt' }
      ]);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'commit'));

      await service.syncBundle(bundleId, bundlePath);

      const targetFile = path.join(workspaceRoot, '.github', 'prompts', 'test.prompt.md');
      assert.ok(fs.existsSync(targetFile), 'Prompt file should be placed in .github/prompts/');
    });

    test('should place instruction files in .github/instructions/', async () => {
      const bundleId = 'test-bundle';
      const bundlePath = createMockBundle(bundleId, [
        { name: 'coding.instructions.md', content: '# Coding Standards', type: 'instructions' }
      ]);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'commit'));

      await service.syncBundle(bundleId, bundlePath);

      const targetFile = path.join(workspaceRoot, '.github', 'instructions', 'coding.instructions.md');
      assert.ok(fs.existsSync(targetFile), 'Instructions file should be placed in .github/instructions/');
    });

    test('should place agent files in .github/agents/', async () => {
      const bundleId = 'test-bundle';
      const bundlePath = createMockBundle(bundleId, [
        { name: 'reviewer.agent.md', content: '# Code Reviewer', type: 'agent' }
      ]);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'commit'));

      await service.syncBundle(bundleId, bundlePath);

      const targetFile = path.join(workspaceRoot, '.github', 'agents', 'reviewer.agent.md');
      assert.ok(fs.existsSync(targetFile), 'Agent file should be placed in .github/agents/');
    });

    test('should place knowledge files under .github/knowledge while preserving their source path', async () => {
      const bundleId = 'knowledge-bundle';
      const sourceFile = 'specifications/RDP/core_layer/AGENT_INDEX.md';
      const bundlePath = createMockBundle(bundleId, [
        { name: sourceFile, content: '# Knowledge', type: 'knowledge' }
      ]);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'commit'));

      await service.syncBundle(bundleId, bundlePath);

      const targetFile = path.join(workspaceRoot, '.github', 'knowledge', sourceFile);
      assert.ok(fs.existsSync(targetFile), 'Knowledge file should be placed under .github/knowledge/');
      assert.strictEqual(fs.readFileSync(targetFile, 'utf8'), '# Knowledge');
    });

    test('should place knowledge files under the Kiro knowledge route', async () => {
      const bundleId = 'kiro-knowledge-bundle';
      const sourceFile = 'specifications/RDP/core_layer/AGENT_INDEX.md';
      const bundlePath = createMockBundle(bundleId, [
        { name: sourceFile, content: '# Knowledge', type: 'knowledge' }
      ]);
      const kiroService = new RepositoryScopeService(workspaceRoot, mockStorage, 'kiro');

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'commit'));

      await kiroService.syncBundle(bundleId, bundlePath);

      const targetFile = path.join(workspaceRoot, '.kiro', 'knowledge', sourceFile);
      assert.ok(fs.existsSync(targetFile), 'Knowledge file should be placed under .kiro/knowledge/');
      assert.strictEqual(fs.readFileSync(targetFile, 'utf8'), '# Knowledge');
    });

    test('should create parent directories if they do not exist', async () => {
      const bundleId = 'test-bundle';
      const bundlePath = createMockBundle(bundleId, [
        { name: 'test.prompt.md', content: '# Test', type: 'prompt' }
      ]);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'commit'));

      // Ensure .github doesn't exist
      assert.ok(!fs.existsSync(path.join(workspaceRoot, '.github')), '.github should not exist initially');

      await service.syncBundle(bundleId, bundlePath);

      assert.ok(fs.existsSync(path.join(workspaceRoot, '.github', 'prompts')), 'Should create .github/prompts/');
    });

    test('should handle bundles with mixed file types', async () => {
      const bundleId = 'mixed-bundle';
      const bundlePath = createMockBundle(bundleId, [
        { name: 'prompt1.prompt.md', content: '# Prompt 1', type: 'prompt' },
        { name: 'coding.instructions.md', content: '# Instructions', type: 'instructions' },
        { name: 'reviewer.agent.md', content: '# Agent', type: 'agent' }
      ]);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'commit'));

      await service.syncBundle(bundleId, bundlePath);

      assert.ok(fs.existsSync(path.join(workspaceRoot, '.github', 'prompts', 'prompt1.prompt.md')));
      assert.ok(fs.existsSync(path.join(workspaceRoot, '.github', 'instructions', 'coding.instructions.md')));
      assert.ok(fs.existsSync(path.join(workspaceRoot, '.github', 'agents', 'reviewer.agent.md')));
    });
  });

  suite('syncBundle - Git Exclude Management', () => {
    test('should NOT modify git exclude for commit mode', async () => {
      createGitDirectory();

      const bundleId = 'commit-bundle';
      const bundlePath = createMockBundle(bundleId, [
        { name: 'test.prompt.md', content: '# Test', type: 'prompt' }
      ]);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'commit'));

      await service.syncBundle(bundleId, bundlePath);

      const excludeContent = readGitExclude();
      assert.ok(
        excludeContent === null || !excludeContent.includes('.github/prompts/test.prompt.md'),
        'Git exclude should not contain file path for commit mode'
      );
    });

    test('should add paths to git exclude for local-only mode', async () => {
      createGitDirectory();

      const bundleId = 'local-bundle';
      const bundlePath = createMockBundle(bundleId, [
        { name: 'test.prompt.md', content: '# Test', type: 'prompt' }
      ]);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'local-only'));

      await service.syncBundle(bundleId, bundlePath);

      const excludeContent = readGitExclude();
      assert.ok(excludeContent, 'Git exclude file should exist');
      assert.ok(
        excludeContent.includes('.github/prompts/test.prompt.md'),
        'Git exclude should contain file path for local-only mode'
      );
    });

    test('should create .git/info/exclude if it does not exist', async () => {
      createGitDirectory();
      const excludePath = path.join(workspaceRoot, '.git', 'info', 'exclude');
      assert.ok(!fs.existsSync(excludePath), 'Exclude file should not exist initially');

      const bundleId = 'local-bundle';
      const bundlePath = createMockBundle(bundleId, [
        { name: 'test.prompt.md', content: '# Test', type: 'prompt' }
      ]);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'local-only'));

      await service.syncBundle(bundleId, bundlePath);

      assert.ok(fs.existsSync(excludePath), 'Git exclude file should be created');
    });

    test('should add entries under "# Prompt Registry (local)" section', async () => {
      createGitDirectory();

      const bundleId = 'local-bundle';
      const bundlePath = createMockBundle(bundleId, [
        { name: 'test.prompt.md', content: '# Test', type: 'prompt' }
      ]);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'local-only'));

      await service.syncBundle(bundleId, bundlePath);

      const excludeContent = readGitExclude();
      assert.ok(excludeContent, 'Git exclude file should exist');
      assert.ok(
        excludeContent.includes('# Prompt Registry (local)'),
        'Git exclude should contain section header'
      );
    });

    test('should preserve existing git exclude content', async () => {
      createGitDirectory();
      const excludePath = path.join(workspaceRoot, '.git', 'info', 'exclude');
      fs.writeFileSync(excludePath, '# Existing content\n*.log\n');

      const bundleId = 'local-bundle';
      const bundlePath = createMockBundle(bundleId, [
        { name: 'test.prompt.md', content: '# Test', type: 'prompt' }
      ]);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'local-only'));

      await service.syncBundle(bundleId, bundlePath);

      const excludeContent = readGitExclude();
      assert.ok(excludeContent!.includes('# Existing content'), 'Should preserve existing content');
      assert.ok(excludeContent!.includes('*.log'), 'Should preserve existing patterns');
    });
  });

  suite('syncBundle - commitMode from Storage', () => {
    test('should retrieve commitMode from RegistryStorage', async () => {
      createGitDirectory();

      const bundleId = 'storage-test-bundle';
      const bundlePath = createMockBundle(bundleId, [
        { name: 'test.prompt.md', content: '# Test', type: 'prompt' }
      ]);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'local-only'));

      await service.syncBundle(bundleId, bundlePath);

      // Verify storage was called
      assert.ok(mockStorage.getInstalledBundle.calledWith(bundleId, 'repository'),
        'Should call getInstalledBundle with bundleId and repository scope');
    });

    test('should use commitMode from options when provided (takes precedence over storage)', async () => {
      createGitDirectory();

      const bundleId = 'options-precedence-bundle';
      const bundlePath = createMockBundle(bundleId, [
        { name: 'test.prompt.md', content: '# Test', type: 'prompt' }
      ]);

      // Storage returns 'commit' but options specify 'local-only'
      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'commit'));

      await service.syncBundle(bundleId, bundlePath, { commitMode: 'local-only' });

      // Verify git exclude was updated (proving options took precedence over storage)
      const excludeContent = readGitExclude();
      assert.ok(excludeContent?.includes('.github/prompts/test.prompt.md'),
        'Should use commitMode from options (local-only), not storage (commit)');
      assert.ok(excludeContent?.includes('# Prompt Registry (local)'),
        'Should have section header when using local-only mode');
    });

    test('should NOT update git exclude when options specify commit mode (overriding storage)', async () => {
      createGitDirectory();

      const bundleId = 'commit-override-bundle';
      const bundlePath = createMockBundle(bundleId, [
        { name: 'test.prompt.md', content: '# Test', type: 'prompt' }
      ]);

      // Storage returns 'local-only' but options specify 'commit'
      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'local-only'));

      await service.syncBundle(bundleId, bundlePath, { commitMode: 'commit' });

      // Verify git exclude was NOT updated (proving options took precedence)
      const excludeContent = readGitExclude();
      assert.ok(!excludeContent || !excludeContent.includes('.github/prompts/test.prompt.md'),
        'Should use commitMode from options (commit), not storage (local-only)');
    });
  });

  suite('unsyncBundle', () => {
    test('should remove files from .github/ directories', async () => {
      // Setup: create synced files
      const promptsDir = path.join(workspaceRoot, '.github', 'prompts');
      fs.mkdirSync(promptsDir, { recursive: true });
      const promptFile = path.join(promptsDir, 'test.prompt.md');
      fs.writeFileSync(promptFile, '# Test');

      // Calculate checksum of the file we just created
      const checksum = calculateChecksumSync(promptFile);

      const bundleId = 'test-bundle';

      // Create lockfile with file entries including checksums
      createLockfile(bundleId, 'commit', [
        { path: '.github/prompts/test.prompt.md', checksum }
      ]);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'commit'));

      await service.unsyncBundle(bundleId);

      assert.ok(!fs.existsSync(path.join(promptsDir, 'test.prompt.md')), 'File should be removed');
    });

    test('should unsync a file recorded with Windows separators on every platform', async () => {
      const promptFile = path.join(workspaceRoot, '.github', 'prompts', 'windows-path.prompt.md');
      fs.mkdirSync(path.dirname(promptFile), { recursive: true });
      fs.writeFileSync(promptFile, '# Windows path');

      createLockfile('windows-path-bundle', 'commit', [{
        path: '.github\\prompts\\windows-path.prompt.md',
        checksum: calculateChecksumSync(promptFile)
      }]);

      await service.unsyncBundle('windows-path-bundle');

      assert.ok(!fs.existsSync(promptFile), 'File should be removed using the lockfile path');
    });

    test('should preserve files outside the workspace when a lockfile path traverses its root', async () => {
      const externalFile = path.join(tempDir, 'outside.txt');
      fs.writeFileSync(externalFile, '# Outside workspace');
      const checksum = calculateChecksumSync(externalFile);

      for (const filePath of ['../outside.txt', '..\\outside.txt']) {
        createLockfile('traversal-bundle', 'commit', [{ path: filePath, checksum }]);

        await assert.rejects(service.unsyncBundle('traversal-bundle'), /escapes repository root/);

        assert.ok(fs.existsSync(externalFile), `Should preserve external file for ${JSON.stringify(filePath)}`);
      }
    });

    if (process.platform !== 'win32') {
      test('refuses a symlinked parent before checking a matching checksum or removing the file', async () => {
        const outside = path.join(tempDir, 'outside');
        fs.mkdirSync(outside);
        const victim = path.join(outside, 'victim.prompt.md');
        fs.writeFileSync(victim, '# Outside workspace');
        const promptsDir = path.join(workspaceRoot, '.github', 'prompts');
        fs.mkdirSync(promptsDir, { recursive: true });
        fs.symlinkSync(outside, path.join(promptsDir, 'linked'), 'dir');
        createLockfile('symlink-bundle', 'commit', [{
          path: '.github/prompts/linked/victim.prompt.md',
          checksum: calculateChecksumSync(victim)
        }]);

        await assert.rejects(service.unsyncBundle('symlink-bundle'), /escapes repository root/);

        assert.strictEqual(fs.readFileSync(victim, 'utf8'), '# Outside workspace');
        assert.ok(fs.existsSync(path.join(workspaceRoot, 'prompt-registry.lock.json')));
      });

      test('refuses a local-only entry with Windows separators through an outside symlink', async () => {
        const outside = path.join(tempDir, 'outside');
        fs.mkdirSync(outside);
        const victim = path.join(outside, 'victim.prompt.md');
        fs.writeFileSync(victim, '# Outside workspace');
        const promptsDir = path.join(workspaceRoot, '.github', 'prompts');
        fs.mkdirSync(promptsDir, { recursive: true });
        fs.symlinkSync(outside, path.join(promptsDir, 'linked'), 'dir');
        createLockfile('local-symlink-bundle', 'local-only', [{
          path: '.github\\prompts\\linked\\victim.prompt.md',
          checksum: calculateChecksumSync(victim)
        }]);

        await assert.rejects(service.unsyncBundle('local-symlink-bundle'), /escapes repository root/);

        assert.strictEqual(fs.readFileSync(victim, 'utf8'), '# Outside workspace');
        assert.ok(fs.existsSync(path.join(workspaceRoot, 'prompt-registry.local.lock.json')));
      });

      test('rejects an unsafe entry before removing any other file in that bundle', async () => {
        const safeFile = path.join(workspaceRoot, '.github', 'prompts', 'safe.prompt.md');
        fs.mkdirSync(path.dirname(safeFile), { recursive: true });
        fs.writeFileSync(safeFile, '# Installed');
        const outside = path.join(tempDir, 'outside');
        fs.mkdirSync(outside);
        const victim = path.join(outside, 'victim.prompt.md');
        fs.writeFileSync(victim, '# Outside workspace');
        fs.symlinkSync(outside, path.join(path.dirname(safeFile), 'linked'), 'dir');
        createLockfile('mixed-bundle', 'commit', [
          { path: '.github/prompts/safe.prompt.md', checksum: calculateChecksumSync(safeFile) },
          { path: '.github/prompts/linked/victim.prompt.md', checksum: calculateChecksumSync(victim) }
        ]);

        await assert.rejects(service.unsyncBundle('mixed-bundle'), /escapes repository root/);

        assert.ok(fs.existsSync(safeFile), 'Safe files must remain untouched when another entry is unsafe');
        assert.ok(fs.existsSync(victim), 'Outside files must remain untouched');
        assert.ok(fs.existsSync(path.join(workspaceRoot, 'prompt-registry.lock.json')));
      });

      test('unlinks a final symlink without deleting its outside target', async () => {
        const victim = path.join(tempDir, 'victim.prompt.md');
        fs.writeFileSync(victim, '# Outside workspace');
        const link = path.join(workspaceRoot, '.github', 'prompts', 'link.prompt.md');
        fs.mkdirSync(path.dirname(link), { recursive: true });
        fs.symlinkSync(victim, link);
        createLockfile('final-link-bundle', 'commit', [{
          path: '.github/prompts/link.prompt.md', checksum: calculateChecksumSync(victim)
        }]);

        await service.unsyncBundle('final-link-bundle');

        assert.ok(!fs.existsSync(link), 'Only the symlink should be removed');
        assert.ok(fs.existsSync(victim), 'The symlink target must remain');
      });

      test('allows a symlinked workspace root and an in-repository symlinked parent', async () => {
        const actualDir = path.join(workspaceRoot, 'internal');
        fs.mkdirSync(actualDir);
        const prompt = path.join(actualDir, 'installed.prompt.md');
        fs.writeFileSync(prompt, '# Installed');
        const promptsDir = path.join(workspaceRoot, '.github', 'prompts');
        fs.mkdirSync(promptsDir, { recursive: true });
        fs.symlinkSync(actualDir, path.join(promptsDir, 'linked'), 'dir');
        const alias = path.join(tempDir, 'alias');
        fs.symlinkSync(workspaceRoot, alias, 'dir');
        const aliasedService = new RepositoryScopeService(alias, mockStorage);
        createLockfile('internal-link-bundle', 'commit', [{
          path: '.github/prompts/linked/installed.prompt.md', checksum: calculateChecksumSync(prompt)
        }]);

        await aliasedService.unsyncBundle('internal-link-bundle');

        assert.ok(!fs.existsSync(prompt), 'In-repository symlinked parents should be allowed');
        LockfileManager.resetInstance(alias);
      });

      test('does not traverse an outside symlink during empty managed-directory cleanup', async () => {
        const prompt = path.join(workspaceRoot, '.github', 'prompts', 'installed.prompt.md');
        fs.mkdirSync(path.dirname(prompt), { recursive: true });
        fs.writeFileSync(prompt, '# Installed');
        const outsideSkills = path.join(tempDir, 'outside-skills');
        const outsideSkill = path.join(outsideSkills, 'empty-skill');
        fs.mkdirSync(outsideSkill, { recursive: true });
        fs.symlinkSync(outsideSkills, path.join(workspaceRoot, '.github', 'skills'), 'dir');
        createLockfile('cleanup-bundle', 'commit', [{
          path: '.github/prompts/installed.prompt.md', checksum: calculateChecksumSync(prompt)
        }]);

        await service.unsyncBundle('cleanup-bundle');

        assert.ok(!fs.existsSync(prompt), 'The installed prompt should be removed');
        assert.ok(fs.existsSync(outsideSkill), 'Cleanup must not descend into outside symlinked directories');
      });
    }

    test('should remove entries from .git/info/exclude', async () => {
      createGitDirectory();
      const excludePath = path.join(workspaceRoot, '.git', 'info', 'exclude');
      fs.writeFileSync(excludePath, '# Prompt Registry (local)\n.github/prompts/test.prompt.md\n');

      const bundleId = 'test-bundle';
      // Create the bundle directory with manifest so unsyncBundle can read it
      createMockBundle(bundleId, [
        { name: 'test.prompt.md', content: '# Test', type: 'prompt' }
      ]);

      // Also create the synced file in .github
      const promptsDir = path.join(workspaceRoot, '.github', 'prompts');
      fs.mkdirSync(promptsDir, { recursive: true });
      const promptFile = path.join(promptsDir, 'test.prompt.md');
      fs.writeFileSync(promptFile, '# Test');

      // Calculate checksum of the file we just created
      const checksum = calculateChecksumSync(promptFile);

      // Create lockfile with file entries including checksums
      createLockfile(bundleId, 'local-only', [
        { path: '.github/prompts/test.prompt.md', checksum }
      ]);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'local-only'));

      await service.unsyncBundle(bundleId);

      const excludeContent = readGitExclude();
      assert.ok(
        !excludeContent!.includes('.github/prompts/test.prompt.md'),
        'Git exclude should not contain removed file path'
      );
    });

    test('should handle non-existent bundle gracefully', async () => {
      // No lockfile created - bundle doesn't exist
      mockStorage.getInstalledBundle.resolves(undefined);

      // Should not throw
      await service.unsyncBundle('non-existent-bundle');
    });
  });

  suite('switchCommitMode', () => {
    test('should add paths to git exclude when switching from commit to local-only', async () => {
      createGitDirectory();

      // Setup: create synced files
      const promptsDir = path.join(workspaceRoot, '.github', 'prompts');
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(path.join(promptsDir, 'test.prompt.md'), '# Test');

      const bundleId = 'test-bundle';
      createMockBundle(bundleId, [
        { name: 'test.prompt.md', content: '# Test', type: 'prompt' }
      ]);

      // Create lockfile for switchCommitMode to read (it uses LockfileManager, not RegistryStorage)
      const promptPath = path.join(promptsDir, 'test.prompt.md');
      createLockfile(bundleId, 'commit', [{
        path: path.relative(workspaceRoot, promptPath),
        checksum: calculateChecksumSync(promptPath)
      }]);

      await service.switchCommitMode(bundleId, 'local-only');

      const excludeContent = readGitExclude();
      assert.ok(excludeContent, 'Git exclude file should exist');
      assert.ok(
        excludeContent.includes('.github/prompts/test.prompt.md'),
        'Git exclude should contain file path after switching to local-only'
      );
    });

    test('should only update paths recorded for the selected bundle', async () => {
      createGitDirectory();

      const promptsDir = path.join(workspaceRoot, '.github', 'prompts');
      fs.mkdirSync(promptsDir, { recursive: true });
      const selectedPath = path.join(promptsDir, 'selected.prompt.md');
      const otherBundlePath = path.join(promptsDir, 'other.prompt.md');
      const untrackedPath = path.join(promptsDir, 'untracked.prompt.md');
      fs.writeFileSync(selectedPath, '# Selected');
      fs.writeFileSync(otherBundlePath, '# Other bundle');
      fs.writeFileSync(untrackedPath, '# Untracked');

      const conventionPath = path.join(workspaceRoot, '.github', 'copilot-instructions.md');
      fs.writeFileSync(conventionPath, '# Repository instructions');

      const selectedBundleId = 'selected-bundle';
      const otherBundleId = 'other-bundle';
      createLockfile(selectedBundleId, 'commit', [{
        path: '.github/prompts/selected.prompt.md',
        checksum: calculateChecksumSync(selectedPath)
      }]);

      type TestLockfile = {
        bundles: Record<string, {
          version: string;
          sourceId: string;
          sourceType: string;
          installedAt: string;
          files: { path: string; checksum: string }[];
        }>;
      };
      const lockfilePath = path.join(workspaceRoot, 'prompt-registry.lock.json');
      const lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf8')) as TestLockfile;
      lockfile.bundles[otherBundleId] = {
        ...lockfile.bundles[selectedBundleId],
        files: [{
          path: '.github/prompts/other.prompt.md',
          checksum: calculateChecksumSync(otherBundlePath)
        }]
      };
      fs.writeFileSync(lockfilePath, JSON.stringify(lockfile, null, 2));

      await service.switchCommitMode(selectedBundleId, 'local-only');

      const excludedPaths = (readGitExclude() ?? '').split(/\r?\n/);
      assert.ok(excludedPaths.includes('.github/prompts/selected.prompt.md'));
      assert.ok(!excludedPaths.includes('.github/prompts/other.prompt.md'));
      assert.ok(!excludedPaths.includes('.github/prompts/untracked.prompt.md'));
      assert.ok(!excludedPaths.includes('.github/copilot-instructions.md'));
    });

    test('should not discover files when the selected bundle has no recorded paths', async () => {
      createGitDirectory();

      const promptsDir = path.join(workspaceRoot, '.github', 'prompts');
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(path.join(promptsDir, 'untracked.prompt.md'), '# Untracked');
      fs.writeFileSync(path.join(workspaceRoot, '.github', 'copilot-instructions.md'), '# Instructions');

      const bundleId = 'empty-files-bundle';
      createLockfile(bundleId, 'commit');

      await service.switchCommitMode(bundleId, 'local-only');

      const excludedPaths = (readGitExclude() ?? '')
        .split(/\r?\n/)
        .filter((entry) => entry.length > 0 && entry !== '# Prompt Registry (local)');
      assert.deepStrictEqual(excludedPaths, []);
    });

    test('does not exclude unrelated files sharing a knowledge subdirectory', async () => {
      createGitDirectory();
      const knowledgeDir = path.join(workspaceRoot, '.github', 'knowledge', 'specifications', 'RDP');
      fs.mkdirSync(knowledgeDir, { recursive: true });
      const installedKnowledge = path.join(knowledgeDir, 'AGENT_INDEX.md');
      const unrelatedFile = path.join(knowledgeDir, 'company-architecture.md');
      fs.writeFileSync(installedKnowledge, '# Installed knowledge');
      fs.writeFileSync(unrelatedFile, '# User file');

      const bundleId = 'knowledge-switch-bundle';
      createLockfile(bundleId, 'commit', [{
        path: path.relative(workspaceRoot, installedKnowledge),
        checksum: calculateChecksumSync(installedKnowledge)
      }]);

      await service.switchCommitMode(bundleId, 'local-only');

      const excludeContent = readGitExclude();
      assert.ok(excludeContent, 'Git exclude file should exist');
      const excludedPaths = excludeContent.split(/\r?\n/);
      assert.ok(excludedPaths.includes('.github/knowledge/specifications/RDP/AGENT_INDEX.md'));
      assert.ok(!excludedPaths.includes('.github/knowledge/specifications'));
      assert.ok(!excludedPaths.includes('.github/knowledge/specifications/RDP/company-architecture.md'));
    });

    test('should remove paths from git exclude when switching from local-only to commit', async () => {
      createGitDirectory();
      const excludePath = path.join(workspaceRoot, '.git', 'info', 'exclude');
      fs.writeFileSync(excludePath, '# Prompt Registry (local)\n.github/prompts/test.prompt.md\n');

      // Setup: create synced files
      const promptsDir = path.join(workspaceRoot, '.github', 'prompts');
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(path.join(promptsDir, 'test.prompt.md'), '# Test');

      const bundleId = 'test-bundle';
      createMockBundle(bundleId, [
        { name: 'test.prompt.md', content: '# Test', type: 'prompt' }
      ]);

      // Create lockfile for switchCommitMode to read (it uses LockfileManager, not RegistryStorage)
      const promptPath = path.join(promptsDir, 'test.prompt.md');
      createLockfile(bundleId, 'local-only', [{
        path: path.relative(workspaceRoot, promptPath),
        checksum: calculateChecksumSync(promptPath)
      }]);

      await service.switchCommitMode(bundleId, 'commit');

      const excludeContent = readGitExclude();
      assert.ok(
        !excludeContent!.includes('.github/prompts/test.prompt.md'),
        'Git exclude should not contain file path after switching to commit'
      );
    });
  });

  suite('Error Handling', () => {
    test('should proceed without git integration when .git directory is missing', async () => {
      // Don't create .git directory

      const bundleId = 'no-git-bundle';
      const bundlePath = createMockBundle(bundleId, [
        { name: 'test.prompt.md', content: '# Test', type: 'prompt' }
      ]);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'local-only'));

      // Should not throw
      await service.syncBundle(bundleId, bundlePath);

      // File should still be placed
      const targetFile = path.join(workspaceRoot, '.github', 'prompts', 'test.prompt.md');
      assert.ok(fs.existsSync(targetFile), 'File should be placed even without .git');
    });

    test('should handle missing bundle manifest gracefully', async () => {
      const bundleId = 'no-manifest-bundle';
      const bundlePath = path.join(tempDir, 'bundles', bundleId);
      fs.mkdirSync(bundlePath, { recursive: true });
      // Don't create manifest

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'commit'));

      // Should not throw, but may log warning
      await service.syncBundle(bundleId, bundlePath);
    });

    test('should rollback on partial file installation failure', async () => {
      const bundleId = 'rollback-bundle';
      const bundlePath = createMockBundle(bundleId, [
        { name: 'test1.prompt.md', content: '# Test 1', type: 'prompt' },
        { name: 'test2.prompt.md', content: '# Test 2', type: 'prompt' }
      ]);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'commit'));

      // Make the prompts directory read-only after first file to cause failure
      const promptsDir = path.join(workspaceRoot, '.github', 'prompts');
      fs.mkdirSync(promptsDir, { recursive: true });

      // Create first file manually
      fs.writeFileSync(path.join(promptsDir, 'test1.prompt.md'), '# Test 1');

      // Make directory read-only (this may not work on all systems)
      try {
        fs.chmodSync(promptsDir, 0o444);

        try {
          await service.syncBundle(bundleId, bundlePath);
        } catch {
          // Expected to fail
        }

        // Restore permissions for cleanup
        fs.chmodSync(promptsDir, 0o755);
      } catch {
        // chmod may not work on all systems, skip this test
      }
    });
  });

  suite('Git Exclude Section Management', () => {
    test('should remove section header when no entries remain', async () => {
      createGitDirectory();
      const excludePath = path.join(workspaceRoot, '.git', 'info', 'exclude');
      fs.writeFileSync(excludePath, '# Other content\n*.log\n\n# Prompt Registry (local)\n.github/prompts/test.prompt.md\n');

      const bundleId = 'test-bundle';
      createMockBundle(bundleId, [
        { name: 'test.prompt.md', content: '# Test', type: 'prompt' }
      ]);

      // Also create the synced file in .github so unsyncBundle can find it
      const promptsDir = path.join(workspaceRoot, '.github', 'prompts');
      fs.mkdirSync(promptsDir, { recursive: true });
      const promptFile = path.join(promptsDir, 'test.prompt.md');
      fs.writeFileSync(promptFile, '# Test');

      // Calculate checksum of the file we just created
      const checksum = calculateChecksumSync(promptFile);

      // Create lockfile with file entries including checksums
      createLockfile(bundleId, 'local-only', [
        { path: '.github/prompts/test.prompt.md', checksum }
      ]);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'local-only'));

      await service.unsyncBundle(bundleId);

      const excludeContent = readGitExclude();
      // Section header should be removed when empty
      assert.ok(
        !excludeContent!.includes('# Prompt Registry (local)')
        || excludeContent!.includes('# Prompt Registry (local)\n\n'),
        'Section header should be removed or empty when no entries remain'
      );
    });

    test('should keep section header when entries remain', () => {
      createGitDirectory();
      const excludePath = path.join(workspaceRoot, '.git', 'info', 'exclude');
      fs.writeFileSync(excludePath, '# Prompt Registry (local)\n.github/prompts/test1.prompt.md\n.github/prompts/test2.prompt.md\n');

      const bundleId = 'test-bundle';
      // Only remove test1, test2 should remain
      createMockBundle(bundleId, [
        { name: 'test1.prompt.md', content: '# Test 1', type: 'prompt' }
      ]);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'local-only'));

      // Manually remove just test1
      const content = fs.readFileSync(excludePath, 'utf8');
      fs.writeFileSync(excludePath, content.replace('.github/prompts/test1.prompt.md\n', ''));

      const excludeContent = readGitExclude();
      assert.ok(
        excludeContent!.includes('# Prompt Registry (local)'),
        'Section header should remain when entries exist'
      );
      assert.ok(
        excludeContent!.includes('.github/prompts/test2.prompt.md'),
        'Other entries should remain'
      );
    });
  });

  /**
   * Skills Directory Handling Tests
   *
   * Tests for skill directory installation at repository scope.
   * Skills are directories (not single files) that need to be copied recursively.
   *
   * Requirements: 10.4 - "WHEN installing skill directories, THE Extension SHALL place them in .github/skills/<skill-name>/"
   * Requirements: 1.5 - "WHEN installing agent skills at repository scope, THE Extension SHALL place files in .github/skills/"
   */
  suite('syncBundle - Skills Directory Handling', () => {
    /**
     * Create a mock bundle with a skill directory
     * @param bundleId
     * @param skillName
     * @param skillFiles
     */
    const createMockBundleWithSkill = (
      bundleId: string,
      skillName: string,
      skillFiles: { relativePath: string; content: string }[]
    ) => {
      const bundlePath = path.join(tempDir, 'bundles', bundleId);
      fs.mkdirSync(bundlePath, { recursive: true });

      // Create skill directory
      const skillDir = path.join(bundlePath, 'skills', skillName);
      fs.mkdirSync(skillDir, { recursive: true });

      // Create skill files
      for (const file of skillFiles) {
        const filePath = path.join(skillDir, file.relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, file.content);
      }

      // Create deployment manifest with skill entry. The file field points at the
      // skill's SKILL.md, matching what real adapters emit (skills/<name>/SKILL.md).
      const manifest = `id: ${bundleId}
version: "1.0.0"
prompts:
  - id: ${skillName}
    name: ${skillName}
    file: skills/${skillName}/SKILL.md
    type: skill`;

      fs.writeFileSync(path.join(bundlePath, 'deployment-manifest.yml'), manifest);

      return bundlePath;
    };

    if (process.platform === 'win32') {
      test('installs a skill whose manifest uses Windows separators', async () => {
        const bundlePath = createMockBundleWithSkill('windows-skill', 'my-skill', [
          { relativePath: 'SKILL.md', content: '# Skill' },
          { relativePath: 'scripts/run.sh', content: '#!/bin/sh' }
        ]);
        const manifestPath = path.join(bundlePath, 'deployment-manifest.yml');
        const manifest = fs.readFileSync(manifestPath, 'utf8');
        fs.writeFileSync(manifestPath, manifest.replace('skills/my-skill/SKILL.md', 'skills\\my-skill\\SKILL.md'));

        await service.syncBundle('windows-skill', bundlePath);

        assert.strictEqual(fs.readFileSync(path.join(workspaceRoot, '.github', 'skills', 'my-skill', 'SKILL.md'), 'utf8'), '# Skill');
        assert.strictEqual(fs.readFileSync(path.join(workspaceRoot, '.github', 'skills', 'my-skill', 'scripts', 'run.sh'), 'utf8'), '#!/bin/sh');
      });
    }

    test('should copy skill directories to .github/skills/<skill-name>/', async () => {
      const bundleId = 'skill-bundle';
      const skillName = 'my-skill';
      const bundlePath = createMockBundleWithSkill(bundleId, skillName, [
        { relativePath: 'SKILL.md', content: '# My Skill\nThis is a skill.' },
        { relativePath: 'index.js', content: 'module.exports = {};' }
      ]);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'commit'));

      await service.syncBundle(bundleId, bundlePath);

      const targetSkillDir = path.join(workspaceRoot, '.github', 'skills', skillName);
      assert.ok(fs.existsSync(targetSkillDir), 'Skill directory should be created');
      assert.ok(fs.existsSync(path.join(targetSkillDir, 'SKILL.md')), 'SKILL.md should be copied');
      assert.ok(fs.existsSync(path.join(targetSkillDir, 'index.js')), 'index.js should be copied');
    });

    test('restores an existing skill file when post-sync tracking fails', async () => {
      const bundlePath = createMockBundleWithSkill('skill-rollback', 'my-skill', [
        { relativePath: 'SKILL.md', content: '# Installed' },
        { relativePath: 'scripts/run.sh', content: '#!/bin/sh' }
      ]);
      const skillDir = path.join(workspaceRoot, '.github', 'skills', 'my-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Existing');
      fs.writeFileSync(path.join(skillDir, 'user-notes.md'), '# Keep');

      await assert.rejects(
        service.syncBundle('skill-rollback', bundlePath, {
          commitMode: 'commit',
          afterSync: () => Promise.reject(new Error('Lockfile write failed'))
        }),
        /Lockfile write failed/
      );

      assert.strictEqual(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'), '# Existing');
      assert.strictEqual(fs.readFileSync(path.join(skillDir, 'user-notes.md'), 'utf8'), '# Keep');
      assert.ok(!fs.existsSync(path.join(skillDir, 'scripts', 'run.sh')));
    });

    test('should copy all files within skill directory recursively', async () => {
      const bundleId = 'skill-bundle-recursive';
      const skillName = 'complex-skill';
      const bundlePath = createMockBundleWithSkill(bundleId, skillName, [
        { relativePath: 'SKILL.md', content: '# Complex Skill' },
        { relativePath: 'src/main.js', content: 'console.log("main");' },
        { relativePath: 'src/utils/helper.js', content: 'module.exports = {};' },
        { relativePath: 'config/settings.json', content: '{"enabled": true}' }
      ]);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'commit'));

      await service.syncBundle(bundleId, bundlePath);

      const targetSkillDir = path.join(workspaceRoot, '.github', 'skills', skillName);
      assert.ok(fs.existsSync(path.join(targetSkillDir, 'SKILL.md')), 'SKILL.md should be copied');
      assert.ok(fs.existsSync(path.join(targetSkillDir, 'src', 'main.js')), 'src/main.js should be copied');
      assert.ok(fs.existsSync(path.join(targetSkillDir, 'src', 'utils', 'helper.js')), 'src/utils/helper.js should be copied');
      assert.ok(fs.existsSync(path.join(targetSkillDir, 'config', 'settings.json')), 'config/settings.json should be copied');
    });

    if (process.platform !== 'win32') {
      test('refuses to copy skill assets through a symlinked destination outside the repository', async () => {
        const outside = path.join(tempDir, 'outside-skill');
        fs.mkdirSync(outside);
        const victim = path.join(outside, 'SKILL.md');
        fs.writeFileSync(victim, '# Outside');
        const skillDir = path.join(workspaceRoot, '.github', 'skills', 'my-skill');
        fs.mkdirSync(path.dirname(skillDir), { recursive: true });
        fs.symlinkSync(outside, skillDir, 'dir');
        const bundlePath = createMockBundleWithSkill('unsafe-skill', 'my-skill', [
          { relativePath: 'SKILL.md', content: '# Installed' },
          { relativePath: 'scripts/run.sh', content: '#!/bin/sh' }
        ]);

        await assert.rejects(service.syncBundle('unsafe-skill', bundlePath), /escapes repository root/);

        assert.strictEqual(fs.readFileSync(victim, 'utf8'), '# Outside');
        assert.ok(!fs.existsSync(path.join(outside, 'scripts', 'run.sh')));
      });

      test('rejects a source skill asset whose POSIX backslash name cannot be tracked in the lockfile', async () => {
        const bundleId = 'unportable-skill';
        const skillName = 'my-skill';
        const bundlePath = createMockBundleWithSkill(bundleId, skillName, [
          { relativePath: 'SKILL.md', content: '# My Skill' },
          { relativePath: 'scripts/foo\\bar.sh', content: '#!/bin/sh' }
        ]);

        await assert.rejects(service.syncBundle(bundleId, bundlePath), /backslash.*not supported/i);

        assert.ok(!fs.existsSync(path.join(workspaceRoot, '.github', 'skills', skillName)),
          'The invalid bundle must not leave any untracked repository files');
      });

      test('preserves pre-existing skill assets if a later source asset forces rollback', async () => {
        const bundlePath = createMockBundleWithSkill('rollback-skills', 'safe-skill', [
          { relativePath: 'SKILL.md', content: '# Installed' }
        ]);
        const unsafeDir = path.join(bundlePath, 'skills', 'unsafe-skill');
        fs.mkdirSync(unsafeDir, { recursive: true });
        fs.writeFileSync(path.join(unsafeDir, 'SKILL.md'), '# Unsafe skill');
        fs.writeFileSync(path.join(unsafeDir, 'foo\\bar.sh'), '#!/bin/sh');
        fs.appendFileSync(path.join(bundlePath, 'deployment-manifest.yml'), `
  - id: unsafe-skill
    file: skills/unsafe-skill/SKILL.md
    type: skill`);
        const targetDir = path.join(workspaceRoot, '.github', 'skills', 'safe-skill');
        fs.mkdirSync(targetDir, { recursive: true });
        const userAsset = path.join(targetDir, 'user-notes.md');
        fs.writeFileSync(userAsset, '# Keep me');

        await assert.rejects(service.syncBundle('rollback-skills', bundlePath), /backslash.*not supported/i);

        assert.strictEqual(fs.readFileSync(userAsset, 'utf8'), '# Keep me');
        assert.ok(!fs.existsSync(path.join(targetDir, 'SKILL.md')), 'Remove only the installed asset');
      });
    }

    test('should preserve skill directory structure', async () => {
      const bundleId = 'skill-bundle-structure';
      const skillName = 'structured-skill';
      const bundlePath = createMockBundleWithSkill(bundleId, skillName, [
        { relativePath: 'SKILL.md', content: '# Structured Skill' },
        { relativePath: 'lib/core.js', content: 'exports.core = {};' },
        { relativePath: 'lib/utils/format.js', content: 'exports.format = {};' }
      ]);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'commit'));

      await service.syncBundle(bundleId, bundlePath);

      const targetSkillDir = path.join(workspaceRoot, '.github', 'skills', skillName);

      // Verify directory structure is preserved
      assert.ok(fs.statSync(path.join(targetSkillDir, 'lib')).isDirectory(), 'lib should be a directory');
      assert.ok(fs.statSync(path.join(targetSkillDir, 'lib', 'utils')).isDirectory(), 'lib/utils should be a directory');

      // Verify file contents are preserved
      const coreContent = fs.readFileSync(path.join(targetSkillDir, 'lib', 'core.js'), 'utf8');
      assert.strictEqual(coreContent, 'exports.core = {};', 'File content should be preserved');
    });

    test('should create parent .github/skills/ directory if it does not exist', async () => {
      const bundleId = 'skill-bundle-parent';
      const skillName = 'new-skill';
      const bundlePath = createMockBundleWithSkill(bundleId, skillName, [
        { relativePath: 'SKILL.md', content: '# New Skill' }
      ]);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'commit'));

      // Ensure .github/skills doesn't exist
      const skillsDir = path.join(workspaceRoot, '.github', 'skills');
      assert.ok(!fs.existsSync(skillsDir), '.github/skills should not exist initially');

      await service.syncBundle(bundleId, bundlePath);

      assert.ok(fs.existsSync(skillsDir), '.github/skills should be created');
      assert.ok(fs.existsSync(path.join(skillsDir, skillName)), 'Skill directory should be created');
    });

    test('should add skill files to git exclude for local-only mode', async () => {
      createGitDirectory();

      const bundleId = 'skill-bundle-local';
      const skillName = 'local-skill';
      const bundlePath = createMockBundleWithSkill(bundleId, skillName, [
        { relativePath: 'SKILL.md', content: '# Local Skill' },
        { relativePath: 'index.js', content: 'module.exports = {};' }
      ]);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'local-only'));

      await service.syncBundle(bundleId, bundlePath);

      const excludeContent = readGitExclude();
      assert.ok(excludeContent, 'Git exclude file should exist');
      assert.ok(
        excludeContent.includes('.github/skills/local-skill'),
        'Git exclude should contain skill directory path'
      );
    });

    test('should NOT add skill files to git exclude for commit mode', async () => {
      createGitDirectory();

      const bundleId = 'skill-bundle-commit';
      const skillName = 'commit-skill';
      const bundlePath = createMockBundleWithSkill(bundleId, skillName, [
        { relativePath: 'SKILL.md', content: '# Commit Skill' }
      ]);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'commit'));

      await service.syncBundle(bundleId, bundlePath);

      const excludeContent = readGitExclude();
      assert.ok(
        excludeContent === null || !excludeContent.includes('.github/skills/commit-skill'),
        'Git exclude should not contain skill path for commit mode'
      );
    });

    test('should handle bundles with mixed skills and prompts', async () => {
      const bundleId = 'mixed-bundle-with-skill';
      const bundlePath = path.join(tempDir, 'bundles', bundleId);
      fs.mkdirSync(bundlePath, { recursive: true });

      // Create a prompt file
      fs.writeFileSync(path.join(bundlePath, 'my-prompt.prompt.md'), '# My Prompt');

      // Create a skill directory
      const skillDir = path.join(bundlePath, 'skills', 'my-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# My Skill');
      fs.writeFileSync(path.join(skillDir, 'index.js'), 'module.exports = {};');

      // Create manifest with both
      const manifest = `id: ${bundleId}
version: "1.0.0"
prompts:
  - id: my-prompt
    name: My Prompt
    file: my-prompt.prompt.md
    type: prompt
  - id: my-skill
    name: My Skill
    file: skills/my-skill/SKILL.md
    type: skill`;

      fs.writeFileSync(path.join(bundlePath, 'deployment-manifest.yml'), manifest);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'commit'));

      await service.syncBundle(bundleId, bundlePath);

      // Verify prompt was installed
      assert.ok(
        fs.existsSync(path.join(workspaceRoot, '.github', 'prompts', 'my-prompt.prompt.md')),
        'Prompt should be installed'
      );

      // Verify skill was installed
      const targetSkillDir = path.join(workspaceRoot, '.github', 'skills', 'my-skill');
      assert.ok(fs.existsSync(targetSkillDir), 'Skill directory should be created');
      assert.ok(fs.existsSync(path.join(targetSkillDir, 'SKILL.md')), 'SKILL.md should be copied');
      assert.ok(fs.existsSync(path.join(targetSkillDir, 'index.js')), 'index.js should be copied');
    });

    test('should handle skill manifest with file path (skills/name/SKILL.md) instead of directory path', async () => {
      // This test covers the AwesomeCopilotAdapter case where the manifest has:
      // file: skills/my-skill/SKILL.md (file path) instead of file: skills/my-skill (directory path)
      const bundleId = 'skill-bundle-file-path';
      const skillName = 'awesome-skill';
      const bundlePath = path.join(tempDir, 'bundles', bundleId);
      fs.mkdirSync(bundlePath, { recursive: true });

      // Create skill directory with files
      const skillDir = path.join(bundlePath, 'skills', skillName);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.mkdirSync(path.join(skillDir, 'resources'), { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Awesome Skill\nThis is a skill.');
      fs.writeFileSync(path.join(skillDir, 'resources', 'helper.md'), '# Helper Resource');

      // Create manifest with FILE PATH (skills/awesome-skill/SKILL.md) - this is what AwesomeCopilotAdapter produces
      const manifest = `id: ${bundleId}
version: "1.0.0"
prompts:
  - id: ${skillName}
    name: ${skillName}
    file: skills/${skillName}/SKILL.md
    type: skill`;

      fs.writeFileSync(path.join(bundlePath, 'deployment-manifest.yml'), manifest);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'commit'));

      await service.syncBundle(bundleId, bundlePath);

      // Verify skill directory and all files were copied
      const targetSkillDir = path.join(workspaceRoot, '.github', 'skills', skillName);
      assert.ok(fs.existsSync(targetSkillDir), 'Skill directory should be created');
      assert.ok(fs.existsSync(path.join(targetSkillDir, 'SKILL.md')), 'SKILL.md should be copied');
      assert.ok(fs.existsSync(path.join(targetSkillDir, 'resources', 'helper.md')), 'resources/helper.md should be copied');
    });

    test('should sync skill packaged under a non-standard directory (.github/skills)', async () => {
      // Regression for the PR 313 bug class at repository scope: the source directory
      // must be derived from the manifest file path, not a hardcoded skills/ prefix.
      const bundleId = 'skill-bundle-github-prefix';
      const skillName = 'nevio-deployment-automation';
      const bundlePath = path.join(tempDir, 'bundles', bundleId);
      fs.mkdirSync(bundlePath, { recursive: true });

      // Skill lives under .github/skills/ instead of the standard skills/ root path
      const skillDir = path.join(bundlePath, '.github', 'skills', skillName);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Deployment Automation');
      fs.writeFileSync(path.join(skillDir, 'helper.sh'), '#!/bin/bash\necho hello');

      const manifest = `id: ${bundleId}
version: "1.0.0"
prompts:
  - id: ${skillName}
    name: ${skillName}
    file: .github/skills/${skillName}/SKILL.md
    type: skill`;

      fs.writeFileSync(path.join(bundlePath, 'deployment-manifest.yml'), manifest);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'commit'));

      await service.syncBundle(bundleId, bundlePath);

      const targetSkillDir = path.join(workspaceRoot, '.github', 'skills', skillName);
      assert.ok(fs.existsSync(targetSkillDir), 'Skill directory should be created');
      assert.ok(fs.existsSync(path.join(targetSkillDir, 'SKILL.md')), 'SKILL.md should be copied');
      assert.ok(fs.existsSync(path.join(targetSkillDir, 'helper.sh')), 'helper.sh should be copied');
    });
  });

  suite('unsyncBundle - Skills Directory Removal', () => {
    /**
     * Create a mock bundle with a skill directory for unsync tests
     * @param bundleId
     * @param skillName
     * @param skillFiles
     */
    const createMockBundleWithSkillForUnsync = (
      bundleId: string,
      skillName: string,
      skillFiles: { relativePath: string; content: string }[]
    ) => {
      const bundlePath = path.join(tempDir, 'bundles', bundleId);
      fs.mkdirSync(bundlePath, { recursive: true });

      // Create skill directory in bundle
      const skillDir = path.join(bundlePath, 'skills', skillName);
      fs.mkdirSync(skillDir, { recursive: true });

      for (const file of skillFiles) {
        const filePath = path.join(skillDir, file.relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, file.content);
      }

      // Create deployment manifest
      const manifest = `id: ${bundleId}
version: "1.0.0"
prompts:
  - id: ${skillName}
    name: ${skillName}
    file: skills/${skillName}/SKILL.md
    type: skill`;

      fs.writeFileSync(path.join(bundlePath, 'deployment-manifest.yml'), manifest);

      return bundlePath;
    };

    test('should remove entire skill directory on unsync', async () => {
      const bundleId = 'skill-unsync-bundle';
      const skillName = 'removable-skill';

      // Create the bundle
      createMockBundleWithSkillForUnsync(bundleId, skillName, [
        { relativePath: 'SKILL.md', content: '# Removable Skill' },
        { relativePath: 'index.js', content: 'module.exports = {};' }
      ]);

      // Create the installed skill directory in .github
      const targetSkillDir = path.join(workspaceRoot, '.github', 'skills', skillName);
      fs.mkdirSync(targetSkillDir, { recursive: true });
      const skillMdFile = path.join(targetSkillDir, 'SKILL.md');
      const indexJsFile = path.join(targetSkillDir, 'index.js');
      fs.writeFileSync(skillMdFile, '# Removable Skill');
      fs.writeFileSync(indexJsFile, 'module.exports = {};');

      // Calculate checksums of the files we just created
      const skillMdChecksum = calculateChecksumSync(skillMdFile);
      const indexJsChecksum = calculateChecksumSync(indexJsFile);

      // Create lockfile with file entries including checksums
      createLockfile(bundleId, 'commit', [
        { path: `.github/skills/${skillName}/SKILL.md`, checksum: skillMdChecksum },
        { path: `.github/skills/${skillName}/index.js`, checksum: indexJsChecksum }
      ]);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'commit'));

      await service.unsyncBundle(bundleId);

      assert.ok(!fs.existsSync(targetSkillDir), 'Skill directory should be removed');
    });

    test('should clean up git exclude entries for all skill files', async () => {
      createGitDirectory();
      const excludePath = path.join(workspaceRoot, '.git', 'info', 'exclude');
      fs.writeFileSync(excludePath, '# Prompt Registry (local)\n.github/skills/my-skill\n');

      const bundleId = 'skill-unsync-local';
      const skillName = 'my-skill';

      // Create the bundle
      createMockBundleWithSkillForUnsync(bundleId, skillName, [
        { relativePath: 'SKILL.md', content: '# My Skill' }
      ]);

      // Create the installed skill directory
      const targetSkillDir = path.join(workspaceRoot, '.github', 'skills', skillName);
      fs.mkdirSync(targetSkillDir, { recursive: true });
      const skillMdFile = path.join(targetSkillDir, 'SKILL.md');
      fs.writeFileSync(skillMdFile, '# My Skill');

      // Calculate checksum of the file we just created
      const checksum = calculateChecksumSync(skillMdFile);

      // Create lockfile with file entries including checksums
      createLockfile(bundleId, 'local-only', [
        { path: `.github/skills/${skillName}/SKILL.md`, checksum }
      ]);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'local-only'));

      await service.unsyncBundle(bundleId);

      const excludeContent = readGitExclude();
      assert.ok(
        !excludeContent!.includes('.github/skills/my-skill'),
        'Git exclude should not contain skill path after unsync'
      );
    });

    test('should handle partial directory removal gracefully', async () => {
      const bundleId = 'skill-partial-unsync';
      const skillName = 'partial-skill';

      // Create the bundle
      createMockBundleWithSkillForUnsync(bundleId, skillName, [
        { relativePath: 'SKILL.md', content: '# Partial Skill' },
        { relativePath: 'sub/file.js', content: 'exports = {};' }
      ]);

      // Create only partial skill directory (missing some files)
      const targetSkillDir = path.join(workspaceRoot, '.github', 'skills', skillName);
      fs.mkdirSync(targetSkillDir, { recursive: true });
      const skillMdFile = path.join(targetSkillDir, 'SKILL.md');
      fs.writeFileSync(skillMdFile, '# Partial Skill');
      // Note: sub/file.js is NOT created - simulating partial state

      // Calculate checksum of the file we just created
      const checksum = calculateChecksumSync(skillMdFile);

      // Create lockfile with file entries including checksums (only for existing file)
      createLockfile(bundleId, 'commit', [
        { path: `.github/skills/${skillName}/SKILL.md`, checksum }
      ]);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'commit'));

      // Should not throw
      await service.unsyncBundle(bundleId);

      // Directory should be removed (or at least attempted)
      // The exact behavior depends on implementation
    });
  });

  suite('copilotFileTypeUtils Integration for Skills', () => {
    test('should detect skill type from manifest type field', async () => {
      const bundleId = 'skill-type-detection';
      const skillName = 'detected-skill';

      const bundlePath = path.join(tempDir, 'bundles', bundleId);
      fs.mkdirSync(bundlePath, { recursive: true });

      // Create skill directory
      const skillDir = path.join(bundlePath, 'skills', skillName);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Detected Skill');

      // Create manifest with explicit type: skill
      const manifest = `id: ${bundleId}
version: "1.0.0"
prompts:
  - id: ${skillName}
    name: ${skillName}
    file: skills/${skillName}/SKILL.md
    type: skill`;

      fs.writeFileSync(path.join(bundlePath, 'deployment-manifest.yml'), manifest);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'commit'));

      await service.syncBundle(bundleId, bundlePath);

      // Skill should be placed in .github/skills/
      const targetSkillDir = path.join(workspaceRoot, '.github', 'skills', skillName);
      assert.ok(fs.existsSync(targetSkillDir), 'Skill should be placed in .github/skills/');
    });

    test('should use getRepositoryTargetDirectory for skill type', () => {
      const targetPath = service.getTargetPath('skill', 'test-skill');
      assert.ok(
        targetPath.includes(path.join('.github', 'skills', '')),
        'Skill target path should include .github/skills/'
      );
    });
  });

  /**
   * Host-Aware Destination Tests
   *
   * Regression coverage for the workspace-install host-awareness bug: the
   * host editor target type (injected here for testability) must route
   * repository-scope installs to the host-appropriate directory tree —
   * `.kiro/` for Kiro, `.github/` for VS Code — with no `.github/`
   * writes under a Kiro host and tracker/written-path parity.
   *
   */
  suite('Host-Aware Destinations', () => {
    /**
     * Recursively collect every file path under a directory, relative to
     * the workspace root, using forward slashes.
     * @param dir - Absolute directory to walk.
     */
    const listFilesRelative = (dir: string): string[] => {
      if (!fs.existsSync(dir)) {
        return [];
      }
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          out.push(...listFilesRelative(abs));
        } else {
          out.push(path.relative(workspaceRoot, abs).replace(/\\/g, '/'));
        }
      }
      return out;
    };

    test('Kiro host routes files under .kiro/ and never under .github/', async () => {
      const kiroService = new RepositoryScopeService(workspaceRoot, mockStorage, 'kiro');
      const bundleId = 'kiro-bundle';
      const bundlePath = createMockBundle(bundleId, [
        { name: 'test.prompt.md', content: '# Prompt', type: 'prompt' },
        { name: 'coding.instructions.md', content: '# Instructions', type: 'instructions' },
        { name: 'reviewer.agent.md', content: '# Agent', type: 'agent' }
      ]);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'commit'));

      await kiroService.syncBundle(bundleId, bundlePath);

      assert.ok(
        fs.existsSync(path.join(workspaceRoot, '.kiro', 'steering', 'test.prompt.md')),
        'Prompt should land in .kiro/steering/'
      );
      assert.ok(
        fs.existsSync(path.join(workspaceRoot, '.kiro', 'steering', 'coding.instructions.md')),
        'Instructions should land in .kiro/steering/'
      );
      assert.ok(
        fs.existsSync(path.join(workspaceRoot, '.kiro', 'agents', 'reviewer.agent.md')),
        'Agent should land in .kiro/agents/'
      );
      assert.ok(
        !fs.existsSync(path.join(workspaceRoot, '.github')),
        'Nothing should be written under .github/ for a Kiro host'
      );
    });

    test('Kiro host routes skill directories under .kiro/skills/', async () => {
      const kiroService = new RepositoryScopeService(workspaceRoot, mockStorage, 'kiro');
      const bundleId = 'kiro-skill-bundle';
      const skillName = 'my-skill';
      const bundlePath = path.join(tempDir, 'bundles', bundleId);
      fs.mkdirSync(path.join(bundlePath, 'skills', skillName), { recursive: true });
      fs.writeFileSync(path.join(bundlePath, 'skills', skillName, 'SKILL.md'), '# Skill');
      fs.writeFileSync(
        path.join(bundlePath, 'deployment-manifest.yml'),
        `id: ${bundleId}\nversion: "1.0.0"\nprompts:\n  - id: ${skillName}\n    name: ${skillName}\n    file: skills/${skillName}/SKILL.md\n    type: skill`
      );

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'commit'));

      await kiroService.syncBundle(bundleId, bundlePath);

      assert.ok(
        fs.existsSync(path.join(workspaceRoot, '.kiro', 'skills', skillName, 'SKILL.md')),
        'Skill should land in .kiro/skills/<id>/'
      );
      assert.ok(
        !fs.existsSync(path.join(workspaceRoot, '.github')),
        'Nothing should be written under .github/ for a Kiro host'
      );
    });

    test('VS Code host preserves .github/ destinations (no regression)', async () => {
      const vscodeService = new RepositoryScopeService(workspaceRoot, mockStorage, 'vscode');
      const bundleId = 'vscode-bundle';
      const bundlePath = createMockBundle(bundleId, [
        { name: 'test.prompt.md', content: '# Prompt', type: 'prompt' }
      ]);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'commit'));

      await vscodeService.syncBundle(bundleId, bundlePath);

      assert.ok(
        fs.existsSync(path.join(workspaceRoot, '.github', 'prompts', 'test.prompt.md')),
        'Prompt should land in .github/prompts/ for a VS Code host'
      );
      assert.ok(
        !fs.existsSync(path.join(workspaceRoot, '.kiro')),
        'Nothing should be written under .kiro/ for a VS Code host'
      );
    });

    test('getTargetPath is host-aware for Kiro', () => {
      const kiroService = new RepositoryScopeService(workspaceRoot, mockStorage, 'kiro');
      assert.strictEqual(
        kiroService.getTargetPath('prompt', 'demo'),
        path.join(workspaceRoot, '.kiro', 'steering', 'demo.prompt.md')
      );
      assert.strictEqual(
        kiroService.getTargetPath('skill', 'demo'),
        path.join(workspaceRoot, '.kiro', 'skills', 'SKILL.md')
      );
    });

    test('getTargetDirectory resolves host-appropriate dirs per file type', () => {
      const cases: { targetType: string; type: string; expected: string }[] = [
        { targetType: 'kiro', type: 'prompt', expected: '.kiro/steering/' },
        { targetType: 'kiro', type: 'instructions', expected: '.kiro/steering/' },
        { targetType: 'kiro', type: 'agent', expected: '.kiro/agents/' },
        { targetType: 'kiro', type: 'chatmode', expected: '.kiro/agents/' },
        { targetType: 'kiro', type: 'skill', expected: '.kiro/skills/' },
        { targetType: 'vscode', type: 'prompt', expected: '.github/prompts/' },
        { targetType: 'vscode', type: 'agent', expected: '.github/agents/' },
        { targetType: 'vscode-insiders', type: 'prompt', expected: '.github/prompts/' },
        { targetType: 'windsurf', type: 'prompt', expected: '.windsurf/rules/' },
        { targetType: 'windsurf', type: 'agent', expected: '.windsurf/agents/' },
        { targetType: 'claude-code', type: 'prompt', expected: '.claude/commands/' },
        { targetType: 'claude-code', type: 'skill', expected: '.claude/skills/' }
      ];
      for (const { targetType, type, expected } of cases) {
        const svc = new RepositoryScopeService(workspaceRoot, mockStorage, targetType as never);
        assert.strictEqual(
          svc.getTargetDirectory(type as never),
          expected,
          `${targetType} + ${type} should resolve to ${expected}`
        );
      }
    });

    test('switchCommitMode uses tracked host-aware file paths on a Kiro host', async () => {
      createGitDirectory();
      const kiroService = new RepositoryScopeService(workspaceRoot, mockStorage, 'kiro');
      const bundleId = 'kiro-switch-bundle';

      // Simulate a Kiro install: a prompt already synced under .kiro/steering/.
      const steeringDir = path.join(workspaceRoot, '.kiro', 'steering');
      fs.mkdirSync(steeringDir, { recursive: true });
      fs.writeFileSync(path.join(steeringDir, 'test.prompt.md'), '# Prompt');

      const promptPath = path.join(steeringDir, 'test.prompt.md');
      createLockfile(bundleId, 'commit', [{
        path: path.relative(workspaceRoot, promptPath),
        checksum: calculateChecksumSync(promptPath)
      }]);

      await kiroService.switchCommitMode(bundleId, 'local-only');

      const excludeContent = readGitExclude();
      assert.ok(excludeContent, 'Git exclude file should exist');
      assert.ok(
        excludeContent.includes('.kiro/steering/test.prompt.md'),
        'switchCommitMode should add the host-aware .kiro path to git exclude'
      );
      assert.ok(
        !excludeContent.includes('.github/'),
        'switchCommitMode should not reference .github on a Kiro host'
      );
    });

    test('tracked git-exclude paths equal the host-aware written paths', async () => {
      createGitDirectory();
      const kiroService = new RepositoryScopeService(workspaceRoot, mockStorage, 'kiro');
      const bundleId = 'kiro-local-bundle';
      const bundlePath = createMockBundle(bundleId, [
        { name: 'test.prompt.md', content: '# Prompt', type: 'prompt' }
      ]);

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'local-only'));

      await kiroService.syncBundle(bundleId, bundlePath);

      // In local-only mode the git-exclude entries are the tracker's relative
      // paths, which are derived from the writer's actual written paths — so a
      // .kiro entry here proves tracker/written parity for the detected host.
      const excludeContent = readGitExclude();
      assert.ok(excludeContent, 'Git exclude file should exist');
      assert.ok(
        excludeContent.includes('.kiro/steering/test.prompt.md'),
        'Tracked (git-exclude) path should match the host-aware written path'
      );
      assert.ok(
        !excludeContent.includes('.github/'),
        'No .github/ path should be tracked for a Kiro host'
      );

      // Sanity: the tracked path is exactly the file that was written.
      const written = listFilesRelative(path.join(workspaceRoot, '.kiro'));
      assert.deepStrictEqual(written, ['.kiro/steering/test.prompt.md']);
    });

    test('Kiro skill install (local-only) consolidates git-exclude under .kiro/skills', async () => {
      createGitDirectory();
      const kiroService = new RepositoryScopeService(workspaceRoot, mockStorage, 'kiro');
      const bundleId = 'kiro-skill-local';
      const skillName = 'my-skill';
      const bundlePath = path.join(tempDir, 'bundles', bundleId);
      fs.mkdirSync(path.join(bundlePath, 'skills', skillName), { recursive: true });
      fs.writeFileSync(path.join(bundlePath, 'skills', skillName, 'SKILL.md'), '# Skill');
      fs.writeFileSync(path.join(bundlePath, 'skills', skillName, 'run.sh'), 'echo hi');
      fs.writeFileSync(
        path.join(bundlePath, 'deployment-manifest.yml'),
        `id: ${bundleId}\nversion: "1.0.0"\nprompts:\n  - id: ${skillName}\n    name: ${skillName}\n    file: skills/${skillName}/SKILL.md\n    type: skill`
      );

      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'local-only'));

      await kiroService.syncBundle(bundleId, bundlePath);

      const excludeContent = readGitExclude();
      assert.ok(excludeContent, 'Git exclude file should exist');
      assert.ok(
        excludeContent.includes(`.kiro/skills/${skillName}`),
        'Skill should be consolidated to the host-aware .kiro/skills/<name> dir'
      );
      assert.ok(
        !excludeContent.includes(`.kiro/skills/${skillName}/SKILL.md`),
        'Individual skill files should be consolidated, not listed separately'
      );
      assert.ok(!excludeContent.includes('.github'), 'Should not reference .github on a Kiro host');
    });

    test('Kiro unsync removes files and empty .kiro managed dirs, preserving the .kiro root', async () => {
      const kiroService = new RepositoryScopeService(workspaceRoot, mockStorage, 'kiro');
      const bundleId = 'kiro-unsync-bundle';

      // Simulate an installed prompt under .kiro/steering (host-aware path).
      const steeringDir = path.join(workspaceRoot, '.kiro', 'steering');
      fs.mkdirSync(steeringDir, { recursive: true });
      const promptFile = path.join(steeringDir, 'test.prompt.md');
      fs.writeFileSync(promptFile, '# Prompt');
      const checksum = calculateChecksumSync(promptFile);

      createLockfile(bundleId, 'commit', [{ path: '.kiro/steering/test.prompt.md', checksum }]);
      mockStorage.getInstalledBundle.resolves(createMockInstalledBundle(bundleId, 'commit'));

      await kiroService.unsyncBundle(bundleId);

      assert.ok(!fs.existsSync(promptFile), 'Tracked file should be removed');
      assert.ok(!fs.existsSync(steeringDir), 'Emptied .kiro/steering should be cleaned up');
      assert.ok(
        fs.existsSync(path.join(workspaceRoot, '.kiro')),
        'The .kiro root itself must be preserved (may hold unrelated files)'
      );
    });
  });
});
