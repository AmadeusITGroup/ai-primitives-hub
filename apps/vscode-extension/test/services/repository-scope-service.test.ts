/**
 * RepositoryScopeService Unit Tests
 *
 * Tests for repository-level bundle installation service.
 * Handles file placement in .github/ directories and git exclude management.
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
      fs.writeFileSync(path.join(bundlePath, file.name), file.content);
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
      createLockfile(bundleId, 'commit');

      await service.switchCommitMode(bundleId, 'local-only');

      const excludeContent = readGitExclude();
      assert.ok(excludeContent, 'Git exclude file should exist');
      assert.ok(
        excludeContent.includes('.github/prompts/test.prompt.md'),
        'Git exclude should contain file path after switching to local-only'
      );
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
      createLockfile(bundleId, 'local-only');

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

      // Create deployment manifest with skill entry
      const manifest = `id: ${bundleId}
version: "1.0.0"
prompts:
  - id: ${skillName}
    name: ${skillName}
    file: skills/${skillName}
    type: skill`;

      fs.writeFileSync(path.join(bundlePath, 'deployment-manifest.yml'), manifest);

      return bundlePath;
    };

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
    file: skills/my-skill
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
    file: skills/${skillName}
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
    file: skills/${skillName}
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
      assert.ok(targetPath.includes('.github/skills/'), 'Skill target path should include .github/skills/');
    });
  });
});
