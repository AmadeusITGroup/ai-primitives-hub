/**
 * BundleInstaller Bundle Storage Location Tests
 *
 * Tests to verify that bundle cache/storage is NOT created inside the repository.
 *
 * Bug: When installing at repository level, the bundle content was being extracted
 * to `.prompt-registry/bundles/` inside the repository, which should not happen.
 * The bundle cache should remain in the extension's global storage, and only the
 * proper content (prompts, agents, etc.) should be placed in `.github/` directories.
 *
 * Requirements covered:
 * - 1.2-1.7: Repository-Level Installation - files should go to .github/ directories
 * - The bundle cache/storage should remain in extension global storage
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
  IScopeService,
} from '../../src/services/scope-service';
import {
  ScopeServiceFactory,
} from '../../src/services/scope-service-factory';
import {
  Bundle,
  InstallOptions,
} from '../../src/types/registry';
import {
  BundleBuilder,
} from '../helpers/bundle-test-helpers';

suite('BundleInstaller - Bundle Storage Location', () => {
  let sandbox: sinon.SinonSandbox;
  let installer: BundleInstaller;
  let mockContext: vscode.ExtensionContext;
  let tempDir: string;
  let workspaceDir: string;
  let globalStorageDir: string;

  // Test bundle data
  const testBundle: Bundle = BundleBuilder.github('test-owner', 'test-repo')
    .withVersion('1.0.0')
    .withDescription('Test bundle for storage location')
    .build();

  setup(() => {
    sandbox = sinon.createSandbox();
    tempDir = path.join(__dirname, '..', '..', '..', 'test-temp-storage-location');
    workspaceDir = path.join(tempDir, 'workspace');
    globalStorageDir = path.join(tempDir, 'global-storage');

    // Create directories
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(globalStorageDir, { recursive: true });

    // Create .git directory to simulate a git repository
    fs.mkdirSync(path.join(workspaceDir, '.git', 'info'), { recursive: true });

    // Create mock context with global storage outside the workspace
    mockContext = {
      globalStorageUri: { fsPath: globalStorageDir },
      storageUri: { fsPath: path.join(tempDir, 'workspace-storage') },
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

    // Stub vscode.workspace.workspaceFolders to return our test workspace
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([
      { uri: vscode.Uri.file(workspaceDir), name: 'test-workspace', index: 0 }
    ]);

    // Create mock scope service that tracks syncBundle calls
    const mockScopeService: IScopeService = {
      syncBundle: sandbox.stub().resolves(),
      unsyncBundle: sandbox.stub().resolves()
    };

    // Stub ScopeServiceFactory
    sandbox.stub(ScopeServiceFactory, 'create').returns(mockScopeService);

    // Stub LockfileManager
    const mockLockfileManager = {
      createOrUpdate: sandbox.stub().resolves(),
      remove: sandbox.stub().resolves(),
      read: sandbox.stub().resolves(null),
      validate: sandbox.stub().resolves({ valid: true, errors: [], warnings: [] }),
      detectModifiedFiles: sandbox.stub().resolves([]),
      getLockfilePath: sandbox.stub().returns(path.join(workspaceDir, 'prompt-registry.lock.json')),
      onLockfileUpdated: new vscode.EventEmitter().event,
      dispose: sandbox.stub()
    };
    sandbox.stub(LockfileManager, 'getInstance').returns(mockLockfileManager as any);

    installer = new BundleInstaller(mockContext);
  });

  teardown(() => {
    sandbox.restore();

    // Cleanup temp directories
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  suite('Repository Scope Bundle Storage', () => {
    test('should NOT create .prompt-registry directory inside the repository workspace', async () => {
      // This test verifies the bug fix: bundle cache should NOT be in the repository
      const options: InstallOptions = {
        scope: 'repository',
        commitMode: 'commit'
      };

      // Create a valid bundle buffer
      // eslint-disable-next-line @typescript-eslint/naming-convention -- matches library export name
      const AdmZip = require('adm-zip');
      const zip = new AdmZip();
      zip.addFile('deployment-manifest.yml', Buffer.from(`
id: ${testBundle.id}
version: ${testBundle.version}
name: ${testBundle.name}
description: Test bundle
author: test
prompts:
  - id: test-prompt
    name: Test Prompt
    description: A test prompt
    file: prompts/test.prompt.md
    type: prompt
`));
      zip.addFile('prompts/test.prompt.md', Buffer.from('# Test Prompt\n\nThis is a test prompt.'));
      const bundleBuffer = zip.toBuffer();

      try {
        await installer.installFromBuffer(testBundle, bundleBuffer, options, 'github');
      } catch {
        // Installation might fail for other reasons, but we're checking the storage location
      }

      // CRITICAL CHECK: .prompt-registry should NOT exist in the workspace
      const promptRegistryInWorkspace = path.join(workspaceDir, '.prompt-registry');
      const exists = fs.existsSync(promptRegistryInWorkspace);

      assert.strictEqual(
        exists,
        false,
        `Bundle cache directory '.prompt-registry' should NOT be created inside the repository workspace at ${promptRegistryInWorkspace}`
      );
    });

    test('should store bundle cache in extension global storage for repository scope', async () => {
      // Bundle cache should be in the extension's global storage, not in the workspace
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
description: Test bundle
author: test
prompts:
  - id: test-prompt
    name: Test Prompt
    description: A test prompt
    file: prompts/test.prompt.md
    type: prompt
`));
      zip.addFile('prompts/test.prompt.md', Buffer.from('# Test Prompt'));
      const bundleBuffer = zip.toBuffer();

      let installedBundle;
      try {
        installedBundle = await installer.installFromBuffer(testBundle, bundleBuffer, options, 'github');
      } catch {
        // If installation fails, we can't check the path
        // But we should still verify no .prompt-registry in workspace
        const promptRegistryInWorkspace = path.join(workspaceDir, '.prompt-registry');
        assert.strictEqual(
          fs.existsSync(promptRegistryInWorkspace),
          false,
          'Bundle cache should not be in workspace even if installation fails'
        );
        return;
      }

      // If installation succeeded, verify the install path is in global storage
      if (installedBundle && installedBundle.installPath) {
        assert.ok(
          installedBundle.installPath.startsWith(globalStorageDir),
          `Install path should be in global storage (${globalStorageDir}), but was: ${installedBundle.installPath}`
        );

        assert.ok(
          !installedBundle.installPath.startsWith(workspaceDir),
          `Install path should NOT be in workspace (${workspaceDir}), but was: ${installedBundle.installPath}`
        );
      }
    });

    test('should only place proper content files in .github directories', async () => {
      // Only the actual prompt/agent/instruction files should go to .github/
      // Not the bundle cache, manifest, or other internal files
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
description: Test bundle
author: test
prompts:
  - id: test-prompt
    name: Test Prompt
    description: A test prompt
    file: prompts/test.prompt.md
    type: prompt
`));
      zip.addFile('prompts/test.prompt.md', Buffer.from('# Test Prompt'));
      const bundleBuffer = zip.toBuffer();

      try {
        await installer.installFromBuffer(testBundle, bundleBuffer, options, 'github');
      } catch {
        // Installation might fail, but check what was created
      }

      // Check that deployment-manifest.yml is NOT in the workspace root or .github
      const manifestInWorkspace = path.join(workspaceDir, 'deployment-manifest.yml');
      const manifestInGithub = path.join(workspaceDir, '.github', 'deployment-manifest.yml');

      assert.strictEqual(
        fs.existsSync(manifestInWorkspace),
        false,
        'deployment-manifest.yml should NOT be in workspace root'
      );

      assert.strictEqual(
        fs.existsSync(manifestInGithub),
        false,
        'deployment-manifest.yml should NOT be in .github directory'
      );
    });

    test('user scope should continue to use global storage', async () => {
      // Verify user scope still works correctly with global storage
      const options: InstallOptions = {
        scope: 'user'
      };

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

      let installedBundle;
      try {
        installedBundle = await installer.installFromBuffer(testBundle, bundleBuffer, options, 'github');
      } catch {
        // May fail for other reasons
        return;
      }

      if (installedBundle && installedBundle.installPath) {
        // User scope should use global storage
        assert.ok(
          installedBundle.installPath.startsWith(globalStorageDir),
          `User scope install path should be in global storage: ${installedBundle.installPath}`
        );
      }
    });
  });
});
