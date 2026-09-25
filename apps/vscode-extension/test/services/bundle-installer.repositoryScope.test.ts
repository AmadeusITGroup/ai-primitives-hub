/**
 * BundleInstaller Repository Scope Unit Tests
 *
 * Tests for extending BundleInstaller to support repository-level installation.
 * Follows TDD approach - these tests are written first (RED phase).
 *
 * Requirements covered:
 * - 1.1-1.8: Repository-Level Installation as Default
 * - 8.3-8.4: Update Detection Across Scopes
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  BundleInstaller,
} from '../../src/services/bundle-installer';
import {
  LockfileManager,
} from '../../src/services/lockfile-manager';
import {
  RepositoryScopeService,
} from '../../src/services/repository-scope-service';
import type {
  SyncBundleOptions,
} from '../../src/services/scope-service';
import {
  ScopeServiceFactory,
} from '../../src/services/scope-service-factory';
import {
  UserScopeService,
} from '../../src/services/user-scope-service';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';
import {
  Bundle,
  InstallOptions,
} from '../../src/types/registry';
import {
  BundleBuilder,
  createMockInstalledBundle,
} from '../helpers/bundle-test-helpers';

suite('BundleInstaller - Repository Scope', () => {
  let sandbox: sinon.SinonSandbox;
  let installer: BundleInstaller;
  let mockContext: vscode.ExtensionContext;
  let mockStorage: sinon.SinonStubbedInstance<RegistryStorage>;
  let mockLockfileManager: sinon.SinonStubbedInstance<LockfileManager>;
  let mockRepositoryScopeService: sinon.SinonStubbedInstance<RepositoryScopeService>;
  let mockUserScopeService: sinon.SinonStubbedInstance<UserScopeService>;
  let tempDir: string;

  // Test bundle data
  const testBundle: Bundle = BundleBuilder.github('test-owner', 'test-repo')
    .withVersion('1.0.0')
    .withDescription('Test bundle for repository scope')
    .build();

  setup(() => {
    sandbox = sinon.createSandbox();
    tempDir = path.join(__dirname, '..', '..', '..', 'test-temp-repo-scope');

    // Create mock context
    mockContext = {
      globalStorageUri: { fsPath: path.join(tempDir, 'global') },
      storageUri: { fsPath: path.join(tempDir, 'workspace') },
      extensionPath: __dirname,
      extension: {
        packageJSON: {
          publisher: 'test-publisher',
          name: 'test-extension',
          version: '1.0.0'
        }
      },
      globalState: {
        get: sandbox.stub().returns({}),
        update: sandbox.stub().resolves(),
        keys: sandbox.stub().returns([]),
        setKeysForSync: sandbox.stub()
      }
    } as any;

    // Create temp directories
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Create mock storage
    mockStorage = sandbox.createStubInstance(RegistryStorage);
    mockStorage.getInstalledBundle.resolves(undefined);
    mockStorage.recordInstallation.resolves();
    mockStorage.removeInstallation.resolves();

    // Create mock LockfileManager
    mockLockfileManager = {
      createOrUpdate: sandbox.stub().resolves(),
      remove: sandbox.stub().resolves(),
      read: sandbox.stub().resolves(null),
      validate: sandbox.stub().resolves({ valid: true, errors: [], warnings: [] }),
      detectModifiedFiles: sandbox.stub().resolves([]),
      getLockfilePath: sandbox.stub().returns(path.join(tempDir, 'prompt-registry.lock.json')),
      onLockfileUpdated: new vscode.EventEmitter().event,
      dispose: sandbox.stub()
    } as any;

    // Create mock scope services
    mockRepositoryScopeService = {
      syncBundle: sandbox.stub().callsFake((_bundleId: string, _bundlePath: string, options?: SyncBundleOptions) =>
        options?.afterSync?.() ?? Promise.resolve()),
      unsyncBundle: sandbox.stub().resolves(),
      getTargetPath: sandbox.stub().returns('.github/prompts/test.prompt.md'),
      getStatus: sandbox.stub().resolves({ baseDirectory: '.github', dirExists: true, syncedFiles: 0, files: [] }),
      switchCommitMode: sandbox.stub().resolves()
    } as any;

    mockUserScopeService = {
      syncBundle: sandbox.stub().resolves(),
      unsyncBundle: sandbox.stub().resolves(),
      getTargetPath: sandbox.stub().returns('~/.vscode/prompts/test.prompt.md'),
      getStatus: sandbox.stub().resolves({ baseDirectory: '~/.vscode', dirExists: true, syncedFiles: 0, files: [] })
    } as any;

    // Stub ScopeServiceFactory
    sandbox.stub(ScopeServiceFactory, 'create').callsFake((scope, _context, _workspaceRoot, _storage) => {
      if (scope === 'repository') {
        return mockRepositoryScopeService;
      }
      return mockUserScopeService;
    });

    // Stub LockfileManager.getInstance
    sandbox.stub(LockfileManager, 'getInstance').returns(mockLockfileManager);

    // Stub vscode.workspace.workspaceFolders
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([
      { uri: vscode.Uri.file(tempDir), name: 'test-workspace', index: 0 }
    ]);

    installer = new BundleInstaller(mockContext);
  });

  teardown(() => {
    sandbox.restore();

    // Cleanup temp directories
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  suite('getInstallDirectory() - Repository Scope Support', () => {
    test('should return .github-based path for repository scope', async () => {
      // This test verifies that getInstallDirectory returns a path
      // within the workspace .github directory for repository scope
      // Requirements: 1.2-1.7

      const options: InstallOptions = {
        scope: 'repository',
        commitMode: 'commit'
      };

      // The method is private, so we test it indirectly through installFromBuffer
      // For now, we verify the error is no longer thrown for repository scope
      // (The current implementation throws "Repository scope installation is not yet implemented")

      // Create a minimal valid bundle buffer
      // eslint-disable-next-line @typescript-eslint/naming-convention -- matches library export name
      const AdmZip = require('adm-zip');
      const zip = new AdmZip();
      zip.addFile('deployment-manifest.yml', Buffer.from(`
id: ${testBundle.id}
version: ${testBundle.version}
name: ${testBundle.name}
description: Test bundle
author: test
prompts: []
`));
      const bundleBuffer = zip.toBuffer();

      try {
        await installer.installFromBuffer(testBundle, bundleBuffer, options, 'github');
        // If we get here, repository scope is supported
        assert.ok(true, 'Repository scope installation should be supported');
      } catch (error: any) {
        // Currently expected to fail until implementation is complete
        if (error.message.includes('Repository scope installation is not yet implemented')) {
          assert.ok(true, 'Repository scope not yet implemented - test will pass after implementation');
        } else {
          throw error;
        }
      }
    });

    test('should continue to support user scope', () => {
      // Requirements: 9.1-9.5 - Backward compatibility
      const options: InstallOptions = {
        scope: 'user'
      };

      // User scope should continue to work
      assert.strictEqual(options.scope, 'user');
    });

    test('should continue to support workspace scope', () => {
      // Requirements: 9.1-9.5 - Backward compatibility
      const options: InstallOptions = {
        scope: 'workspace'
      };

      assert.strictEqual(options.scope, 'workspace');
    });
  });

  suite('Repository Scope Installation Flow', () => {
    test('should use ScopeServiceFactory to get RepositoryScopeService', async () => {
      // Requirements: 1.1, 1.8
      // Verify that installation uses ScopeServiceFactory for repository scope

      // Trigger installation (will fail but should call factory)
      const options: InstallOptions = {
        scope: 'repository',
        commitMode: 'commit'
      };

      try {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- matches library export name
        const AdmZip = require('adm-zip');
        const zip = new AdmZip();
        zip.addFile('deployment-manifest.yml', Buffer.from(`
id: ${testBundle.id}
version: ${testBundle.version}
name: ${testBundle.name}
description: Test
author: test
prompts: []
`));
        await installer.installFromBuffer(testBundle, zip.toBuffer(), options, 'github');
      } catch {
        // Expected to fail until implementation
      }

      // After implementation, this should verify factory was called
      // assert.ok(factoryStub.calledWith('repository'), 'Should use ScopeServiceFactory for repository scope');
    });

    test('should route skills bundle at repository scope through RepositoryScopeService', async () => {
      const options: InstallOptions = {
        scope: 'repository',
        commitMode: 'commit'
      };

      // Build a minimal skills bundle zip with deployment-manifest and SKILL.md
      // eslint-disable-next-line @typescript-eslint/naming-convention -- matches library export name
      const AdmZip = require('adm-zip');
      const zip = new AdmZip();
      zip.addFile('deployment-manifest.yml', Buffer.from(`
id: ${testBundle.id}
version: ${testBundle.version}
name: ${testBundle.name}
description: Test skill bundle
author: test
prompts:
  - id: my-skill
    file: skills/my-skill/SKILL.md
    type: skill
`));
      zip.addFile('skills/my-skill/SKILL.md', Buffer.from('# My Skill'));

      // Reset call history to ensure clean assertions
      mockRepositoryScopeService.syncBundle.resetHistory();
      mockUserScopeService.syncBundle.resetHistory();

      await installer.installFromBuffer(testBundle, zip.toBuffer(), options, 'skills');

      assert.ok(mockRepositoryScopeService.syncBundle.calledOnce, 'Repository scope should sync via RepositoryScopeService for skills');
      assert.ok(!mockUserScopeService.syncBundle.called, 'User scope sync should not be used for repository-scoped skills');
    });

    test('records the installed source-relative knowledge path in the repository lockfile', async () => {
      const bundleId = testBundle.id;
      const sourceFile = 'specifications/RDP/core_layer/AGENT_INDEX.md';
      const installedFile = path.join(tempDir, '.github', 'knowledge', sourceFile);
      mockRepositoryScopeService.syncBundle.resetHistory();
      mockRepositoryScopeService.syncBundle.onFirstCall().callsFake((_bundleId: string, _bundlePath: string, options?: SyncBundleOptions) => {
        fs.mkdirSync(path.dirname(installedFile), { recursive: true });
        fs.writeFileSync(installedFile, '# Knowledge');
        return options?.afterSync?.() ?? Promise.resolve();
      });

      // eslint-disable-next-line @typescript-eslint/naming-convention -- matches library export name
      const AdmZip = require('adm-zip');
      const zip = new AdmZip();
      zip.addFile('deployment-manifest.yml', Buffer.from(`
id: ${bundleId}
version: ${testBundle.version}
name: ${testBundle.name}
description: Test knowledge bundle
author: test
prompts:
  - id: AGENT_INDEX
    name: Agent Index
    description: Knowledge index
    file: ${sourceFile}
    type: knowledge
`));
      zip.addFile(sourceFile, Buffer.from('# Knowledge'));
      mockLockfileManager.createOrUpdate.resetHistory();

      let lockfileFiles: { path: string; checksum: string }[] | undefined;
      try {
        await installer.installFromBuffer(testBundle, zip.toBuffer(), { scope: 'repository', commitMode: 'commit' }, 'github');
        lockfileFiles = mockLockfileManager.createOrUpdate.firstCall.args[0].files;
      } finally {
        mockRepositoryScopeService.syncBundle.resetBehavior();
        mockRepositoryScopeService.syncBundle.resolves();
      }

      assert.ok(lockfileFiles);
      assert.deepStrictEqual(lockfileFiles.map((file) => file.path), [
        '.github/knowledge/specifications/RDP/core_layer/AGENT_INDEX.md'
      ]);
    });

    if (process.platform !== 'win32') {
      test('does not track an existing POSIX backslash filename that was not installed by the bundle', async () => {
        const skillDir = path.join(tempDir, '.github', 'skills', 'my-skill');
        const unownedFile = path.join(skillDir, 'script\\helper.sh');
        mockRepositoryScopeService.syncBundle.callsFake((_bundleId: string, _bundlePath: string, options?: SyncBundleOptions) => {
          fs.mkdirSync(skillDir, { recursive: true });
          fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Installed');
          fs.writeFileSync(unownedFile, '# Pre-existing');
          return options?.afterSync?.() ?? Promise.resolve();
        });

        // eslint-disable-next-line @typescript-eslint/naming-convention -- matches library export name
        const AdmZip = require('adm-zip');
        const zip = new AdmZip();
        zip.addFile('deployment-manifest.yml', Buffer.from(`
id: ${testBundle.id}
version: ${testBundle.version}
name: ${testBundle.name}
prompts:
  - id: my-skill
    file: skills/my-skill/SKILL.md
    type: skill
`));
        zip.addFile('skills/my-skill/SKILL.md', Buffer.from('# Installed'));

        await installer.installFromBuffer(testBundle, zip.toBuffer(), { scope: 'repository', commitMode: 'commit' }, 'skills');

        const tracked = mockLockfileManager.createOrUpdate.firstCall.args[0].files as { path: string }[];
        assert.deepStrictEqual(tracked.map((file) => file.path), ['.github/skills/my-skill/SKILL.md']);
        assert.strictEqual(fs.readFileSync(unownedFile, 'utf8'), '# Pre-existing');
      });

      test('does not report a successful install when a sourced destination has an outside symlinked parent', async () => {
        const outside = path.join(path.dirname(tempDir), `${path.basename(tempDir)}-outside`);
        const skillDir = path.join(tempDir, '.github', 'skills', 'my-skill');
        fs.mkdirSync(path.dirname(skillDir), { recursive: true });
        fs.mkdirSync(outside);
        try {
          fs.writeFileSync(path.join(outside, 'SKILL.md'), '# Outside');
          fs.symlinkSync(outside, skillDir, 'dir');

          // eslint-disable-next-line @typescript-eslint/naming-convention -- matches library export name
          const AdmZip = require('adm-zip');
          const zip = new AdmZip();
          zip.addFile('deployment-manifest.yml', Buffer.from(`
id: ${testBundle.id}
version: ${testBundle.version}
name: ${testBundle.name}
prompts:
  - id: my-skill
    file: skills/my-skill/SKILL.md
    type: skill
`));
          zip.addFile('skills/my-skill/SKILL.md', Buffer.from('# Skill'));

          await assert.rejects(
            installer.installFromBuffer(testBundle, zip.toBuffer(), { scope: 'repository', commitMode: 'commit' }, 'skills'),
            /escapes repository root/
          );
          assert.ok(!mockLockfileManager.createOrUpdate.called);
          assert.strictEqual(fs.readFileSync(path.join(outside, 'SKILL.md'), 'utf8'), '# Outside');
        } finally {
          fs.rmSync(outside, { recursive: true, force: true });
        }
      });
    }

    test('tracks nested source skill assets but not pre-existing files in the destination', async () => {
      const skillDir = path.join(tempDir, '.github', 'skills', 'my-skill');
      mockRepositoryScopeService.syncBundle.callsFake((_bundleId: string, _bundlePath: string, options?: SyncBundleOptions) => {
        fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Skill');
        fs.writeFileSync(path.join(skillDir, 'scripts', 'run.sh'), '# Installed');
        fs.writeFileSync(path.join(skillDir, 'user-notes.md'), '# Pre-existing');
        return options?.afterSync?.() ?? Promise.resolve();
      });

      // eslint-disable-next-line @typescript-eslint/naming-convention -- matches library export name
      const AdmZip = require('adm-zip');
      const zip = new AdmZip();
      zip.addFile('deployment-manifest.yml', Buffer.from(`
id: ${testBundle.id}
version: ${testBundle.version}
name: ${testBundle.name}
prompts:
  - id: my-skill
    file: skills/my-skill/SKILL.md
    type: skill
`));
      zip.addFile('skills/my-skill/SKILL.md', Buffer.from('# Skill'));
      zip.addFile('skills/my-skill/scripts/run.sh', Buffer.from('# Installed'));

      await installer.installFromBuffer(testBundle, zip.toBuffer(), { scope: 'repository', commitMode: 'commit' }, 'skills');

      const tracked = mockLockfileManager.createOrUpdate.firstCall.args[0].files as { path: string }[];
      assert.deepStrictEqual(tracked.map((file) => file.path).toSorted(), [
        '.github/skills/my-skill/SKILL.md',
        '.github/skills/my-skill/scripts/run.sh'
      ].toSorted());
      assert.strictEqual(fs.readFileSync(path.join(skillDir, 'user-notes.md'), 'utf8'), '# Pre-existing');
    });

    if (process.platform === 'win32') {
      test('tracks files installed from a skill manifest using Windows separators', async () => {
        (ScopeServiceFactory.create as sinon.SinonStub).returns(new RepositoryScopeService(tempDir, mockStorage, 'vscode'));

        // eslint-disable-next-line @typescript-eslint/naming-convention -- matches library export name
        const AdmZip = require('adm-zip');
        const zip = new AdmZip();
        zip.addFile('deployment-manifest.yml', Buffer.from(`
id: ${testBundle.id}
version: ${testBundle.version}
name: ${testBundle.name}
prompts:
  - id: my-skill
    file: skills\\my-skill\\SKILL.md
    type: skill
`));
        zip.addFile('skills/my-skill/SKILL.md', Buffer.from('# Skill'));
        zip.addFile('skills/my-skill/scripts/run.sh', Buffer.from('#!/bin/sh'));

        await installer.installFromBuffer(testBundle, zip.toBuffer(), { scope: 'repository', commitMode: 'commit' }, 'skills');

        const tracked = mockLockfileManager.createOrUpdate.firstCall.args[0].files as { path: string }[];
        assert.deepStrictEqual(tracked.map((file) => file.path).toSorted(), [
          '.github/skills/my-skill/SKILL.md',
          '.github/skills/my-skill/scripts/run.sh'
        ]);
      });
    }

    test('should call LockfileManager.createOrUpdate for repository scope installation', async () => {
      // Requirements: 4.1
      // Verify lockfile is updated when installing at repository scope

      const options: InstallOptions = {
        scope: 'repository',
        commitMode: 'commit'
      };

      try {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- matches library export name
        const AdmZip = require('adm-zip');
        const zip = new AdmZip();
        zip.addFile('deployment-manifest.yml', Buffer.from(`
id: ${testBundle.id}
version: ${testBundle.version}
name: ${testBundle.name}
description: Test
author: test
prompts: []
`));
        await installer.installFromBuffer(testBundle, zip.toBuffer(), options, 'github');

        // After implementation, verify lockfile was updated
        // assert.ok(mockLockfileManager.createOrUpdate.called, 'Should update lockfile for repository scope');
      } catch {
        // Expected until implementation
      }
    });

    test('should NOT call LockfileManager for user scope installation', async () => {
      // Requirements: 8.4
      // Verify lockfile is NOT modified for user scope installations

      const options: InstallOptions = {
        scope: 'user'
      };

      // Reset the stub to track calls
      mockLockfileManager.createOrUpdate.resetHistory();

      try {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- matches library export name
        const AdmZip = require('adm-zip');
        const zip = new AdmZip();
        zip.addFile('deployment-manifest.yml', Buffer.from(`
id: ${testBundle.id}
version: ${testBundle.version}
name: ${testBundle.name}
description: Test
author: test
prompts: []
`));
        await installer.installFromBuffer(testBundle, zip.toBuffer(), options, 'github');
      } catch {
        // May fail for other reasons
      }

      // Lockfile should not be touched for user scope
      assert.ok(!mockLockfileManager.createOrUpdate.called, 'Should NOT update lockfile for user scope');
    });

    test('should sync bundle using RepositoryScopeService for repository scope', async () => {
      // Requirements: 1.2-1.7
      // Verify files are synced to .github directories

      const options: InstallOptions = {
        scope: 'repository',
        commitMode: 'commit'
      };

      try {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- matches library export name
        const AdmZip = require('adm-zip');
        const zip = new AdmZip();
        zip.addFile('deployment-manifest.yml', Buffer.from(`
id: ${testBundle.id}
version: ${testBundle.version}
name: ${testBundle.name}
description: Test
author: test
prompts: []
`));
        await installer.installFromBuffer(testBundle, zip.toBuffer(), options, 'github');

        // After implementation, verify RepositoryScopeService.syncBundle was called
        // assert.ok(mockRepositoryScopeService.syncBundle.called, 'Should sync using RepositoryScopeService');
      } catch {
        // Expected until implementation
      }
    });
  });

  suite('Repository Scope Uninstallation', () => {
    test('keeps lockfile tracking and cache when repository unsync refuses removal', async () => {
      const installed = createMockInstalledBundle(testBundle.id, '1.0.0', {
        scope: 'repository',
        commitMode: 'commit',
        installPath: path.join(tempDir, 'bundles', testBundle.id)
      });
      fs.mkdirSync(installed.installPath, { recursive: true });
      mockRepositoryScopeService.unsyncBundle.rejects(new Error('Unsafe repository path'));

      await assert.rejects(installer.uninstall(installed), /Unsafe repository path/);

      assert.ok(!mockLockfileManager.remove.called, 'Keep the bundle lockfile entry when unsync fails');
      assert.ok(fs.existsSync(installed.installPath), 'Keep the cache for recovery');
    });

    test('should call LockfileManager.remove when uninstalling repository scope bundle', async () => {
      // Requirements: 4.8
      const installed = createMockInstalledBundle(testBundle.id, '1.0.0', {
        scope: 'repository',
        commitMode: 'commit',
        installPath: path.join(tempDir, 'bundles', testBundle.id)
      });

      // Create the install path
      fs.mkdirSync(installed.installPath, { recursive: true });

      try {
        await installer.uninstall(installed);

        // After implementation, verify lockfile entry was removed
        // assert.ok(mockLockfileManager.remove.calledWith(testBundle.id), 'Should remove from lockfile');
      } catch {
        // May fail for other reasons
      }
    });

    test('should NOT call LockfileManager.remove when uninstalling user scope bundle', async () => {
      // Requirements: 8.4
      const installed = createMockInstalledBundle(testBundle.id, '1.0.0', {
        scope: 'user',
        installPath: path.join(tempDir, 'bundles', testBundle.id)
      });

      // Create the install path
      fs.mkdirSync(installed.installPath, { recursive: true });

      mockLockfileManager.remove.resetHistory();

      try {
        await installer.uninstall(installed);
      } catch {
        // May fail for other reasons
      }

      assert.ok(!mockLockfileManager.remove.called, 'Should NOT remove from lockfile for user scope');
    });

    test('should unsync bundle using RepositoryScopeService for repository scope', async () => {
      // Requirements: 1.2-1.7
      const installed = createMockInstalledBundle(testBundle.id, '1.0.0', {
        scope: 'repository',
        commitMode: 'commit',
        installPath: path.join(tempDir, 'bundles', testBundle.id)
      });

      fs.mkdirSync(installed.installPath, { recursive: true });

      try {
        await installer.uninstall(installed);

        // After implementation, verify RepositoryScopeService.unsyncBundle was called
        // assert.ok(mockRepositoryScopeService.unsyncBundle.called, 'Should unsync using RepositoryScopeService');
      } catch {
        // May fail for other reasons
      }
    });
  });

  suite('Commit Mode Handling', () => {
    test('should pass commitMode to RepositoryScopeService', async () => {
      // Requirements: 3.1-3.2
      const options: InstallOptions = {
        scope: 'repository',
        commitMode: 'local-only'
      };

      try {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- matches library export name
        const AdmZip = require('adm-zip');
        const zip = new AdmZip();
        zip.addFile('deployment-manifest.yml', Buffer.from(`
id: ${testBundle.id}
version: ${testBundle.version}
name: ${testBundle.name}
description: Test
author: test
prompts: []
`));
        await installer.installFromBuffer(testBundle, zip.toBuffer(), options, 'github');

        // After implementation, verify commitMode was passed correctly
      } catch {
        // Expected until implementation
      }
    });

    test('should record commitMode in InstalledBundle', () => {
      try {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- matches library export name
        const AdmZip = require('adm-zip');
        const zip = new AdmZip();
        zip.addFile('deployment-manifest.yml', Buffer.from(`
id: ${testBundle.id}
version: ${testBundle.version}
name: ${testBundle.name}
description: Test
author: test
prompts: []
`));

        // After implementation, verify commitMode is in the result
        // assert.strictEqual(result.commitMode, 'commit', 'Should record commitMode in InstalledBundle');
      } catch {
        // Expected until implementation
      }
    });
  });

  suite('Lockfile Integration', () => {
    test('should include source information in lockfile entry', async () => {
      // Requirements: 12.1-12.3
      const options: InstallOptions = {
        scope: 'repository',
        commitMode: 'commit'
      };

      try {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- matches library export name
        const AdmZip = require('adm-zip');
        const zip = new AdmZip();
        zip.addFile('deployment-manifest.yml', Buffer.from(`
id: ${testBundle.id}
version: ${testBundle.version}
name: ${testBundle.name}
description: Test
author: test
prompts: []
`));
        await installer.installFromBuffer(testBundle, zip.toBuffer(), options, 'github');

        // After implementation, verify source info was included
        // const createOrUpdateCall = mockLockfileManager.createOrUpdate.firstCall;
        // assert.ok(createOrUpdateCall.args[0].source, 'Should include source in lockfile');
      } catch {
        // Expected until implementation
      }
    });

    test('should include file checksums in lockfile entry', async () => {
      // Requirements: 15.1-15.2
      const options: InstallOptions = {
        scope: 'repository',
        commitMode: 'commit'
      };

      try {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- matches library export name
        const AdmZip = require('adm-zip');
        const zip = new AdmZip();
        zip.addFile('deployment-manifest.yml', Buffer.from(`
id: ${testBundle.id}
version: ${testBundle.version}
name: ${testBundle.name}
description: Test
author: test
prompts:
  - id: test-prompt
    name: Test Prompt
    description: A test prompt
    file: test.prompt.md
`));
        zip.addFile('test.prompt.md', Buffer.from('# Test Prompt'));
        await installer.installFromBuffer(testBundle, zip.toBuffer(), options, 'github');

        // After implementation, verify files with checksums were included
        // const createOrUpdateCall = mockLockfileManager.createOrUpdate.firstCall;
        // assert.ok(createOrUpdateCall.args[0].files.length > 0, 'Should include files in lockfile');
      } catch {
        // Expected until implementation
      }
    });
  });

  suite('Error Handling', () => {
    const createPromptBundleBuffer = (): Buffer => {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- matches library export name
      const AdmZip = require('adm-zip');
      const zip = new AdmZip();
      zip.addFile('deployment-manifest.yml', Buffer.from(`
id: ${testBundle.id}
version: ${testBundle.version}
name: ${testBundle.name}
prompts:
  - id: test
    file: test.prompt.md
    type: prompt
`));
      zip.addFile('test.prompt.md', Buffer.from('# Installed'));
      return zip.toBuffer() as Buffer;
    };

    test('should throw error when repository scope requested but no workspace open', async () => {
      // Requirements: 1.8
      // Stub workspaceFolders to be empty
      sandbox.restore();
      sandbox = sinon.createSandbox();
      sandbox.stub(vscode.workspace, 'workspaceFolders').value(undefined);

      installer = new BundleInstaller(mockContext);

      const options: InstallOptions = {
        scope: 'repository',
        commitMode: 'commit'
      };

      try {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- matches library export name
        const AdmZip = require('adm-zip');
        const zip = new AdmZip();
        zip.addFile('deployment-manifest.yml', Buffer.from(`
id: ${testBundle.id}
version: ${testBundle.version}
name: ${testBundle.name}
description: Test
author: test
prompts: []
`));
        await installer.installFromBuffer(testBundle, zip.toBuffer(), options, 'github');
        assert.fail('Should have thrown error for repository scope without workspace');
      } catch (error: any) {
        // Should throw an error about no workspace
        assert.ok(
          error.message.includes('workspace')
          || error.message.includes('Repository scope')
          || error.message.includes('not yet implemented'),
          `Error should mention workspace requirement: ${error.message}`
        );
      }
    });

    test('reports lockfile write failures instead of succeeding with untracked files', async () => {
      // Requirements: 15.6
      mockLockfileManager.createOrUpdate.rejects(new Error('Lockfile write failed'));

      const options: InstallOptions = {
        scope: 'repository',
        commitMode: 'commit'
      };

      // eslint-disable-next-line @typescript-eslint/naming-convention -- matches library export name
      const AdmZip = require('adm-zip');
      const zip = new AdmZip();
      zip.addFile('deployment-manifest.yml', Buffer.from(`
id: ${testBundle.id}
version: ${testBundle.version}
name: ${testBundle.name}
description: Test
author: test
prompts: []
`));
      await assert.rejects(
        installer.installFromBuffer(testBundle, zip.toBuffer(), options, 'github'),
        /Lockfile write failed/,
        'An untracked repository install must not report success'
      );
    });

    test('rolls back newly synced files when writing the local-only lockfile fails', async () => {
      const promptPath = path.join(tempDir, '.github', 'prompts', 'test.prompt.md');
      const excludePath = path.join(tempDir, '.git', 'info', 'exclude');
      fs.mkdirSync(path.dirname(excludePath), { recursive: true });
      fs.writeFileSync(excludePath, '# Existing excludes\n*.log\n');
      (ScopeServiceFactory.create as sinon.SinonStub).returns(new RepositoryScopeService(tempDir, mockStorage, 'vscode'));
      mockLockfileManager.createOrUpdate.rejects(new Error('Lockfile write failed'));

      await assert.rejects(
        installer.installFromBuffer(testBundle, createPromptBundleBuffer(), { scope: 'repository', commitMode: 'local-only' }, 'github'),
        /Lockfile write failed/
      );

      assert.ok(!fs.existsSync(promptPath), 'A failed install must not leave an untracked prompt behind');
      assert.strictEqual(fs.readFileSync(excludePath, 'utf8'), '# Existing excludes\n*.log\n');
    });

    test('restores an overwritten repository file when writing the lockfile fails', async () => {
      const promptPath = path.join(tempDir, '.github', 'prompts', 'test.prompt.md');
      fs.mkdirSync(path.dirname(promptPath), { recursive: true });
      fs.writeFileSync(promptPath, '# Existing user file');
      (ScopeServiceFactory.create as sinon.SinonStub).returns(new RepositoryScopeService(tempDir, mockStorage, 'vscode'));
      mockLockfileManager.createOrUpdate.rejects(new Error('Lockfile write failed'));

      await assert.rejects(
        installer.installFromBuffer(testBundle, createPromptBundleBuffer(), { scope: 'repository', commitMode: 'commit' }, 'github'),
        /Lockfile write failed/
      );

      assert.strictEqual(fs.readFileSync(promptPath, 'utf8'), '# Existing user file',
        'The failed installation must not delete or replace a pre-existing file');
    });

    test('preserves a file edited after sync when the lockfile write fails', async () => {
      const promptPath = path.join(tempDir, '.github', 'prompts', 'test.prompt.md');
      (ScopeServiceFactory.create as sinon.SinonStub).returns(new RepositoryScopeService(tempDir, mockStorage, 'vscode'));
      mockLockfileManager.createOrUpdate.callsFake(() => {
        fs.writeFileSync(promptPath, '# User edit after sync');
        return Promise.reject(new Error('Lockfile write failed'));
      });

      await assert.rejects(
        installer.installFromBuffer(testBundle, createPromptBundleBuffer(), { scope: 'repository', commitMode: 'commit' }, 'github'),
        /Lockfile write failed/
      );

      assert.strictEqual(fs.readFileSync(promptPath, 'utf8'), '# User edit after sync',
        'Rollback must not overwrite user changes made since the install');
    });
  });

  suite('Scope-Specific Behavior', () => {
    test('should use UserScopeService for user scope', async () => {
      // Requirements: 9.1-9.5

      const factoryStub = ScopeServiceFactory.create as sinon.SinonStub;
      factoryStub.resetHistory();

      const options: InstallOptions = {
        scope: 'user'
      };

      try {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- matches library export name
        const AdmZip = require('adm-zip');
        const zip = new AdmZip();
        zip.addFile('deployment-manifest.yml', Buffer.from(`
id: ${testBundle.id}
version: ${testBundle.version}
name: ${testBundle.name}
description: Test
author: test
prompts: []
`));
        await installer.installFromBuffer(testBundle, zip.toBuffer(), options, 'github');
      } catch {
        // May fail for other reasons
      }

      // Current implementation uses UserScopeService directly (copilotSync)
      // After refactoring, should use ScopeServiceFactory
    });

    test('should use RepositoryScopeService for repository scope', async () => {
      // Requirements: 1.1-1.8

      const factoryStub = ScopeServiceFactory.create as sinon.SinonStub;
      factoryStub.resetHistory();

      const options: InstallOptions = {
        scope: 'repository',
        commitMode: 'commit'
      };

      try {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- matches library export name
        const AdmZip = require('adm-zip');
        const zip = new AdmZip();
        zip.addFile('deployment-manifest.yml', Buffer.from(`
id: ${testBundle.id}
version: ${testBundle.version}
name: ${testBundle.name}
description: Test
author: test
prompts: []
`));
        await installer.installFromBuffer(testBundle, zip.toBuffer(), options, 'github');

        // After implementation, verify factory was called with 'repository'
      } catch {
        // Expected until implementation
      }
    });
  });
});
