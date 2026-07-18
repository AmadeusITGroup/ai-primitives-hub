/**
 * LockfileManager Unit Tests
 *
 * Tests for the LockfileManager service that manages prompt-registry.lock.json files.
 * Following TDD approach - these tests are written before the implementation.
 *
 * Requirements covered:
 * - 4.1-4.10: Lockfile creation and management
 * - 5.1-5.7: Lockfile detection and auto-sync
 * - 12.1-12.6: Source and hub tracking
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  CreateOrUpdateOptions,
  LockfileManager,
} from '../../src/services/lockfile-manager';
import {
  Lockfile,
} from '../../src/types/lockfile';
import {
  calculateFileChecksum,
} from '../../src/utils/file-integrity-service';
import {
  Logger,
} from '../../src/utils/logger';
import {
  createMockFileEntry,
  createMockHubEntry,
  createMockLockfile,
  createMockProfileEntry,
  createMockSourceEntry,
  LockfileBuilder,
} from '../helpers/lockfile-test-helpers';

suite('LockfileManager', () => {
  let sandbox: sinon.SinonSandbox;
  let tempDir: string;
  let lockfilePath: string;

  // ===== Test Utilities =====
  const createTempDir = (): string => {
    const dir = path.join(__dirname, '..', '..', 'test-temp-lockfile-' + Date.now());
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  const cleanupTempDir = (dir: string): void => {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  const writeLockfile = (lockfile: Lockfile): void => {
    fs.writeFileSync(lockfilePath, JSON.stringify(lockfile, null, 2));
  };

  const readLockfileFromDisk = (): Lockfile | null => {
    if (!fs.existsSync(lockfilePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
  };

  const createTestOptions = (bundleId: string, version = '1.0.0'): CreateOrUpdateOptions => ({
    bundleId,
    version,
    sourceId: 'test-source',
    sourceType: 'github',
    commitMode: 'commit',
    files: [createMockFileEntry('.github/prompts/test.prompt.md')],
    source: createMockSourceEntry('github', 'https://github.com/owner/repo')
  });

  setup(() => {
    sandbox = sinon.createSandbox();
    tempDir = createTempDir();
    lockfilePath = path.join(tempDir, 'prompt-registry.lock.json');
    // Reset singleton for each test
    LockfileManager.resetInstance();
  });

  teardown(() => {
    sandbox.restore();
    LockfileManager.resetInstance();
    cleanupTempDir(tempDir);
  });

  suite('Singleton Pattern', () => {
    test('should return same instance on multiple calls', () => {
      const instance1 = LockfileManager.getInstance(tempDir);
      const instance2 = LockfileManager.getInstance(tempDir);
      assert.strictEqual(instance1, instance2);
    });

    test('should require repository path on first call', () => {
      LockfileManager.resetInstance();
      assert.throws(() => {
        LockfileManager.getInstance();
      }, /Repository path required/);
    });
  });

  suite('createOrUpdate()', () => {
    suite('Lockfile Creation', () => {
      test('should create lockfile with all required fields', async () => {
        // Requirements: 4.2-4.7
        const manager = LockfileManager.getInstance(tempDir);
        const options = createTestOptions('test-bundle');

        await manager.createOrUpdate(options);

        const lockfile = readLockfileFromDisk();
        assert.ok(lockfile);
        assert.ok(lockfile.$schema);
        assert.ok(lockfile.version);
        assert.ok(lockfile.generatedAt);
        assert.ok(lockfile.generatedBy);
        assert.ok(lockfile.bundles);
        assert.ok(lockfile.sources);
      });

      test('should include $schema field pointing to schema definition', async () => {
        // Requirements: 11.4
        const manager = LockfileManager.getInstance(tempDir);
        await manager.createOrUpdate(createTestOptions('test-bundle'));
        const lockfile = readLockfileFromDisk();
        assert.ok(lockfile!.$schema.includes('lockfile.schema.json'));
      });

      test('should include version field with schema version', async () => {
        // Requirements: 4.2
        const manager = LockfileManager.getInstance(tempDir);
        await manager.createOrUpdate(createTestOptions('test-bundle'));
        const lockfile = readLockfileFromDisk();
        assert.match(lockfile!.version, /^\d+\.\d+\.\d+$/);
      });

      test('should include generatedAt ISO timestamp', async () => {
        // Requirements: 4.3
        const manager = LockfileManager.getInstance(tempDir);
        await manager.createOrUpdate(createTestOptions('test-bundle'));
        const lockfile = readLockfileFromDisk();
        assert.ok(new Date(lockfile!.generatedAt).toISOString() === lockfile!.generatedAt);
      });

      test('should include generatedBy with extension name and version', async () => {
        // Requirements: 4.4
        const manager = LockfileManager.getInstance(tempDir);
        await manager.createOrUpdate(createTestOptions('test-bundle'));
        const lockfile = readLockfileFromDisk();
        assert.ok(lockfile!.generatedBy.includes('prompt-registry'));
      });

      test('should use 2-space indentation for readability', async () => {
        // Requirements: 4.10
        const manager = LockfileManager.getInstance(tempDir);
        await manager.createOrUpdate(createTestOptions('test-bundle'));
        const content = fs.readFileSync(lockfilePath, 'utf8');
        assert.ok(content.includes('  "version"'));
      });
    });

    suite('Bundle Entry Management', () => {
      test('should add bundle entry to lockfile', async () => {
        // Requirements: 4.5
        const manager = LockfileManager.getInstance(tempDir);
        await manager.createOrUpdate(createTestOptions('my-bundle'));
        const lockfile = readLockfileFromDisk();
        assert.ok(lockfile!.bundles['my-bundle']);
      });

      test('should include version in bundle entry', async () => {
        // Requirements: 4.6
        const manager = LockfileManager.getInstance(tempDir);
        await manager.createOrUpdate(createTestOptions('my-bundle', '1.0.0'));
        const lockfile = readLockfileFromDisk();
        assert.strictEqual(lockfile!.bundles['my-bundle'].version, '1.0.0');
      });

      test('should include sourceId in bundle entry', async () => {
        // Requirements: 4.6
        const manager = LockfileManager.getInstance(tempDir);
        await manager.createOrUpdate(createTestOptions('my-bundle'));
        const lockfile = readLockfileFromDisk();
        assert.strictEqual(lockfile!.bundles['my-bundle'].sourceId, 'test-source');
      });

      test('should include sourceType in bundle entry', async () => {
        // Requirements: 4.6
        const manager = LockfileManager.getInstance(tempDir);
        await manager.createOrUpdate(createTestOptions('my-bundle'));
        const lockfile = readLockfileFromDisk();
        assert.strictEqual(lockfile!.bundles['my-bundle'].sourceType, 'github');
      });

      test('should include installedAt timestamp in bundle entry', async () => {
        // Requirements: 4.6
        const manager = LockfileManager.getInstance(tempDir);
        await manager.createOrUpdate(createTestOptions('my-bundle'));
        const lockfile = readLockfileFromDisk();
        assert.ok(lockfile!.bundles['my-bundle'].installedAt);
      });

      test('should NOT include commitMode in bundle entry (implicit based on file)', async () => {
        // Requirements: 1.4, 1.5 - commitMode is implicit based on which lockfile contains the entry
        const manager = LockfileManager.getInstance(tempDir);
        await manager.createOrUpdate(createTestOptions('my-bundle'));
        const lockfile = readLockfileFromDisk();
        // commitMode should NOT be present in the bundle entry
        assert.strictEqual(lockfile!.bundles['my-bundle'].commitMode, undefined);
      });

      test('should include files array with checksums', async () => {
        // Requirements: 15.1-15.2
        const manager = LockfileManager.getInstance(tempDir);
        await manager.createOrUpdate(createTestOptions('my-bundle'));
        const lockfile = readLockfileFromDisk();
        assert.ok(Array.isArray(lockfile!.bundles['my-bundle'].files));
        assert.ok(lockfile!.bundles['my-bundle'].files[0].path);
        assert.ok(lockfile!.bundles['my-bundle'].files[0].checksum);
      });

      test('should update existing bundle entry', async () => {
        // Requirements: 4.1
        const manager = LockfileManager.getInstance(tempDir);
        await manager.createOrUpdate(createTestOptions('my-bundle', '1.0.0'));
        await manager.createOrUpdate(createTestOptions('my-bundle', '2.0.0'));
        const lockfile = readLockfileFromDisk();
        assert.strictEqual(lockfile!.bundles['my-bundle'].version, '2.0.0');
      });

      test('should preserve other bundles when updating one', async () => {
        // Requirements: 11.5
        const manager = LockfileManager.getInstance(tempDir);
        await manager.createOrUpdate(createTestOptions('bundle-1', '1.0.0'));
        await manager.createOrUpdate(createTestOptions('bundle-2', '2.0.0'));
        const lockfile = readLockfileFromDisk();
        assert.ok(lockfile!.bundles['bundle-1']);
        assert.ok(lockfile!.bundles['bundle-2']);
      });
    });

    suite('Source Recording', () => {
      test('should record source configuration in sources section', async () => {
        // Requirements: 4.7, 12.1
        const manager = LockfileManager.getInstance(tempDir);
        await manager.createOrUpdate(createTestOptions('test-bundle'));
        const lockfile = readLockfileFromDisk();
        assert.ok(lockfile!.sources['test-source']);
      });

      test('should include source type', async () => {
        // Requirements: 12.3
        const manager = LockfileManager.getInstance(tempDir);
        await manager.createOrUpdate(createTestOptions('test-bundle'));
        const lockfile = readLockfileFromDisk();
        assert.strictEqual(lockfile!.sources['test-source'].type, 'github');
      });

      test('should include source URL', async () => {
        // Requirements: 12.3
        const manager = LockfileManager.getInstance(tempDir);
        await manager.createOrUpdate(createTestOptions('test-bundle'));
        const lockfile = readLockfileFromDisk();
        assert.strictEqual(lockfile!.sources['test-source'].url, 'https://github.com/owner/repo');
      });

      test('should include optional branch for git sources', async () => {
        // Requirements: 12.3
        const manager = LockfileManager.getInstance(tempDir);
        const options = createTestOptions('test-bundle');
        options.source = createMockSourceEntry('github', 'https://github.com/owner/repo', 'main');
        await manager.createOrUpdate(options);
        const lockfile = readLockfileFromDisk();
        assert.strictEqual(lockfile!.sources['test-source'].branch, 'main');
      });
    });

    suite('Hub Recording', () => {
      test('should record hub configuration when bundle comes from hub', async () => {
        // Requirements: 12.2
        const manager = LockfileManager.getInstance(tempDir);
        const options = createTestOptions('test-bundle');
        options.hub = {
          id: 'hub-1',
          entry: createMockHubEntry('My Hub', 'https://hub.example.com/config.yml')
        };
        await manager.createOrUpdate(options);
        const lockfile = readLockfileFromDisk();
        assert.ok(lockfile!.hubs);
        assert.ok(lockfile!.hubs['hub-1']);
      });

      test('should include hub name', async () => {
        // Requirements: 12.2
        const manager = LockfileManager.getInstance(tempDir);
        const options = createTestOptions('test-bundle');
        options.hub = {
          id: 'hub-1',
          entry: createMockHubEntry('My Hub', 'https://hub.example.com/config.yml')
        };
        await manager.createOrUpdate(options);
        const lockfile = readLockfileFromDisk();
        assert.strictEqual(lockfile!.hubs!['hub-1'].name, 'My Hub');
      });

      test('should include hub URL', async () => {
        // Requirements: 12.2
        const manager = LockfileManager.getInstance(tempDir);
        const options = createTestOptions('test-bundle');
        options.hub = {
          id: 'hub-1',
          entry: createMockHubEntry('My Hub', 'https://hub.example.com/config.yml')
        };
        await manager.createOrUpdate(options);
        const lockfile = readLockfileFromDisk();
        assert.strictEqual(lockfile!.hubs!['hub-1'].url, 'https://hub.example.com/config.yml');
      });

      test('should not include hubs section when no hub provided', async () => {
        const manager = LockfileManager.getInstance(tempDir);
        await manager.createOrUpdate(createTestOptions('test-bundle'));
        const lockfile = readLockfileFromDisk();
        assert.strictEqual(lockfile!.hubs, undefined);
      });
    });

    suite('Profile Recording', () => {
      test('should record profile when bundle installed as part of profile', async () => {
        // Requirements: 12.6, 15.3
        const manager = LockfileManager.getInstance(tempDir);
        const options = createTestOptions('bundle-1');
        options.profile = {
          id: 'profile-1',
          entry: createMockProfileEntry('My Profile', ['bundle-1', 'bundle-2'])
        };
        await manager.createOrUpdate(options);
        const lockfile = readLockfileFromDisk();
        assert.ok(lockfile!.profiles);
      });

      test('should include profile name', async () => {
        // Requirements: 15.4
        const manager = LockfileManager.getInstance(tempDir);
        const options = createTestOptions('bundle-1');
        options.profile = {
          id: 'profile-1',
          entry: createMockProfileEntry('My Profile', ['bundle-1', 'bundle-2'])
        };
        await manager.createOrUpdate(options);
        const lockfile = readLockfileFromDisk();
        assert.strictEqual(lockfile!.profiles!['profile-1'].name, 'My Profile');
      });

      test('should include profile bundleIds', async () => {
        // Requirements: 15.4
        const manager = LockfileManager.getInstance(tempDir);
        const options = createTestOptions('bundle-1');
        options.profile = {
          id: 'profile-1',
          entry: createMockProfileEntry('My Profile', ['bundle-1', 'bundle-2'])
        };
        await manager.createOrUpdate(options);
        const lockfile = readLockfileFromDisk();
        assert.deepStrictEqual(lockfile!.profiles!['profile-1'].bundleIds, ['bundle-1', 'bundle-2']);
      });

      test('should not include profiles section when no profile provided', async () => {
        const manager = LockfileManager.getInstance(tempDir);
        await manager.createOrUpdate(createTestOptions('test-bundle'));
        const lockfile = readLockfileFromDisk();
        assert.strictEqual(lockfile!.profiles, undefined);
      });
    });

    suite('Atomic Write', () => {
      test('should write atomically using temp file and rename', async () => {
        // Requirements: 15.6
        const manager = LockfileManager.getInstance(tempDir);
        await manager.createOrUpdate(createTestOptions('test-bundle'));

        // Verify lockfile exists and temp file doesn't
        assert.ok(fs.existsSync(lockfilePath));
        assert.ok(!fs.existsSync(lockfilePath + '.tmp'));
      });

      test('should not corrupt lockfile on concurrent writes', async () => {
        // Requirements: 15.6
        const manager = LockfileManager.getInstance(tempDir);

        // Perform multiple concurrent writes
        await Promise.all([
          manager.createOrUpdate(createTestOptions('bundle-1', '1.0.0')),
          manager.createOrUpdate(createTestOptions('bundle-2', '2.0.0')),
          manager.createOrUpdate(createTestOptions('bundle-3', '3.0.0'))
        ]);

        // Verify lockfile is valid JSON
        const lockfile = readLockfileFromDisk();
        assert.ok(lockfile);
        assert.ok(lockfile.bundles);
      });
    });

    suite('Dual-Lockfile Write Operations', () => {
      const localLockfilePath = () => path.join(tempDir, 'prompt-registry.local.lock.json');

      const readLocalLockfileFromDisk = (): Lockfile | null => {
        const localPath = localLockfilePath();
        if (!fs.existsSync(localPath)) {
          return null;
        }
        return JSON.parse(fs.readFileSync(localPath, 'utf8'));
      };

      test('should write commit mode bundles to main lockfile', async () => {
        // Requirements: 1.2 - Write commit bundles to prompt-registry.lock.json
        const manager = LockfileManager.getInstance(tempDir);
        const options = createTestOptions('commit-bundle');
        options.commitMode = 'commit';

        await manager.createOrUpdate(options);

        // Verify bundle is in main lockfile
        const mainLockfile = readLockfileFromDisk();
        assert.ok(mainLockfile, 'Main lockfile should exist');
        assert.ok(mainLockfile.bundles['commit-bundle'], 'Bundle should be in main lockfile');

        // Verify bundle is NOT in local lockfile
        const localLockfile = readLocalLockfileFromDisk();
        assert.strictEqual(localLockfile, null, 'Local lockfile should not exist');
      });

      test('should write local-only mode bundles to local lockfile', async () => {
        // Requirements: 1.1 - Write local-only bundles to prompt-registry.local.lock.json
        const manager = LockfileManager.getInstance(tempDir);
        const options = createTestOptions('local-bundle');
        options.commitMode = 'local-only';

        await manager.createOrUpdate(options);

        // Verify bundle is in local lockfile
        const localLockfile = readLocalLockfileFromDisk();
        assert.ok(localLockfile, 'Local lockfile should exist');
        assert.ok(localLockfile.bundles['local-bundle'], 'Bundle should be in local lockfile');

        // Verify bundle is NOT in main lockfile
        const mainLockfile = readLockfileFromDisk();
        assert.strictEqual(mainLockfile, null, 'Main lockfile should not exist');
      });

      test('should NOT include commitMode field in bundle entries for commit mode', async () => {
        // Requirements: 1.5 - commitMode field should not be included in main lockfile entries
        const manager = LockfileManager.getInstance(tempDir);
        const options = createTestOptions('commit-bundle');
        options.commitMode = 'commit';

        await manager.createOrUpdate(options);

        const mainLockfile = readLockfileFromDisk();
        assert.ok(mainLockfile, 'Main lockfile should exist');
        assert.strictEqual(
          mainLockfile.bundles['commit-bundle'].commitMode,
          undefined,
          'commitMode should NOT be in bundle entry'
        );
      });

      test('should NOT include commitMode field in bundle entries for local-only mode', async () => {
        // Requirements: 1.4 - commitMode field should not be included in local lockfile entries
        const manager = LockfileManager.getInstance(tempDir);
        const options = createTestOptions('local-bundle');
        options.commitMode = 'local-only';

        await manager.createOrUpdate(options);

        const localLockfile = readLocalLockfileFromDisk();
        assert.ok(localLockfile, 'Local lockfile should exist');
        assert.strictEqual(
          localLockfile.bundles['local-bundle'].commitMode,
          undefined,
          'commitMode should NOT be in bundle entry'
        );
      });

      test('should keep commit and local-only bundles in separate lockfiles', async () => {
        // Requirements: 1.1, 1.2 - Bundles should be in correct lockfiles based on commitMode
        const manager = LockfileManager.getInstance(tempDir);

        // Create commit mode bundle
        const commitOptions = createTestOptions('commit-bundle');
        commitOptions.commitMode = 'commit';
        await manager.createOrUpdate(commitOptions);

        // Create local-only mode bundle
        const localOptions = createTestOptions('local-bundle');
        localOptions.commitMode = 'local-only';
        localOptions.sourceId = 'local-source';
        await manager.createOrUpdate(localOptions);

        // Verify commit bundle is only in main lockfile
        const mainLockfile = readLockfileFromDisk();
        assert.ok(mainLockfile!.bundles['commit-bundle'], 'Commit bundle should be in main lockfile');
        assert.strictEqual(mainLockfile!.bundles['local-bundle'], undefined, 'Local bundle should NOT be in main lockfile');

        // Verify local-only bundle is only in local lockfile
        const localLockfile = readLocalLockfileFromDisk();
        assert.ok(localLockfile!.bundles['local-bundle'], 'Local bundle should be in local lockfile');
        assert.strictEqual(localLockfile!.bundles['commit-bundle'], undefined, 'Commit bundle should NOT be in local lockfile');
      });

      test('should add local lockfile to git exclude on first local-only bundle creation', async () => {
        // Requirements: 2.1 - Add prompt-registry.local.lock.json to .git/info/exclude
        const manager = LockfileManager.getInstance(tempDir);

        // Create .git/info directory
        const gitInfoDir = path.join(tempDir, '.git', 'info');
        fs.mkdirSync(gitInfoDir, { recursive: true });

        // Create local-only bundle
        const options = createTestOptions('local-bundle');
        options.commitMode = 'local-only';
        await manager.createOrUpdate(options);

        // Verify .git/info/exclude has the local lockfile entry
        const excludePath = path.join(gitInfoDir, 'exclude');
        assert.ok(fs.existsSync(excludePath), '.git/info/exclude should exist');

        const excludeContent = fs.readFileSync(excludePath, 'utf8');
        assert.ok(
          excludeContent.includes('prompt-registry.local.lock.json'),
          'Local lockfile should be in git exclude'
        );
        assert.ok(
          excludeContent.includes('# Prompt Registry (local)'),
          'Git exclude should have Prompt Registry section header'
        );
      });

      test('should not add to git exclude when .git directory does not exist', async () => {
        // Requirements: 2.3 - Skip git exclude operations if .git directory does not exist
        const manager = LockfileManager.getInstance(tempDir);

        // Ensure .git directory does NOT exist
        const gitDir = path.join(tempDir, '.git');
        if (fs.existsSync(gitDir)) {
          fs.rmSync(gitDir, { recursive: true });
        }

        // Create local-only bundle - should not throw
        const options = createTestOptions('local-bundle');
        options.commitMode = 'local-only';
        await manager.createOrUpdate(options);

        // Verify local lockfile was created
        const localLockfile = readLocalLockfileFromDisk();
        assert.ok(localLockfile, 'Local lockfile should exist');

        // Verify .git/info/exclude was NOT created
        const excludePath = path.join(tempDir, '.git', 'info', 'exclude');
        assert.ok(!fs.existsSync(excludePath), '.git/info/exclude should NOT exist');
      });

      test('should not duplicate git exclude entry on subsequent local-only bundle creations', async () => {
        // Requirements: 2.5 - Prevent duplicate entries in git exclude
        const manager = LockfileManager.getInstance(tempDir);

        // Create .git/info directory
        const gitInfoDir = path.join(tempDir, '.git', 'info');
        fs.mkdirSync(gitInfoDir, { recursive: true });

        // Create first local-only bundle
        const options1 = createTestOptions('local-bundle-1');
        options1.commitMode = 'local-only';
        await manager.createOrUpdate(options1);

        // Create second local-only bundle
        const options2 = createTestOptions('local-bundle-2');
        options2.commitMode = 'local-only';
        options2.sourceId = 'source-2';
        await manager.createOrUpdate(options2);

        // Verify .git/info/exclude has only one entry for local lockfile
        const excludePath = path.join(gitInfoDir, 'exclude');
        const excludeContent = fs.readFileSync(excludePath, 'utf8');

        const matches = excludeContent.match(/prompt-registry\.local\.lock\.json/g);
        assert.strictEqual(matches?.length, 1, 'Local lockfile should appear only once in git exclude');
      });
    });
  });

  suite('remove()', () => {
    test('should remove bundle entry from lockfile', async () => {
      // Requirements: 4.8
      const lockfile = createMockLockfile(2);
      writeLockfile(lockfile);
      const manager = LockfileManager.getInstance(tempDir);
      await manager.remove('bundle-0');
      const updated = readLockfileFromDisk();
      assert.ok(!updated!.bundles['bundle-0']);
      assert.ok(updated!.bundles['bundle-1']);
    });

    test('should delete lockfile when last bundle is removed', async () => {
      // Requirements: 4.9
      const lockfile = createMockLockfile(1);
      writeLockfile(lockfile);
      const manager = LockfileManager.getInstance(tempDir);
      await manager.remove('bundle-0');
      assert.strictEqual(fs.existsSync(lockfilePath), false);
    });

    test('should preserve other bundles when removing one', async () => {
      const lockfile = createMockLockfile(3);
      writeLockfile(lockfile);
      const manager = LockfileManager.getInstance(tempDir);
      await manager.remove('bundle-1');
      const updated = readLockfileFromDisk();
      assert.ok(updated!.bundles['bundle-0']);
      assert.ok(!updated!.bundles['bundle-1']);
      assert.ok(updated!.bundles['bundle-2']);
    });

    test('should handle removing non-existent bundle gracefully', async () => {
      const lockfile = createMockLockfile(1);
      writeLockfile(lockfile);
      const manager = LockfileManager.getInstance(tempDir);
      await manager.remove('non-existent');
      const updated = readLockfileFromDisk();
      assert.ok(updated!.bundles['bundle-0']);
    });

    test('should clean up orphaned sources when bundle removed', async () => {
      // If a source is only referenced by the removed bundle, it should be cleaned up
      const manager = LockfileManager.getInstance(tempDir);

      // Create two bundles with different sources
      const options1 = createTestOptions('bundle-1');
      options1.sourceId = 'source-1';
      await manager.createOrUpdate(options1);

      const options2 = createTestOptions('bundle-2');
      options2.sourceId = 'source-2';
      options2.source = createMockSourceEntry('local', '/path/to/local/bundles');
      await manager.createOrUpdate(options2);

      // Remove bundle-1
      await manager.remove('bundle-1');

      const updated = readLockfileFromDisk();
      assert.ok(!updated!.sources['source-1'], 'Orphaned source should be removed');
      assert.ok(updated!.sources['source-2'], 'Referenced source should remain');
    });

    suite('Dual-Lockfile Remove Operations', () => {
      // Requirements: 5.1, 5.2, 5.3, 5.4 - Remove from correct lockfile

      const localLockfilePath = () => path.join(tempDir, 'prompt-registry.local.lock.json');

      const readLocalLockfileFromDisk = (): Lockfile | null => {
        const localPath = localLockfilePath();
        if (!fs.existsSync(localPath)) {
          return null;
        }
        return JSON.parse(fs.readFileSync(localPath, 'utf8'));
      };

      const writeLocalLockfile = (lockfile: Lockfile): void => {
        fs.writeFileSync(localLockfilePath(), JSON.stringify(lockfile, null, 2));
      };

      test('should remove local-only bundle from local lockfile', async () => {
        // Requirements: 5.1 - Remove local-only bundle from Local_Lockfile
        const localLockfile = createMockLockfile(2);
        writeLocalLockfile(localLockfile);

        const manager = LockfileManager.getInstance(tempDir);
        await manager.remove('bundle-0');

        // Bundle should be removed from local lockfile
        const updatedLocal = readLocalLockfileFromDisk();
        assert.ok(updatedLocal, 'Local lockfile should still exist');
        assert.ok(!updatedLocal.bundles['bundle-0'], 'bundle-0 should be removed');
        assert.ok(updatedLocal.bundles['bundle-1'], 'bundle-1 should remain');

        // Main lockfile should not exist
        const mainLockfile = readLockfileFromDisk();
        assert.strictEqual(mainLockfile, null, 'Main lockfile should not exist');
      });

      test('should remove committed bundle from main lockfile', async () => {
        // Requirements: 5.2 - Remove committed bundle from Main_Lockfile
        const mainLockfile = createMockLockfile(2);
        writeLockfile(mainLockfile);

        const manager = LockfileManager.getInstance(tempDir);
        await manager.remove('bundle-0');

        // Bundle should be removed from main lockfile
        const updatedMain = readLockfileFromDisk();
        assert.ok(updatedMain, 'Main lockfile should still exist');
        assert.ok(!updatedMain.bundles['bundle-0'], 'bundle-0 should be removed');
        assert.ok(updatedMain.bundles['bundle-1'], 'bundle-1 should remain');

        // Local lockfile should not exist
        const localLockfile = readLocalLockfileFromDisk();
        assert.strictEqual(localLockfile, null, 'Local lockfile should not exist');
      });

      test('should delete local lockfile when last local-only bundle is removed', async () => {
        // Requirements: 5.3 - Delete Local_Lockfile when last bundle removed
        const localLockfile = createMockLockfile(1);
        writeLocalLockfile(localLockfile);

        const manager = LockfileManager.getInstance(tempDir);
        await manager.remove('bundle-0');

        // Local lockfile should be deleted
        assert.strictEqual(fs.existsSync(localLockfilePath()), false, 'Local lockfile should be deleted');
      });

      test('should delete main lockfile when last committed bundle is removed', async () => {
        // Requirements: 5.5 - Delete Main_Lockfile when last bundle removed
        const mainLockfile = createMockLockfile(1);
        writeLockfile(mainLockfile);

        const manager = LockfileManager.getInstance(tempDir);
        await manager.remove('bundle-0');

        // Main lockfile should be deleted
        assert.strictEqual(fs.existsSync(lockfilePath), false, 'Main lockfile should be deleted');
      });

      test('should remove local lockfile from git exclude when local lockfile is deleted', async () => {
        // Requirements: 5.4 - Remove local lockfile from git exclude when deleted
        const localLockfile = createMockLockfile(1);
        writeLocalLockfile(localLockfile);

        // Create .git/info directory with local lockfile entry
        const gitInfoDir = path.join(tempDir, '.git', 'info');
        fs.mkdirSync(gitInfoDir, { recursive: true });
        const excludePath = path.join(gitInfoDir, 'exclude');
        fs.writeFileSync(excludePath, '# Prompt Registry (local)\nprompt-registry.local.lock.json\n');

        const manager = LockfileManager.getInstance(tempDir);
        await manager.remove('bundle-0');

        // Local lockfile should be deleted
        assert.strictEqual(fs.existsSync(localLockfilePath()), false, 'Local lockfile should be deleted');

        // Git exclude should no longer have the local lockfile entry
        const excludeContent = fs.readFileSync(excludePath, 'utf8');
        assert.ok(
          !excludeContent.includes('prompt-registry.local.lock.json'),
          'Local lockfile should be removed from git exclude'
        );
      });

      test('should remove from correct lockfile when both exist', async () => {
        // Test that remove finds the bundle in the correct lockfile
        const mainLockfile = LockfileBuilder.create()
          .withSource('main-source', 'github', 'https://github.com/main/repo')
          .withBundle('main-bundle', '1.0.0', 'main-source')
          .build();
        writeLockfile(mainLockfile);

        const localLockfile = LockfileBuilder.create()
          .withSource('local-source', 'github', 'https://github.com/local/repo')
          .withBundle('local-bundle', '1.0.0', 'local-source')
          .build();
        writeLocalLockfile(localLockfile);

        const manager = LockfileManager.getInstance(tempDir);

        // Remove from local lockfile
        await manager.remove('local-bundle');

        // Local lockfile should be deleted (was the only bundle)
        assert.strictEqual(fs.existsSync(localLockfilePath()), false, 'Local lockfile should be deleted');

        // Main lockfile should still have its bundle
        const updatedMain = readLockfileFromDisk();
        assert.ok(updatedMain, 'Main lockfile should still exist');
        assert.ok(updatedMain.bundles['main-bundle'], 'main-bundle should remain');
      });

      test('should handle removing non-existent bundle from both lockfiles gracefully', async () => {
        // Test that remove handles non-existent bundle when both lockfiles exist
        const mainLockfile = createMockLockfile(1);
        writeLockfile(mainLockfile);

        const localLockfile = createMockLockfile(1);
        writeLocalLockfile(localLockfile);

        const manager = LockfileManager.getInstance(tempDir);

        // Remove non-existent bundle - should not throw
        await manager.remove('non-existent');

        // Both lockfiles should remain unchanged
        const updatedMain = readLockfileFromDisk();
        const updatedLocal = readLocalLockfileFromDisk();
        assert.ok(updatedMain!.bundles['bundle-0'], 'Main lockfile bundle should remain');
        assert.ok(updatedLocal!.bundles['bundle-0'], 'Local lockfile bundle should remain');
      });
    });
  });

  suite('updateCommitMode()', () => {
    const localLockfilePath = () => path.join(tempDir, 'prompt-registry.local.lock.json');

    const readLocalLockfileFromDisk = (): Lockfile | null => {
      const localPath = localLockfilePath();
      if (!fs.existsSync(localPath)) {
        return null;
      }
      return JSON.parse(fs.readFileSync(localPath, 'utf8'));
    };

    const writeLocalLockfile = (lockfile: Lockfile): void => {
      fs.writeFileSync(localLockfilePath(), JSON.stringify(lockfile, null, 2));
    };

    test('should move bundle from main lockfile to local lockfile when switching to local-only', async () => {
      // Requirements: 4.1 - Move bundle from Main_Lockfile to Local_Lockfile
      const lockfile = createMockLockfile(1);
      writeLockfile(lockfile);

      const manager = LockfileManager.getInstance(tempDir);
      await manager.updateCommitMode('bundle-0', 'local-only');

      // Bundle should be in local lockfile
      const localLockfile = readLocalLockfileFromDisk();
      assert.ok(localLockfile, 'Local lockfile should exist');
      assert.ok(localLockfile.bundles['bundle-0'], 'Bundle should be in local lockfile');

      // Bundle should NOT be in main lockfile (main lockfile should be deleted since it was the only bundle)
      const mainLockfile = readLockfileFromDisk();
      assert.strictEqual(mainLockfile, null, 'Main lockfile should be deleted when empty');
    });

    test('should move bundle from local lockfile to main lockfile when switching to commit', async () => {
      // Requirements: 4.2 - Move bundle from Local_Lockfile to Main_Lockfile
      const lockfile = createMockLockfile(1);
      writeLocalLockfile(lockfile);

      const manager = LockfileManager.getInstance(tempDir);
      await manager.updateCommitMode('bundle-0', 'commit');

      // Bundle should be in main lockfile
      const mainLockfile = readLockfileFromDisk();
      assert.ok(mainLockfile, 'Main lockfile should exist');
      assert.ok(mainLockfile.bundles['bundle-0'], 'Bundle should be in main lockfile');

      // Bundle should NOT be in local lockfile (local lockfile should be deleted since it was the only bundle)
      const localLockfile = readLocalLockfileFromDisk();
      assert.strictEqual(localLockfile, null, 'Local lockfile should be deleted when empty');
    });

    test('should update generatedAt timestamp in target lockfile', async () => {
      const lockfile = createMockLockfile(1);
      const originalTimestamp = lockfile.generatedAt;
      writeLockfile(lockfile);

      // Wait a bit to ensure timestamp changes
      await new Promise((resolve) => setTimeout(resolve, 10));

      const manager = LockfileManager.getInstance(tempDir);
      await manager.updateCommitMode('bundle-0', 'local-only');

      const localLockfile = readLocalLockfileFromDisk();
      assert.ok(localLockfile, 'Local lockfile should exist');
      assert.notStrictEqual(localLockfile.generatedAt, originalTimestamp);
    });

    test('should throw error if bundle not found in source lockfile', async () => {
      // Requirements: 4.6 - Return error if bundle not found in source lockfile
      const manager = LockfileManager.getInstance(tempDir);

      await assert.rejects(
        async () => manager.updateCommitMode('bundle-0', 'local-only'),
        /Bundle bundle-0 not found in commit lockfile/
      );
    });

    test('should throw error if bundle not found when switching to commit', async () => {
      // Requirements: 4.6 - Return error if bundle not found in source lockfile
      const lockfile = createMockLockfile(1);
      writeLockfile(lockfile);

      const manager = LockfileManager.getInstance(tempDir);

      // Bundle is in main lockfile, but we're trying to switch to commit (which looks in local lockfile)
      await assert.rejects(
        async () => manager.updateCommitMode('non-existent', 'local-only'),
        /Bundle non-existent not found in commit lockfile/
      );
    });

    test('should emit onLockfileUpdated event with target lockfile', async () => {
      const lockfile = createMockLockfile(1);
      writeLockfile(lockfile);

      const manager = LockfileManager.getInstance(tempDir);
      let eventFired = false;
      let eventLockfile: Lockfile | null = null;

      manager.onLockfileUpdated((lf) => {
        eventFired = true;
        eventLockfile = lf;
      });

      await manager.updateCommitMode('bundle-0', 'local-only');

      assert.ok(eventFired, 'Event should be fired');
      // The event should contain the target lockfile (local lockfile) with the bundle
      assert.ok(eventLockfile!.bundles['bundle-0'], 'Event lockfile should contain the moved bundle');
    });

    test('should preserve all bundle metadata during move', async () => {
      // Requirements: 4.3 - Preserve all bundle metadata during move
      const lockfile = createMockLockfile(1);
      const originalVersion = lockfile.bundles['bundle-0'].version;
      const originalSourceId = lockfile.bundles['bundle-0'].sourceId;
      const originalSourceType = lockfile.bundles['bundle-0'].sourceType;
      const originalInstalledAt = lockfile.bundles['bundle-0'].installedAt;
      const originalFiles = lockfile.bundles['bundle-0'].files;
      writeLockfile(lockfile);

      const manager = LockfileManager.getInstance(tempDir);
      await manager.updateCommitMode('bundle-0', 'local-only');

      const localLockfile = readLocalLockfileFromDisk();
      assert.ok(localLockfile, 'Local lockfile should exist');
      assert.strictEqual(localLockfile.bundles['bundle-0'].version, originalVersion, 'Version should be preserved');
      assert.strictEqual(localLockfile.bundles['bundle-0'].sourceId, originalSourceId, 'SourceId should be preserved');
      assert.strictEqual(localLockfile.bundles['bundle-0'].sourceType, originalSourceType, 'SourceType should be preserved');
      assert.strictEqual(localLockfile.bundles['bundle-0'].installedAt, originalInstalledAt, 'InstalledAt should be preserved');
      assert.deepStrictEqual(localLockfile.bundles['bundle-0'].files, originalFiles, 'Files should be preserved');
    });

    test('should copy source entry to target lockfile', async () => {
      // Requirements: 4.3 - Source entry should be migrated
      const lockfile = createMockLockfile(1);
      const sourceId = lockfile.bundles['bundle-0'].sourceId;
      const originalSource = lockfile.sources[sourceId];
      writeLockfile(lockfile);

      const manager = LockfileManager.getInstance(tempDir);
      await manager.updateCommitMode('bundle-0', 'local-only');

      const localLockfile = readLocalLockfileFromDisk();
      assert.ok(localLockfile, 'Local lockfile should exist');
      assert.ok(localLockfile.sources[sourceId], 'Source should be copied to local lockfile');
      assert.strictEqual(localLockfile.sources[sourceId].type, originalSource.type, 'Source type should be preserved');
      assert.strictEqual(localLockfile.sources[sourceId].url, originalSource.url, 'Source URL should be preserved');
    });

    test('should add local lockfile to git exclude when moving to local-only', async () => {
      // Requirements: 4.4 - Add local lockfile to git exclude when moving to local-only
      const lockfile = createMockLockfile(1);
      writeLockfile(lockfile);

      // Create .git/info directory
      const gitInfoDir = path.join(tempDir, '.git', 'info');
      fs.mkdirSync(gitInfoDir, { recursive: true });

      const manager = LockfileManager.getInstance(tempDir);
      await manager.updateCommitMode('bundle-0', 'local-only');

      // Verify .git/info/exclude has the local lockfile entry
      const excludePath = path.join(gitInfoDir, 'exclude');
      assert.ok(fs.existsSync(excludePath), '.git/info/exclude should exist');

      const excludeContent = fs.readFileSync(excludePath, 'utf8');
      assert.ok(
        excludeContent.includes('prompt-registry.local.lock.json'),
        'Local lockfile should be in git exclude'
      );
    });

    test('should remove local lockfile from git exclude when local lockfile becomes empty', async () => {
      // Requirements: 4.5 - Remove local lockfile from git exclude when empty
      const lockfile = createMockLockfile(1);
      writeLocalLockfile(lockfile);

      // Create .git/info directory with local lockfile entry
      const gitInfoDir = path.join(tempDir, '.git', 'info');
      fs.mkdirSync(gitInfoDir, { recursive: true });
      const excludePath = path.join(gitInfoDir, 'exclude');
      fs.writeFileSync(excludePath, '# Prompt Registry (local)\nprompt-registry.local.lock.json\n');

      const manager = LockfileManager.getInstance(tempDir);
      await manager.updateCommitMode('bundle-0', 'commit');

      // Local lockfile should be deleted (was the only bundle)
      assert.strictEqual(fs.existsSync(localLockfilePath()), false, 'Local lockfile should be deleted');

      // Git exclude should no longer have the local lockfile entry
      const excludeContent = fs.readFileSync(excludePath, 'utf8');
      assert.ok(
        !excludeContent.includes('prompt-registry.local.lock.json'),
        'Local lockfile should be removed from git exclude'
      );
    });

    test('should preserve other bundles in source lockfile when moving one', async () => {
      const lockfile = createMockLockfile(2);
      writeLockfile(lockfile);

      const manager = LockfileManager.getInstance(tempDir);
      await manager.updateCommitMode('bundle-0', 'local-only');

      // bundle-0 should be in local lockfile
      const localLockfile = readLocalLockfileFromDisk();
      assert.ok(localLockfile!.bundles['bundle-0'], 'bundle-0 should be in local lockfile');

      // bundle-1 should still be in main lockfile
      const mainLockfile = readLockfileFromDisk();
      assert.ok(mainLockfile, 'Main lockfile should still exist');
      assert.ok(mainLockfile.bundles['bundle-1'], 'bundle-1 should still be in main lockfile');
      assert.ok(!mainLockfile.bundles['bundle-0'], 'bundle-0 should NOT be in main lockfile');
    });
  });

  suite('read()', () => {
    test('should return lockfile when it exists', async () => {
      // Requirements: 5.2
      const lockfile = createMockLockfile(2);
      writeLockfile(lockfile);
      const manager = LockfileManager.getInstance(tempDir);
      const result = await manager.read();
      assert.ok(result);
      assert.strictEqual(Object.keys(result.bundles).length, 2);
    });

    test('should return null when lockfile does not exist', async () => {
      // Requirements: 5.1
      const manager = LockfileManager.getInstance(tempDir);
      const result = await manager.read();
      assert.strictEqual(result, null);
    });

    test('should parse and return valid lockfile structure', async () => {
      // Requirements: 5.2
      const lockfile = createMockLockfile(1, { includeHubs: true, includeProfiles: true });
      writeLockfile(lockfile);
      const manager = LockfileManager.getInstance(tempDir);
      const result = await manager.read();
      assert.ok(result!.bundles);
      assert.ok(result!.sources);
      assert.ok(result!.hubs);
      assert.ok(result!.profiles);
    });

    test('should handle corrupted lockfile gracefully', async () => {
      fs.writeFileSync(lockfilePath, 'not valid json');
      const manager = LockfileManager.getInstance(tempDir);
      const result = await manager.read();
      // Should return null for corrupted file
      assert.strictEqual(result, null);
    });
  });

  suite('validate()', () => {
    test('should return valid result for valid lockfile', async () => {
      // Requirements: 5.2
      const lockfile = createMockLockfile(1);
      writeLockfile(lockfile);
      const manager = LockfileManager.getInstance(tempDir);
      const result = await manager.validate();
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
    });

    test('should detect missing required fields', async () => {
      const invalidLockfile = { bundles: {} };
      fs.writeFileSync(lockfilePath, JSON.stringify(invalidLockfile));
      const manager = LockfileManager.getInstance(tempDir);
      const result = await manager.validate();
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.length > 0);
    });

    test('should return schema version in result', async () => {
      const lockfile = createMockLockfile(1);
      writeLockfile(lockfile);
      const manager = LockfileManager.getInstance(tempDir);
      const result = await manager.validate();
      assert.ok(result.schemaVersion);
    });

    test('should return valid=false when lockfile does not exist', async () => {
      const manager = LockfileManager.getInstance(tempDir);
      const result = await manager.validate();
      assert.strictEqual(result.valid, false);
    });

    test('should use fallback schema path when extension not available', async () => {
      // Requirements: 11.4 - Schema path resolution with fallback
      // In test environment, extension is not available, so it should fall back to process.cwd()
      const lockfile = createMockLockfile(1);
      writeLockfile(lockfile);
      const manager = LockfileManager.getInstance(tempDir);

      // Validation should still work using fallback path (process.cwd()/schemas/)
      const result = await manager.validate();
      // If schema is found via fallback, validation should succeed for valid lockfile
      assert.strictEqual(result.valid, true);
    });

    test('should load schema from extension path when available', async () => {
      // Requirements: 11.4 - Schema path resolution from extension
      // This test verifies the schema loading works regardless of source
      const lockfile = createMockLockfile(1);
      writeLockfile(lockfile);
      const manager = LockfileManager.getInstance(tempDir);

      // Store original getExtension if it exists
      const originalGetExtension = vscode.extensions?.getExtension;

      // Mock vscode.extensions.getExtension to return a mock extension
      const mockExtension = {
        extensionPath: process.cwd(), // Use cwd as mock extension path
        packageJSON: { version: '1.0.0' }
      };

      // Ensure vscode.extensions exists
      if (!vscode.extensions) {
        (vscode as any).extensions = {};
      }
      (vscode.extensions as any).getExtension = (id: string) => {
        if (id === 'AmadeusITGroup.prompt-registry') {
          return mockExtension;
        }
        return originalGetExtension?.(id);
      };

      try {
        const result = await manager.validate();
        // Schema should be found and validation should work
        assert.strictEqual(result.valid, true);
      } finally {
        // Restore original
        if (originalGetExtension) {
          (vscode.extensions as any).getExtension = originalGetExtension;
        }
      }
    });
  });

  suite('detectModifiedFiles()', () => {
    test('should return empty array when no files modified', async () => {
      // Requirements: 14.1-14.2
      const manager = LockfileManager.getInstance(tempDir);

      // Create a test file
      const testFilePath = path.join(tempDir, '.github', 'prompts', 'test.prompt.md');
      fs.mkdirSync(path.dirname(testFilePath), { recursive: true });
      fs.writeFileSync(testFilePath, 'test content');

      // Calculate checksum and create lockfile
      const checksum = await calculateFileChecksum(testFilePath);
      const options = createTestOptions('test-bundle');
      options.files = [{ path: '.github/prompts/test.prompt.md', checksum }];
      await manager.createOrUpdate(options);

      const result = await manager.detectModifiedFiles('test-bundle');
      assert.strictEqual(result.length, 0);
    });

    test('should detect modified files by checksum comparison', async () => {
      // Requirements: 14.2
      const manager = LockfileManager.getInstance(tempDir);

      // Create a test file
      const testFilePath = path.join(tempDir, '.github', 'prompts', 'test.prompt.md');
      fs.mkdirSync(path.dirname(testFilePath), { recursive: true });
      fs.writeFileSync(testFilePath, 'original content');

      // Calculate checksum and create lockfile
      const checksum = await calculateFileChecksum(testFilePath);
      const options = createTestOptions('test-bundle');
      options.files = [{ path: '.github/prompts/test.prompt.md', checksum }];
      await manager.createOrUpdate(options);

      // Modify the file
      fs.writeFileSync(testFilePath, 'modified content');

      const result = await manager.detectModifiedFiles('test-bundle');
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].modificationType, 'modified');
    });

    test('should detect missing files', async () => {
      // Requirements: 14.3
      const manager = LockfileManager.getInstance(tempDir);

      // Create lockfile with file entry but don't create the file
      const options = createTestOptions('test-bundle');
      options.files = [{ path: '.github/prompts/missing.prompt.md', checksum: 'abc123' }];
      await manager.createOrUpdate(options);

      const result = await manager.detectModifiedFiles('test-bundle');
      assert.strictEqual(result[0].modificationType, 'missing');
    });

    test('should include original and current checksums in result', async () => {
      // Requirements: 14.2
      const manager = LockfileManager.getInstance(tempDir);

      // Create a test file
      const testFilePath = path.join(tempDir, '.github', 'prompts', 'test.prompt.md');
      fs.mkdirSync(path.dirname(testFilePath), { recursive: true });
      fs.writeFileSync(testFilePath, 'original content');

      const originalChecksum = await calculateFileChecksum(testFilePath);
      const options = createTestOptions('test-bundle');
      options.files = [{ path: '.github/prompts/test.prompt.md', checksum: originalChecksum }];
      await manager.createOrUpdate(options);

      // Modify the file
      fs.writeFileSync(testFilePath, 'modified content');

      const result = await manager.detectModifiedFiles('test-bundle');
      assert.ok(result[0].originalChecksum);
      assert.ok(result[0].currentChecksum);
      assert.notStrictEqual(result[0].originalChecksum, result[0].currentChecksum);
    });

    test('should return empty array for non-existent bundle', async () => {
      const manager = LockfileManager.getInstance(tempDir);
      const result = await manager.detectModifiedFiles('non-existent');
      assert.strictEqual(result.length, 0);
    });
  });

  suite('Events', () => {
    test('should emit onLockfileUpdated event when lockfile created', async () => {
      const manager = LockfileManager.getInstance(tempDir);
      let eventFired = false;
      manager.onLockfileUpdated(() => {
        eventFired = true;
      });
      await manager.createOrUpdate(createTestOptions('test-bundle'));
      assert.strictEqual(eventFired, true);
    });

    test('should emit onLockfileUpdated event when lockfile updated', async () => {
      const lockfile = createMockLockfile(1);
      writeLockfile(lockfile);
      const manager = LockfileManager.getInstance(tempDir);
      let eventFired = false;
      manager.onLockfileUpdated(() => {
        eventFired = true;
      });
      await manager.createOrUpdate(createTestOptions('new-bundle'));
      assert.strictEqual(eventFired, true);
    });

    test('should emit onLockfileUpdated event when bundle removed', async () => {
      const lockfile = createMockLockfile(2);
      writeLockfile(lockfile);
      const manager = LockfileManager.getInstance(tempDir);
      let eventFired = false;
      manager.onLockfileUpdated(() => {
        eventFired = true;
      });
      await manager.remove('bundle-0');
      assert.strictEqual(eventFired, true);
    });

    test('should emit onLockfileUpdated event when lockfile deleted', async () => {
      const lockfile = createMockLockfile(1);
      writeLockfile(lockfile);
      const manager = LockfileManager.getInstance(tempDir);
      let eventFired = false;
      let receivedNull = false;
      manager.onLockfileUpdated((lf) => {
        eventFired = true;
        receivedNull = lf === null;
      });
      await manager.remove('bundle-0');
      assert.strictEqual(eventFired, true);
      assert.strictEqual(receivedNull, true);
    });
  });

  suite('getLockfilePath()', () => {
    test('should return correct lockfile path', () => {
      const manager = LockfileManager.getInstance(tempDir);
      lockfilePath = manager.getLockfilePath();
      assert.ok(lockfilePath.endsWith('prompt-registry.lock.json'));
    });
  });

  suite('getLocalLockfilePath()', () => {
    test('should return correct local lockfile path', () => {
      const manager = LockfileManager.getInstance(tempDir);
      const localLockfilePath = manager.getLocalLockfilePath();
      assert.ok(localLockfilePath.endsWith('prompt-registry.local.lock.json'));
    });

    test('should return path in repository root', () => {
      const manager = LockfileManager.getInstance(tempDir);
      const localLockfilePath = manager.getLocalLockfilePath();
      assert.ok(localLockfilePath.startsWith(tempDir));
    });

    test('should return different path than main lockfile', () => {
      const manager = LockfileManager.getInstance(tempDir);
      const mainPath = manager.getLockfilePath();
      const localPath = manager.getLocalLockfilePath();
      assert.notStrictEqual(mainPath, localPath);
    });
  });

  suite('Lockfile Deletion Error Handling', () => {
    // Requirements: 3.5 - If lockfile deletion fails, log error and continue without throwing

    test('should log error and not throw when lockfile deletion fails', async () => {
      // Requirements: 3.5 - Error is logged, no exception thrown
      const lockfile = createMockLockfile(1);
      writeLockfile(lockfile);

      const manager = LockfileManager.getInstance(tempDir);

      // Stub fs.promises.unlink to simulate deletion failure
      const unlinkStub = sandbox.stub(fs.promises, 'unlink').rejects(new Error('Permission denied'));

      // Track if error was logged
      const logger = Logger.getInstance();
      const logErrorStub = sandbox.stub(logger, 'error');

      // Remove the last bundle - this should trigger lockfile deletion
      // which will fail, but should NOT throw
      await assert.doesNotReject(
        async () => manager.remove('bundle-0'),
        'remove() should not throw when lockfile deletion fails'
      );

      // Verify error was logged
      assert.ok(logErrorStub.called, 'Error should be logged');
      assert.ok(
        logErrorStub.firstCall.args[0].includes('Failed to delete lockfile'),
        'Error message should mention lockfile deletion failure'
      );

      // Verify unlink was attempted
      assert.ok(unlinkStub.called, 'unlink should have been called');
    });

    test('should emit onLockfileUpdated with null even when deletion fails', async () => {
      // Requirements: 3.5 - Continue operation (emit event) even on deletion failure
      const lockfile = createMockLockfile(1);
      writeLockfile(lockfile);

      const manager = LockfileManager.getInstance(tempDir);

      // Stub fs.promises.unlink to simulate deletion failure
      sandbox.stub(fs.promises, 'unlink').rejects(new Error('Permission denied'));

      // Track events
      let eventFired = false;
      let receivedNull = false;
      manager.onLockfileUpdated((lf) => {
        eventFired = true;
        receivedNull = lf === null;
      });

      // Remove the last bundle
      await manager.remove('bundle-0');

      // Event should still fire with null even though deletion failed
      assert.strictEqual(eventFired, true, 'Event should be fired');
      assert.strictEqual(receivedNull, true, 'Event should receive null');
    });
  });

  suite('File Watcher Initialization and Disposal', () => {
    // Requirements: 2.4, 2.5 - File watcher initialization and disposal

    let mockFileWatcher: {
      onDidChange: sinon.SinonStub;
      onDidCreate: sinon.SinonStub;
      onDidDelete: sinon.SinonStub;
      dispose: sinon.SinonStub;
    };
    let createFileSystemWatcherStub: sinon.SinonStub;

    setup(() => {
      // Create mock file watcher with stubbed methods
      mockFileWatcher = {
        onDidChange: sandbox.stub().returns({ dispose: sandbox.stub() }),
        onDidCreate: sandbox.stub().returns({ dispose: sandbox.stub() }),
        onDidDelete: sandbox.stub().returns({ dispose: sandbox.stub() }),
        dispose: sandbox.stub()
      };

      // Stub vscode.workspace.createFileSystemWatcher
      createFileSystemWatcherStub = sandbox.stub(vscode.workspace, 'createFileSystemWatcher')
        .returns(mockFileWatcher as any);
    });

    test('should initialize file watcher on construction', () => {
      // Requirements: 2.4 - File watcher is initialized on construction
      LockfileManager.resetInstance();

      // Create a new instance - this should call setupFileWatcher
      const manager = LockfileManager.getInstance(tempDir);

      // Verify createFileSystemWatcher was called
      assert.ok(createFileSystemWatcherStub.calledOnce, 'createFileSystemWatcher should be called once');

      // Verify the pattern includes the lockfile name
      const callArgs = createFileSystemWatcherStub.firstCall.args;
      assert.ok(callArgs[0], 'Pattern should be provided');

      // Verify event handlers were registered
      assert.ok(mockFileWatcher.onDidChange.calledOnce, 'onDidChange handler should be registered');
      assert.ok(mockFileWatcher.onDidCreate.calledOnce, 'onDidCreate handler should be registered');
      assert.ok(mockFileWatcher.onDidDelete.calledOnce, 'onDidDelete handler should be registered');

      // Clean up
      manager.dispose();
    });

    test('should dispose file watcher on dispose() call', () => {
      // Requirements: 2.5 - File watcher is disposed on dispose() call
      LockfileManager.resetInstance();

      const manager = LockfileManager.getInstance(tempDir);

      // Verify watcher was created
      assert.ok(createFileSystemWatcherStub.calledOnce);

      // Dispose the manager
      manager.dispose();

      // Verify file watcher dispose was called
      assert.ok(mockFileWatcher.dispose.calledOnce, 'File watcher dispose should be called');
    });

    test('should not fire events after disposal', async () => {
      // Requirements: 2.5 - No events fire after disposal
      LockfileManager.resetInstance();

      const manager = LockfileManager.getInstance(tempDir);

      // Track events
      let eventCount = 0;
      const disposable = manager.onLockfileUpdated(() => {
        eventCount++;
      });

      // Capture the handlers that were registered with the file watcher
      const changeHandler = mockFileWatcher.onDidChange.firstCall?.args[0];
      const createHandler = mockFileWatcher.onDidCreate.firstCall?.args[0];
      const deleteHandler = mockFileWatcher.onDidDelete.firstCall?.args[0];

      // Dispose the manager - this should dispose the event emitter
      manager.dispose();

      // After dispose, calling the file watcher handlers should not propagate
      // events to listeners because the EventEmitter is disposed
      // Simulate external file changes by invoking the captured handlers
      if (changeHandler) {
        try {
          changeHandler();
        } catch { /* handler may fail after dispose */ }
      }
      if (createHandler) {
        try {
          createHandler();
        } catch { /* handler may fail after dispose */ }
      }
      if (deleteHandler) {
        try {
          deleteHandler();
        } catch { /* handler may fail after dispose */ }
      }

      // Allow any async operations to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Verify no events were fired to listeners after disposal
      assert.strictEqual(eventCount, 0, 'No events should fire after disposal');

      disposable.dispose();
    });

    test('should handle file watcher initialization failure gracefully', () => {
      // Test that the manager handles errors during file watcher setup
      LockfileManager.resetInstance();

      // Make createFileSystemWatcher throw an error
      createFileSystemWatcherStub.throws(new Error('Mock watcher creation failed'));

      // Creating the manager should not throw
      let manager: LockfileManager | undefined;
      assert.doesNotThrow(() => {
        manager = LockfileManager.getInstance(tempDir);
      }, 'Manager creation should not throw even if file watcher fails');

      // Manager should still be functional for basic operations
      assert.ok(manager, 'Manager should be created');

      // Clean up
      manager?.dispose();
    });
  });

  suite('getInstalledBundles() - Dual Lockfile Support', () => {
    // Requirements: 3.1, 3.2, 3.3, 3.4 - Unified bundle listing with conflict detection

    const localLockfilePath = () => path.join(tempDir, 'prompt-registry.local.lock.json');

    const writeLocalLockfile = (lockfile: Lockfile): void => {
      fs.writeFileSync(localLockfilePath(), JSON.stringify(lockfile, null, 2));
    };

    test('should return empty array when no lockfiles exist', async () => {
      // Requirements: 3.1 - Read from both lockfiles
      const manager = LockfileManager.getInstance(tempDir);
      const bundles = await manager.getInstalledBundles();
      assert.strictEqual(bundles.length, 0);
    });

    test('should return bundles from main lockfile only when local lockfile does not exist', async () => {
      // Requirements: 3.1, 3.3 - Read from main lockfile, set commitMode: 'commit'
      const mainLockfile = createMockLockfile(2);
      writeLockfile(mainLockfile);

      const manager = LockfileManager.getInstance(tempDir);
      const bundles = await manager.getInstalledBundles();

      assert.strictEqual(bundles.length, 2);
      assert.ok(bundles.every((b) => b.commitMode === 'commit'), 'All bundles from main lockfile should have commitMode: commit');
    });

    test('should return bundles from local lockfile only when main lockfile does not exist', async () => {
      // Requirements: 3.1, 3.2 - Read from local lockfile, set commitMode: 'local-only'
      const localLockfile = createMockLockfile(2, { commitMode: 'local-only' });
      writeLocalLockfile(localLockfile);

      const manager = LockfileManager.getInstance(tempDir);
      const bundles = await manager.getInstalledBundles();

      assert.strictEqual(bundles.length, 2);
      assert.ok(bundles.every((b) => b.commitMode === 'local-only'), 'All bundles from local lockfile should have commitMode: local-only');
    });

    test('should merge bundles from both lockfiles', async () => {
      // Requirements: 3.1 - Read from both Main_Lockfile and Local_Lockfile
      const mainLockfile = LockfileBuilder.create()
        .withSource('main-source', 'github', 'https://github.com/main/repo')
        .withBundle('main-bundle-1', '1.0.0', 'main-source', { commitMode: 'commit' })
        .withBundle('main-bundle-2', '2.0.0', 'main-source', { commitMode: 'commit' })
        .build();
      writeLockfile(mainLockfile);

      const localLockfile = LockfileBuilder.create()
        .withSource('local-source', 'github', 'https://github.com/local/repo')
        .withBundle('local-bundle-1', '1.0.0', 'local-source', { commitMode: 'local-only' })
        .build();
      writeLocalLockfile(localLockfile);

      const manager = LockfileManager.getInstance(tempDir);
      const bundles = await manager.getInstalledBundles();

      assert.strictEqual(bundles.length, 3, 'Should have 3 bundles total');

      const mainBundles = bundles.filter((b) => b.commitMode === 'commit');
      const localBundles = bundles.filter((b) => b.commitMode === 'local-only');

      assert.strictEqual(mainBundles.length, 2, 'Should have 2 bundles from main lockfile');
      assert.strictEqual(localBundles.length, 1, 'Should have 1 bundle from local lockfile');
    });

    test('should annotate bundles from main lockfile with commitMode: commit', async () => {
      // Requirements: 3.3 - Set commitMode: 'commit' on bundles from Main_Lockfile
      const mainLockfile = createMockLockfile(1);
      // Even if the entry has a different commitMode, it should be overridden
      mainLockfile.bundles['bundle-0'].commitMode = 'local-only';
      writeLockfile(mainLockfile);

      const manager = LockfileManager.getInstance(tempDir);
      const bundles = await manager.getInstalledBundles();

      assert.strictEqual(bundles.length, 1);
      assert.strictEqual(bundles[0].commitMode, 'commit', 'Bundle from main lockfile should have commitMode: commit regardless of entry value');
    });

    test('should annotate bundles from local lockfile with commitMode: local-only', async () => {
      // Requirements: 3.2 - Set commitMode: 'local-only' on bundles from Local_Lockfile
      const localLockfile = createMockLockfile(1);
      // Even if the entry has a different commitMode, it should be overridden
      localLockfile.bundles['bundle-0'].commitMode = 'commit';
      writeLocalLockfile(localLockfile);

      const manager = LockfileManager.getInstance(tempDir);
      const bundles = await manager.getInstalledBundles();

      assert.strictEqual(bundles.length, 1);
      assert.strictEqual(bundles[0].commitMode, 'local-only', 'Bundle from local lockfile should have commitMode: local-only regardless of entry value');
    });

    test('should detect conflict when bundle ID exists in both lockfiles', async () => {
      // Requirements: 3.4 - Display error when bundle ID exists in both lockfiles
      const conflictingBundleId = 'conflicting-bundle';

      const mainLockfile = LockfileBuilder.create()
        .withSource('main-source', 'github', 'https://github.com/main/repo')
        .withBundle(conflictingBundleId, '1.0.0', 'main-source', { commitMode: 'commit' })
        .build();
      writeLockfile(mainLockfile);

      const localLockfile = LockfileBuilder.create()
        .withSource('local-source', 'github', 'https://github.com/local/repo')
        .withBundle(conflictingBundleId, '2.0.0', 'local-source', { commitMode: 'local-only' })
        .build();
      writeLocalLockfile(localLockfile);

      // Track error message display
      const showErrorMessageStub = sandbox.stub(vscode.window, 'showErrorMessage');

      const manager = LockfileManager.getInstance(tempDir);
      const bundles = await manager.getInstalledBundles();

      // Should only return the bundle from main lockfile (first one wins)
      assert.strictEqual(bundles.length, 1, 'Should only return 1 bundle (conflict skips local)');
      assert.strictEqual(bundles[0].bundleId, conflictingBundleId);
      assert.strictEqual(bundles[0].commitMode, 'commit', 'Should be from main lockfile');

      // Should display error message
      assert.ok(showErrorMessageStub.calledOnce, 'Should display error message for conflict');
      assert.ok(
        showErrorMessageStub.firstCall.args[0].includes(conflictingBundleId),
        'Error message should contain the conflicting bundle ID'
      );
      assert.ok(
        showErrorMessageStub.firstCall.args[0].includes('both lockfiles'),
        'Error message should mention both lockfiles'
      );
    });

    test('should log error when conflict is detected', async () => {
      // Requirements: 3.4 - Log error for conflicts
      const conflictingBundleId = 'conflicting-bundle';

      const mainLockfile = LockfileBuilder.create()
        .withSource('main-source', 'github', 'https://github.com/main/repo')
        .withBundle(conflictingBundleId, '1.0.0', 'main-source')
        .build();
      writeLockfile(mainLockfile);

      const localLockfile = LockfileBuilder.create()
        .withSource('local-source', 'github', 'https://github.com/local/repo')
        .withBundle(conflictingBundleId, '2.0.0', 'local-source')
        .build();
      writeLocalLockfile(localLockfile);

      // Track logger error calls
      const logger = Logger.getInstance();
      const logErrorStub = sandbox.stub(logger, 'error');
      sandbox.stub(vscode.window, 'showErrorMessage');

      const manager = LockfileManager.getInstance(tempDir);
      await manager.getInstalledBundles();

      // Should log error
      assert.ok(logErrorStub.called, 'Should log error for conflict');
      assert.ok(
        logErrorStub.firstCall.args[0].includes(conflictingBundleId),
        'Log message should contain the conflicting bundle ID'
      );
    });

    test('should handle multiple conflicts correctly', async () => {
      // Requirements: 3.4 - Handle multiple conflicts
      const mainLockfile = LockfileBuilder.create()
        .withSource('main-source', 'github', 'https://github.com/main/repo')
        .withBundle('conflict-1', '1.0.0', 'main-source')
        .withBundle('conflict-2', '1.0.0', 'main-source')
        .withBundle('main-only', '1.0.0', 'main-source')
        .build();
      writeLockfile(mainLockfile);

      const localLockfile = LockfileBuilder.create()
        .withSource('local-source', 'github', 'https://github.com/local/repo')
        .withBundle('conflict-1', '2.0.0', 'local-source')
        .withBundle('conflict-2', '2.0.0', 'local-source')
        .withBundle('local-only', '1.0.0', 'local-source')
        .build();
      writeLocalLockfile(localLockfile);

      const showErrorMessageStub = sandbox.stub(vscode.window, 'showErrorMessage');

      const manager = LockfileManager.getInstance(tempDir);
      const bundles = await manager.getInstalledBundles();

      // Should return 4 bundles: 3 from main + 1 unique from local
      assert.strictEqual(bundles.length, 4, 'Should return 4 bundles (3 main + 1 unique local)');

      // Should display error for each conflict
      assert.strictEqual(showErrorMessageStub.callCount, 2, 'Should display 2 error messages for 2 conflicts');
    });

    test('should preserve bundle metadata when merging', async () => {
      // Verify that all bundle properties are correctly preserved
      const mainLockfile = LockfileBuilder.create()
        .withSource('main-source', 'github', 'https://github.com/main/repo')
        .withBundle('main-bundle', '1.2.3', 'main-source', {
          sourceType: 'github',
          files: [createMockFileEntry('.github/prompts/test.prompt.md')]
        })
        .build();
      writeLockfile(mainLockfile);

      const manager = LockfileManager.getInstance(tempDir);
      const bundles = await manager.getInstalledBundles();

      assert.strictEqual(bundles.length, 1);
      assert.strictEqual(bundles[0].bundleId, 'main-bundle');
      assert.strictEqual(bundles[0].version, '1.2.3');
      assert.strictEqual(bundles[0].sourceId, 'main-source');
      assert.strictEqual(bundles[0].sourceType, 'github');
      assert.strictEqual(bundles[0].scope, 'repository');
    });
  });

  suite('Backward Compatibility - Legacy SourceId Format', () => {
    /**
     * Tests for backward compatibility with legacy hub-prefixed sourceId format.
     *
     * Legacy format: `hub-{hubId}-{sourceId}` (e.g., "hub-my-hub-github-source")
     * New format: `{sourceType}-{12-char-hash}` (e.g., "github-a1b2c3d4e5f6")
     *
     * Requirements covered:
     * - Requirement 3.1: Legacy sourceIds should resolve correctly
     * - Requirement 3.2: Bundle updates should write new sourceId format
     */

    test('should read lockfile with legacy hub-prefixed sourceId correctly', async () => {
      // Requirements: 3.1 - Legacy sourceIds should resolve correctly
      // Legacy format: hub-{hubId}-{sourceId}
      const legacySourceId = 'hub-my-hub-github-source';

      const lockfile = LockfileBuilder.create()
        .withSource(legacySourceId, 'github', 'https://github.com/owner/repo')
        .withBundle('test-bundle', '1.0.0', legacySourceId, {
          sourceType: 'github',
          files: [createMockFileEntry('.github/prompts/test.prompt.md')]
        })
        .build();
      writeLockfile(lockfile);

      const manager = LockfileManager.getInstance(tempDir);
      const bundles = await manager.getInstalledBundles();

      // Bundle should be read correctly with legacy sourceId
      assert.strictEqual(bundles.length, 1, 'Should read 1 bundle');
      assert.strictEqual(bundles[0].bundleId, 'test-bundle');
      assert.strictEqual(bundles[0].version, '1.0.0');
      assert.strictEqual(bundles[0].sourceId, legacySourceId, 'Legacy sourceId should be preserved');
      assert.strictEqual(bundles[0].sourceType, 'github');
    });

    test('should read lockfile with multiple legacy sourceIds correctly', async () => {
      // Requirements: 3.1 - Multiple legacy sourceIds should all resolve
      const legacySourceId1 = 'hub-test-hub-source1';
      const legacySourceId2 = 'hub-another-hub-local-source';

      const lockfile = LockfileBuilder.create()
        .withSource(legacySourceId1, 'github', 'https://github.com/owner/repo1')
        .withSource(legacySourceId2, 'local', '/path/to/project')
        .withBundle('bundle-1', '1.0.0', legacySourceId1, { sourceType: 'github' })
        .withBundle('bundle-2', '2.0.0', legacySourceId2, { sourceType: 'local' })
        .build();
      writeLockfile(lockfile);

      const manager = LockfileManager.getInstance(tempDir);
      const bundles = await manager.getInstalledBundles();

      assert.strictEqual(bundles.length, 2, 'Should read 2 bundles');

      const bundle1 = bundles.find((b) => b.bundleId === 'bundle-1');
      const bundle2 = bundles.find((b) => b.bundleId === 'bundle-2');

      assert.ok(bundle1, 'bundle-1 should exist');
      assert.strictEqual(bundle1.sourceId, legacySourceId1);

      assert.ok(bundle2, 'bundle-2 should exist');
      assert.strictEqual(bundle2.sourceId, legacySourceId2);
    });

    test('should read lockfile with mixed legacy and new sourceId formats', async () => {
      // Requirements: 3.1 - System should handle both formats in same lockfile
      const legacySourceId = 'hub-old-hub-github-source';
      const newSourceId = 'github-a1b2c3d4e5f6'; // New format: {type}-{hash}

      const lockfile = LockfileBuilder.create()
        .withSource(legacySourceId, 'github', 'https://github.com/owner/legacy-repo')
        .withSource(newSourceId, 'github', 'https://github.com/owner/new-repo')
        .withBundle('legacy-bundle', '1.0.0', legacySourceId, { sourceType: 'github' })
        .withBundle('new-bundle', '2.0.0', newSourceId, { sourceType: 'github' })
        .build();
      writeLockfile(lockfile);

      const manager = LockfileManager.getInstance(tempDir);
      const bundles = await manager.getInstalledBundles();

      assert.strictEqual(bundles.length, 2, 'Should read both bundles');

      const legacyBundle = bundles.find((b) => b.bundleId === 'legacy-bundle');
      const newBundle = bundles.find((b) => b.bundleId === 'new-bundle');

      assert.ok(legacyBundle, 'Legacy bundle should exist');
      assert.strictEqual(legacyBundle.sourceId, legacySourceId, 'Legacy sourceId preserved');

      assert.ok(newBundle, 'New bundle should exist');
      assert.strictEqual(newBundle.sourceId, newSourceId, 'New sourceId preserved');
    });

    test('should write new sourceId format when bundle is updated', async () => {
      // Requirements: 3.2 - Bundle update should write new sourceId format
      // When createOrUpdate is called with a new sourceId, it should be written
      const newSourceId = 'github-b5c6d7e8';

      // Start with a lockfile containing a legacy sourceId
      const legacySourceId = 'hub-my-hub-old-source';
      const lockfile = LockfileBuilder.create()
        .withSource(legacySourceId, 'github', 'https://github.com/owner/repo')
        .withBundle('test-bundle', '1.0.0', legacySourceId, { sourceType: 'github' })
        .build();
      writeLockfile(lockfile);

      const manager = LockfileManager.getInstance(tempDir);

      // Update the bundle with new sourceId format
      const updateOptions: CreateOrUpdateOptions = {
        bundleId: 'test-bundle',
        version: '2.0.0',
        sourceId: newSourceId,
        sourceType: 'github',
        commitMode: 'commit',
        files: [createMockFileEntry('.github/prompts/test.prompt.md')],
        source: createMockSourceEntry('github', 'https://github.com/owner/repo')
      };

      await manager.createOrUpdate(updateOptions);

      // Read the lockfile from disk to verify the new format was written
      const updatedLockfile = readLockfileFromDisk();
      assert.ok(updatedLockfile, 'Lockfile should exist');

      // Bundle should have new sourceId
      assert.strictEqual(
        updatedLockfile.bundles['test-bundle'].sourceId,
        newSourceId,
        'Bundle should have new sourceId format'
      );

      // New source entry should exist
      assert.ok(
        updatedLockfile.sources[newSourceId],
        'New source entry should exist'
      );

      // Note: Legacy source is NOT automatically cleaned up on update.
      // Source cleanup only happens when bundles are removed (orphan cleanup).
      // This is expected behavior - the legacy source remains until no bundles reference it.
      // The important thing is that the bundle now uses the new sourceId format.
    });

    test('should preserve legacy sourceId when bundle is not updated', async () => {
      // Requirements: 3.1 - Legacy sourceIds should continue to work without migration
      const legacySourceId = 'hub-preserved-hub-source';

      const lockfile = LockfileBuilder.create()
        .withSource(legacySourceId, 'github', 'https://github.com/owner/repo')
        .withBundle('preserved-bundle', '1.0.0', legacySourceId, { sourceType: 'github' })
        .build();
      writeLockfile(lockfile);

      const manager = LockfileManager.getInstance(tempDir);

      // Add a different bundle (not updating the existing one)
      const newSourceId = 'github-newbundle';
      const addOptions: CreateOrUpdateOptions = {
        bundleId: 'new-bundle',
        version: '1.0.0',
        sourceId: newSourceId,
        sourceType: 'github',
        commitMode: 'commit',
        files: [createMockFileEntry('.github/prompts/new.prompt.md')],
        source: createMockSourceEntry('github', 'https://github.com/owner/new-repo')
      };

      await manager.createOrUpdate(addOptions);

      // Read the lockfile from disk
      const updatedLockfile = readLockfileFromDisk();
      assert.ok(updatedLockfile, 'Lockfile should exist');

      // Original bundle should still have legacy sourceId
      assert.strictEqual(
        updatedLockfile.bundles['preserved-bundle'].sourceId,
        legacySourceId,
        'Legacy sourceId should be preserved for unchanged bundle'
      );

      // Legacy source should still exist
      assert.ok(
        updatedLockfile.sources[legacySourceId],
        'Legacy source should still exist'
      );

      // New bundle should have new sourceId
      assert.strictEqual(
        updatedLockfile.bundles['new-bundle'].sourceId,
        newSourceId,
        'New bundle should have new sourceId'
      );
    });

    test('should handle legacy sourceId with many segments correctly', async () => {
      // Requirements: 3.1 - Legacy format can have 3+ segments
      // Example: hub-my-hub-github-enterprise-source (5 segments)
      const legacySourceId = 'hub-my-hub-github-enterprise-source';

      const lockfile = LockfileBuilder.create()
        .withSource(legacySourceId, 'github', 'https://github.enterprise.com/owner/repo')
        .withBundle('enterprise-bundle', '1.0.0', legacySourceId, { sourceType: 'github' })
        .build();
      writeLockfile(lockfile);

      const manager = LockfileManager.getInstance(tempDir);
      const bundles = await manager.getInstalledBundles();

      assert.strictEqual(bundles.length, 1, 'Should read 1 bundle');
      assert.strictEqual(bundles[0].sourceId, legacySourceId, 'Multi-segment legacy sourceId preserved');
    });
  });
});
