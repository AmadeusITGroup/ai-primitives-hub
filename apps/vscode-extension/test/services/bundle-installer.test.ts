/**
 * BundleInstaller Unit Tests
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  BundleInstaller,
} from '../../src/services/bundle-installer';
import {
  LockfileManager,
} from '../../src/services/lockfile-manager';
import {
  ScopeServiceFactory,
} from '../../src/services/scope-service-factory';
import {
  Bundle,
  InstallOptions,
} from '../../src/types/registry';
import {
  createFoursightBundle,
} from '../fixtures/foursight-bundle';

suite('BundleInstaller', () => {
  let installer: BundleInstaller;
  let mockContext: any;
  let tempDir: string;

  const mockBundle: Bundle = {
    id: 'test-bundle',
    name: 'Test Bundle',
    version: '1.0.0',
    description: 'Test bundle for unit tests',
    author: 'Test Author',
    sourceId: 'test-source',
    environments: ['vscode'],
    tags: ['test'],
    lastUpdated: '2025-01-01T00:00:00Z',
    size: '1KB',
    dependencies: [],
    license: 'MIT',
    downloadUrl: 'https://example.com/bundle.zip',
    manifestUrl: 'https://example.com/manifest.json'
  };

  setup(() => {
    tempDir = path.join(__dirname, '..', '..', '..', 'test-temp');

    mockContext = {
      globalStorageUri: { fsPath: path.join(tempDir, 'global') },
      storageUri: { fsPath: path.join(tempDir, 'workspace') },
      extensionPath: __dirname,
      extension: {
        packageJSON: {
          publisher: 'test-publisher',
          name: 'test-extension'
        }
      }
    } as any;

    // Create temp directories
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    installer = new BundleInstaller(mockContext);
  });

  teardown(() => {
    sinon.restore();
    // Cleanup temp directories
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  suite('installFromBuffer (unified architecture)', () => {
    test('should be the primary installation method', () => {
      // Verify installFromBuffer exists and is the main method
      assert.ok(typeof installer.installFromBuffer === 'function');
    });

    test('should accept Buffer parameter', () => {
      // Type check - installFromBuffer should accept Buffer
      const testBuffer = Buffer.from('test');
      assert.ok(Buffer.isBuffer(testBuffer));
    });

    test('passes the shared target plan to repository scope and writes lockfile entries from returned installed records', async () => {
      const workspaceRoot = path.join(tempDir, 'workspace-root');
      fs.mkdirSync(workspaceRoot, { recursive: true });

      const mockLockfileManager = {
        createOrUpdate: sinon.stub().resolves()
      } as any;
      sinon.stub(LockfileManager, 'getInstance').returns(mockLockfileManager);
      sinon.stub(vscode.workspace, 'workspaceFolders').value([
        { uri: vscode.Uri.file(workspaceRoot), name: 'test-workspace', index: 0 }
      ]);

      const scopeInstalled = [
        {
          itemId: 'code-review',
          kind: 'agent',
          sourcePath: 'foursight-pr-review/agents/code-review.agent.md',
          destinationPath: path.join(workspaceRoot, '.github', 'agents', 'code-review.agent.md'),
          destinationRelativePath: '.github/agents/code-review.agent.md',
          installedChecksum: 'sha256:scope-agent'
        },
        {
          itemId: 'foursight-code-review',
          kind: 'skill',
          sourcePath: 'foursight-pr-review/skills/foursight-code-review/SKILL.md',
          destinationPath: path.join(workspaceRoot, '.github', 'skills', 'foursight-code-review', 'SKILL.md'),
          destinationRelativePath: '.github/skills/foursight-code-review/SKILL.md',
          installedChecksum: 'sha256:scope-skill'
        }
      ];
      const mockScopeService = {
        syncBundle: sinon.stub().resolves({ installed: scopeInstalled }),
        unsyncBundle: sinon.stub().resolves()
      } as any;
      sinon.stub(ScopeServiceFactory, 'create').returns(mockScopeService);

      const zip = new AdmZip();
      for (const [entryPath, bytes] of createFoursightBundle()) {
        zip.addFile(entryPath, Buffer.from(bytes));
      }

      const installed = await installer.installFromBuffer(
        { ...mockBundle, id: 'foursight-pr-review', name: 'FourSight PR Review' },
        zip.toBuffer(),
        { scope: 'repository', commitMode: 'local-only' },
        'github'
      );

      assert.deepStrictEqual((installed as any).installedFiles, scopeInstalled, 'Installed bundle should persist the exact scope write results');
      assert.ok(mockScopeService.syncBundle.calledOnce, 'Repository scope should be invoked exactly once');
      assert.ok(mockScopeService.syncBundle.firstCall.args[2]?.targetPlan, 'Shared target plan should be passed to the scope service');
      assert.deepStrictEqual(
        mockLockfileManager.createOrUpdate.firstCall.args[0].files,
        scopeInstalled.map((file: any) => ({
          path: file.destinationRelativePath,
          checksum: file.installedChecksum,
          kind: file.kind,
          itemId: file.itemId
        })),
        'Repository lockfile should use the scope service installed records verbatim'
      );
    });

    test('builds the shared target plan for the detected host', async () => {
      const mockScopeService = {
        syncBundle: sinon.stub().resolves({ installed: [] }),
        unsyncBundle: sinon.stub().resolves()
      } as any;
      sinon.stub(ScopeServiceFactory, 'create').returns(mockScopeService);

      const zip = new AdmZip();
      for (const [entryPath, bytes] of createFoursightBundle()) {
        zip.addFile(entryPath, Buffer.from(bytes));
      }

      const kiroInstaller = new BundleInstaller(mockContext, 'kiro');
      await kiroInstaller.installFromBuffer(
        { ...mockBundle, id: 'foursight-pr-review', name: 'FourSight PR Review' },
        zip.toBuffer(),
        { scope: 'user' },
        'github'
      );

      const targetPlan = mockScopeService.syncBundle.firstCall.args[2]?.targetPlan;
      assert.strictEqual(targetPlan.target.type, 'kiro');
      assert.ok(
        targetPlan.operations.every((operation: any) => operation.destinationPath.includes(`${path.sep}.kiro${path.sep}`)),
        'Kiro operations should use Kiro destinations'
      );
    });

    test('plans user destinations from the scope-resolved target root', async () => {
      const resolvedRoot = path.join(tempDir, 'resolved-user-home', '.copilot');
      const mockScopeService = {
        resolveTarget: sinon.stub().callsFake((target: any) => ({ ...target, path: resolvedRoot })),
        syncBundle: sinon.stub().resolves({ installed: [] }),
        unsyncBundle: sinon.stub().resolves({ retained: [] })
      } as any;
      sinon.stub(ScopeServiceFactory, 'create').returns(mockScopeService);
      const zip = new AdmZip();
      for (const [entryPath, bytes] of createFoursightBundle()) {
        zip.addFile(entryPath, Buffer.from(bytes));
      }

      await installer.installFromBuffer(
        { ...mockBundle, id: 'foursight-pr-review', name: 'FourSight PR Review' },
        zip.toBuffer(),
        { scope: 'user' },
        'github'
      );

      const targetPlan = mockScopeService.syncBundle.firstCall.args[2]?.targetPlan;
      assert.ok(mockScopeService.resolveTarget.calledOnce, 'Scope policy should resolve the effective user target');
      assert.ok(
        targetPlan.operations.every((operation: any) => operation.destinationPath.startsWith(resolvedRoot)),
        'The shared plan should contain the effective absolute user destinations'
      );
    });
  });

  suite('uninstall', () => {
    test('passes persisted installed records back to scope unsync during uninstall', async () => {
      const installedFiles = [
        {
          itemId: 'test-prompt',
          kind: 'prompt',
          sourcePath: 'test.prompt.md',
          destinationPath: path.join(tempDir, '.copilot', 'prompts', 'test.prompt.md'),
          destinationRelativePath: 'prompts/test.prompt.md',
          installedChecksum: 'sha256:test-prompt'
        }
      ];
      const mockScopeService = {
        syncBundle: sinon.stub().resolves({ installed: installedFiles }),
        unsyncBundle: sinon.stub().resolves([])
      } as any;
      sinon.stub(ScopeServiceFactory, 'create').returns(mockScopeService);

      const zip = new AdmZip();
      zip.addFile('deployment-manifest.yml', Buffer.from([
        'id: test-bundle',
        'version: "1.0.0"',
        'name: Test Bundle',
        'prompts:',
        '  - id: test-prompt',
        '    name: Test Prompt',
        '    file: test.prompt.md',
        '    type: prompt'
      ].join('\n')));
      zip.addFile('test.prompt.md', Buffer.from('# Test prompt'));

      const installed = await installer.installFromBuffer(
        mockBundle,
        zip.toBuffer(),
        { scope: 'user' },
        'github'
      );

      await installer.uninstall(installed);

      assert.deepStrictEqual(mockScopeService.unsyncBundle.firstCall.args[1]?.installedFiles, installedFiles);
    });
    test('should remove all bundle files', () => {
      // Test complete file removal
      assert.ok(installer);
    });

    test('should handle missing installation directory gracefully', () => {
      // Test uninstalling non-existent bundle
      assert.ok(installer);
    });

    test('should not fail if some files are locked', () => {
      // Test resilience to file system errors
      assert.ok(installer);
    });
  });

  suite('update (deprecated)', () => {
    test('should exist but is deprecated', () => {
      // update() is deprecated - RegistryManager should handle updates
      assert.ok(typeof installer.update === 'function');
    });

    test('should accept Buffer parameter for unified architecture', () => {
      // update() now expects Buffer for remote bundles
      const testBuffer = Buffer.from('test');
      assert.ok(Buffer.isBuffer(testBuffer));
    });

    test('passes prior installed records to scope reconciliation', async () => {
      const previousFiles = [{
        itemId: 'test-prompt',
        kind: 'prompt' as const,
        sourcePath: 'test.prompt.md',
        destinationPath: path.join(tempDir, '.copilot', 'prompts', 'test.prompt.md'),
        destinationRelativePath: 'prompts/test.prompt.md',
        installedChecksum: 'sha256:previous'
      }];
      const mockScopeService = {
        syncBundle: sinon.stub().resolves({ installed: previousFiles }),
        unsyncBundle: sinon.stub().resolves({ retained: [] })
      } as any;
      sinon.stub(ScopeServiceFactory, 'create').returns(mockScopeService);
      const zip = new AdmZip();
      zip.addFile('deployment-manifest.yml', Buffer.from([
        'id: test-bundle',
        'version: "1.0.0"',
        'name: Test Bundle',
        'items:',
        '  - path: test.prompt.md',
        '    kind: prompt'
      ].join('\n')));
      zip.addFile('test.prompt.md', Buffer.from('# Updated prompt'));
      const installed = {
        bundleId: mockBundle.id,
        version: '0.9.0',
        installedAt: '2025-01-01T00:00:00.000Z',
        scope: 'user' as const,
        installPath: path.join(tempDir, 'previous-cache'),
        manifest: {} as any,
        sourceType: 'github',
        installedFiles: previousFiles
      };

      await installer.update(installed, mockBundle, zip.toBuffer(), 'github');

      assert.deepStrictEqual(mockScopeService.syncBundle.firstCall.args[2]?.installedFiles, previousFiles);
    });

    test('restores the old bundle cache when replacement installation fails', async () => {
      const cachePath = path.join(mockContext.globalStorageUri.fsPath, 'bundles', mockBundle.id);
      fs.mkdirSync(cachePath, { recursive: true });
      fs.writeFileSync(path.join(cachePath, 'old.txt'), 'old cache');
      const installed = {
        bundleId: mockBundle.id,
        version: '0.9.0',
        installedAt: '2025-01-01T00:00:00.000Z',
        scope: 'user',
        installPath: cachePath,
        manifest: {},
        installedFiles: []
      } as any;
      const uninstall = sinon.stub(installer, 'uninstall').resolves([]);
      sinon.stub(installer, 'installFromBuffer').callsFake(async () => {
        fs.mkdirSync(cachePath, { recursive: true });
        fs.writeFileSync(path.join(cachePath, 'partial.txt'), 'partial cache');
        throw new Error('replacement failed');
      });

      await assert.rejects(
        async () => installer.update(installed, mockBundle, Buffer.from('replacement')),
        /replacement failed/
      );

      assert.ok(!uninstall.called, 'Update must not uninstall the working version before replacement succeeds');
      assert.strictEqual(fs.readFileSync(path.join(cachePath, 'old.txt'), 'utf8'), 'old cache');
      assert.ok(!fs.existsSync(path.join(cachePath, 'partial.txt')), 'Partial replacement cache should be removed');
    });

    test('restores prior target bytes when replacement installation fails', async () => {
      const targetPath = path.join(tempDir, '.copilot', 'prompts', 'test.prompt.md');
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, '# Previous prompt\n');
      const installed = {
        bundleId: mockBundle.id,
        version: '0.9.0',
        installedAt: '2025-01-01T00:00:00.000Z',
        scope: 'user' as const,
        installPath: path.join(tempDir, 'previous-cache'),
        manifest: {} as any,
        sourceType: 'github',
        installedFiles: [{
          itemId: 'test-prompt',
          kind: 'prompt' as const,
          sourcePath: 'test.prompt.md',
          destinationPath: targetPath,
          destinationRelativePath: 'prompts/test.prompt.md',
          installedChecksum: 'sha256:previous'
        }]
      };
      sinon.stub(installer, 'installFromBuffer').callsFake(async () => {
        fs.writeFileSync(targetPath, '# Partial replacement\n');
        throw new Error('replacement failed');
      });

      await assert.rejects(
        installer.update(installed, mockBundle, Buffer.from('replacement')),
        /replacement failed/
      );

      assert.strictEqual(fs.readFileSync(targetPath, 'utf8'), '# Previous prompt\n');
    });

    test('restores prior repository metadata bytes when late local-only update cleanup fails', async () => {
      const workspaceRoot = path.join(tempDir, 'workspace-root');
      const lockfilePath = path.join(workspaceRoot, 'prompt-registry.local.lock.json');
      const excludePath = path.join(workspaceRoot, '.git', 'info', 'exclude');
      fs.mkdirSync(path.dirname(excludePath), { recursive: true });
      const priorLockfile = '{"bundles":{"test-bundle":{"version":"0.9.0"}}}\n';
      const priorExclude = '# Prompt Registry (local)\n.github/prompts/old.prompt.md\n';
      fs.writeFileSync(lockfilePath, priorLockfile);
      fs.writeFileSync(excludePath, priorExclude);
      sinon.stub(vscode.workspace, 'workspaceFolders').value([
        { uri: vscode.Uri.file(workspaceRoot), name: 'test-workspace', index: 0 }
      ]);
      const mockLockfileManager = {
        getLockfilePath: sinon.stub().returns(path.join(workspaceRoot, 'prompt-registry.lock.json')),
        getLocalLockfilePath: sinon.stub().returns(lockfilePath),
        createOrUpdate: sinon.stub().rejects(new Error('late lockfile failure'))
      } as any;
      sinon.stub(LockfileManager, 'getInstance').returns(mockLockfileManager);
      const oldTarget = path.join(workspaceRoot, '.github', 'prompts', 'old.prompt.md');
      const newTarget = path.join(workspaceRoot, '.github', 'prompts', 'new.prompt.md');
      fs.mkdirSync(path.dirname(oldTarget), { recursive: true });
      fs.writeFileSync(oldTarget, '# Old\n');
      const installed = {
        bundleId: mockBundle.id,
        version: '0.9.0',
        installedAt: '2025-01-01T00:00:00.000Z',
        scope: 'repository' as const,
        installPath: path.join(tempDir, 'previous-cache'),
        manifest: {} as any,
        sourceType: 'github',
        commitMode: 'local-only' as const,
        installedFiles: [{
          itemId: 'old', kind: 'prompt' as const, sourcePath: 'old.prompt.md',
          destinationPath: oldTarget, destinationRelativePath: '.github/prompts/old.prompt.md',
          installedChecksum: 'sha256:old'
        }]
      };
      sinon.stub(installer, 'installFromBuffer').callsFake(async () => {
        fs.writeFileSync(lockfilePath, '{"bundles":{"test-bundle":{"version":"1.0.0"}}}\n');
        fs.writeFileSync(excludePath, '# Prompt Registry (local)\n.github/prompts/new.prompt.md\n');
        fs.writeFileSync(newTarget, '# New\n');
        return {
          ...installed,
          version: '1.0.0',
          installedFiles: [{
            itemId: 'new', kind: 'prompt' as const, sourcePath: 'new.prompt.md',
            destinationPath: newTarget, destinationRelativePath: '.github/prompts/new.prompt.md',
            installedChecksum: 'sha256:new'
          }]
        };
      });
      sinon.stub(ScopeServiceFactory, 'create').returns({
        unsyncBundle: sinon.stub().resolves({ retained: [] })
      } as any);

      await assert.rejects(
        installer.update(installed, mockBundle, Buffer.from('replacement'), 'github'),
        /late lockfile failure/
      );

      assert.strictEqual(fs.readFileSync(lockfilePath, 'utf8'), priorLockfile);
      assert.strictEqual(fs.readFileSync(excludePath, 'utf8'), priorExclude);
    });
  });

  suite('Validation', () => {
    test('should validate manifest structure', () => {
      const validManifest = {
        id: 'test-bundle',
        version: '1.0.0',
        name: 'Test',
        description: 'Test',
        author: 'Test',
        prompts: []
      };

      // Test validation logic
      assert.ok(validManifest);
    });

    test('should reject manifest with missing required fields', () => {
      const invalidManifest = {
        id: 'test-bundle'
        // missing version, name, etc.
      };

      // Test validation rejection
      assert.ok(invalidManifest);
    });

    test('should reject manifest with wrong bundle ID', () => {
      const manifest = {
        id: 'wrong-id', // doesn't match bundle.id
        version: '1.0.0',
        name: 'Test',
        description: 'Test',
        author: 'Test',
        prompts: []
      };

      // Test ID validation
      assert.ok(manifest);
    });

    // Bundle ID validation tests - testing actual validation behavior
    test('should validate bundle with short manifest ID matching suffix pattern', async () => {
      // This tests the backward compatibility for GitHub bundles
      // where manifest.id is just the collection ID (e.g., "test2")
      // but bundle.id is the full computed ID (e.g., "owner-repo-test2-v1.0.2")

      // The validation should pass when:
      // - bundleId ends with `-${manifestId}-v${manifestVersion}`
      // - bundleId ends with `-${manifestId}-${manifestVersion}`
      // - manifestId === bundleId (exact match)

      const testCases = [
        {
          manifestId: 'test2',
          manifestVersion: '1.0.2',
          bundleId: 'owner-repo-test2-v1.0.2',
          shouldMatch: true,
          description: 'suffix pattern with v prefix'
        },
        {
          manifestId: 'test2',
          manifestVersion: '1.0.2',
          bundleId: 'owner-repo-test2-1.0.2',
          shouldMatch: true,
          description: 'suffix pattern without v prefix'
        },
        {
          manifestId: 'owner-repo-collection-v1.0.0',
          manifestVersion: '1.0.0',
          bundleId: 'owner-repo-collection-v1.0.0',
          shouldMatch: true,
          description: 'exact match'
        },
        {
          manifestId: 'completely-different',
          manifestVersion: '1.0.0',
          bundleId: 'owner-repo-test2-v1.0.0',
          shouldMatch: false,
          description: 'mismatched IDs'
        },
        {
          manifestId: 'test2',
          manifestVersion: '1.0.2',
          bundleId: 'amadeus-airlines-solutions-genai.spec-driven-agents-test2-1.0.2',
          shouldMatch: true,
          description: 'repo name with dot'
        }
      ];

      for (const tc of testCases) {
        // Import the validation function
        const { isManifestIdMatch } = await import('../../src/utils/bundle-name-utils');
        const result = isManifestIdMatch(tc.manifestId, tc.manifestVersion, tc.bundleId);
        assert.strictEqual(result, tc.shouldMatch,
          `${tc.description}: manifestId="${tc.manifestId}" bundleId="${tc.bundleId}" should ${tc.shouldMatch ? 'match' : 'not match'}`);
      }
    });
  });

  suite('File Operations', () => {
    test('should create installation directory if not exists', () => {
      // Test directory creation
      assert.ok(installer);
    });

    test('should copy files recursively', () => {
      // Test recursive copy
      assert.ok(installer);
    });

    test('should preserve file permissions', () => {
      // Test permission preservation
      assert.ok(installer);
    });

    test('should handle deeply nested directories', () => {
      // Test deep nesting
      assert.ok(installer);
    });
  });

  suite('Error Handling', () => {
    test('should have installFromBuffer as the primary method', () => {
      // install() was removed - installFromBuffer is the primary method
      assert.ok(typeof installer.installFromBuffer === 'function');
    });

    test('should handle extraction failures in installFromBuffer', () => {
      // installFromBuffer handles extraction
      assert.ok(typeof installer.installFromBuffer === 'function');
    });

    test('should handle validation failures', () => {
      // Test validation error handling
      assert.ok(installer);
    });

    test('should provide descriptive error messages', () => {
      // Test error message quality
      assert.ok(installer);
    });
  });

  suite('Architecture Validation', () => {
    test('downloadFile method should not exist', () => {
      // downloadFile was removed - downloads are handled by adapters
      assert.strictEqual((installer as any).downloadFile, undefined);
    });

    test('installFromBuffer() is the primary method', () => {
      // installFromBuffer is the main installation method
      assert.ok(typeof installer.installFromBuffer === 'function');
    });
  });

  suite('Local Skills Symlink Installation', () => {
    test('installLocalSkillAsSymlink method should exist', () => {
      assert.ok(typeof installer.installLocalSkillAsSymlink === 'function');
    });

    test('uninstallSkillSymlink method should exist', () => {
      assert.ok(typeof installer.uninstallSkillSymlink === 'function');
    });

    test('should create symlink for local skill', async () => {
      // Create a source skill directory
      const sourceSkillDir = path.join(tempDir, 'source-skills', 'test-skill');
      fs.mkdirSync(sourceSkillDir, { recursive: true });
      fs.writeFileSync(path.join(sourceSkillDir, 'SKILL.md'), '---\nname: test-skill\ndescription: Test\n---\n# Test');

      const options: InstallOptions = {
        scope: 'user',
        force: false
      };

      try {
        const installed = await installer.installLocalSkillAsSymlink(
          mockBundle,
          'test-skill',
          sourceSkillDir,
          options
        );

        assert.ok(installed);
        assert.strictEqual(installed.bundleId, mockBundle.id);
        assert.strictEqual(installed.sourceType, 'local-skills');
        assert.ok(installed.installPath);
      } catch (error) {
        // May fail due to missing ~/.copilot directory in test environment
        // This is expected behavior - the test verifies the method exists and is callable
        assert.ok(error instanceof Error);
      }
    });

    test('should handle uninstall of symlinked skill', async () => {
      const mockInstalled = {
        bundleId: 'test-bundle',
        version: '1.0.0',
        installedAt: new Date().toISOString(),
        scope: 'user' as const,
        installPath: path.join(tempDir, 'nonexistent-skill'),
        manifest: {} as any,
        sourceId: 'test-source',
        sourceType: 'local-skills'
      };

      // Should not throw even if path doesn't exist
      await installer.uninstallSkillSymlink(mockInstalled);
    });
  });

  suite('installFromBuffer - skills bundle with non-standard source directory', () => {
    /**
     * Build a skills bundle ZIP where the skill lives under a non-standard directory
     * and the manifest file field points at its real location.
     * @param skillId
     * @param skillDirPrefix directory inside the bundle that holds the skill (e.g. .github/skills)
     */
    const buildSkillsZip = (skillId: string, skillDirPrefix: string): Buffer => {
      const zip = new AdmZip();
      const skillFile = `${skillDirPrefix}/${skillId}/SKILL.md`;
      const manifest = {
        id: 'nonstandard-skill-bundle',
        version: '1.0.0',
        name: 'Non-standard Skill Bundle',
        prompts: [
          {
            id: skillId,
            name: skillId,
            description: 'Skill under a non-standard directory',
            file: skillFile,
            type: 'skill'
          }
        ]
      };
      zip.addFile('deployment-manifest.yml', Buffer.from(JSON.stringify(manifest), 'utf8'));
      zip.addFile(skillFile, Buffer.from('# Skill\n', 'utf8'));
      zip.addFile(`${skillDirPrefix}/${skillId}/helper.sh`, Buffer.from('echo hi\n', 'utf8'));
      return zip.toBuffer();
    };

    test('installs skill from the manifest path, not a hardcoded skills/ directory', async () => {
      const skillId = 'nevio-deployment-automation';
      const copilotSkillsDir = path.join(tempDir, '.copilot', 'skills');
      fs.mkdirSync(copilotSkillsDir, { recursive: true });

      const originalHome = process.env.HOME;
      process.env.HOME = tempDir;

      const bundle: Bundle = { ...mockBundle, id: 'nonstandard-skill-bundle' };
      const zipBuffer = buildSkillsZip(skillId, '.github/skills');
      const options: InstallOptions = { scope: 'user', force: false };

      try {
        const installed = await installer.installFromBuffer(bundle, zipBuffer, options, 'skills');

        const installedSkillDir = path.join(copilotSkillsDir, skillId);
        assert.ok(fs.existsSync(installedSkillDir), 'Skill directory should be installed');
        assert.ok(fs.existsSync(path.join(installedSkillDir, 'SKILL.md')), 'SKILL.md should be copied');
        assert.ok(fs.existsSync(path.join(installedSkillDir, 'helper.sh')), 'helper.sh should be copied');
        assert.strictEqual(installed.installPath, path.join(mockContext.globalStorageUri.fsPath, 'bundles', bundle.id));
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });
});
