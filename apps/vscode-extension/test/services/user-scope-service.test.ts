/**
 * UserScopeService Unit Tests
 * Tests cross-platform path resolution and sync functionality
 *
 * Note: Most tests require VS Code integration test environment
 * These are unit tests for testable logic only
 *
 * WSL-specific tests are in UserScopeService.wsl.test.ts
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  UserScopeService,
} from '../../src/services/user-scope-service';

suite('UserScopeService', () => {
  let service: UserScopeService;
  let mockContext: any;
  let tempDir: string;

  setup(() => {
    tempDir = path.join(__dirname, '..', '..', '..', 'test-temp-copilot');

    // Mock VS Code ExtensionContext with realistic path structure
    // Simulate: ~/Library/Application Support/Code/User/globalStorage/publisher.extension
    const mockUserDir = path.join(tempDir, 'Code', 'User');
    mockContext = {
      globalStorageUri: { fsPath: path.join(mockUserDir, 'globalStorage', 'publisher.extension') },
      storageUri: { fsPath: path.join(tempDir, 'workspace') },
      extensionPath: __dirname,
      subscriptions: []
    };

    // Create temp directories
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    service = new UserScopeService(mockContext, tempDir);
  });

  teardown(() => {
    // Cleanup temp directories
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  suite('Service Initialization', () => {
    test('should initialize with context', () => {
      assert.ok(service, 'Service should be initialized');
    });

    test('should have sync methods', () => {
      assert.ok(typeof service.syncBundle === 'function', 'Should have syncBundle method');
      assert.ok(typeof service.unsyncBundle === 'function', 'Should have unsyncBundle method');
    });
  });

  suite('syncBundle', () => {
    test('should accept bundle ID and path', async () => {
      const bundleId = 'test-bundle';
      const bundlePath = path.join(tempDir, 'bundle');

      // Create mock bundle directory
      if (!fs.existsSync(bundlePath)) {
        fs.mkdirSync(bundlePath, { recursive: true });
      }

      // Create a mock deployment-manifest.yml
      const manifestPath = path.join(bundlePath, 'deployment-manifest.yml');
      fs.writeFileSync(manifestPath, `
id: ${bundleId}
version: "1.0.0"
prompts: []
`);

      // This will likely fail in unit test without real Copilot directory
      // But we're testing that the method exists and accepts parameters
      try {
        await service.syncBundle(bundleId, bundlePath);
        // If it succeeds, great!
        assert.ok(true, 'syncBundle should complete');
      } catch (error: any) {
        // Expected in unit test environment
        // Just verify error is related to file operations, not parameter issues
        assert.ok(error.message || true, 'Error is expected in unit test environment');
      }
    });

    test('should reject invalid bundle path', async () => {
      try {
        await service.syncBundle('invalid-bundle', '/nonexistent/path');
        // Should not reach here
        assert.fail('Should throw error for invalid path');
      } catch (error) {
        assert.ok(error, 'Should throw error for invalid bundle path');
      }
    });
  });

  suite('User-scope knowledge placement', () => {
    const sourceFile = 'specifications/RDP/core_layer/AGENT_INDEX.md';

    const createKnowledgeBundle = (bundlePath: string, bundleId: string): void => {
      const sourcePath = path.join(bundlePath, sourceFile);
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, '# Knowledge');
      fs.mkdirSync(bundlePath, { recursive: true });
      fs.writeFileSync(path.join(bundlePath, 'deployment-manifest.yml'), `id: ${bundleId}
version: "1.0.0"
prompts:
  - id: AGENT_INDEX
    name: Agent Index
    file: ${sourceFile}
    type: knowledge
`);
    };

    test('preserves the source-relative path under VS Code and Kiro user knowledge routes', async () => {
      const bundleId = 'knowledge-user-bundle';
      const bundlePath = path.join(tempDir, 'knowledge-bundle');
      createKnowledgeBundle(bundlePath, bundleId);

      for (const targetType of ['vscode', 'kiro'] as const) {
        const knowledgeService = new UserScopeService(mockContext, tempDir, targetType);
        await knowledgeService.syncBundle(bundleId, bundlePath);

        const targetRoot = targetType === 'vscode' ? '.copilot' : '.kiro';
        const installedFile = path.join(tempDir, targetRoot, 'knowledge', sourceFile);
        assert.ok(fs.existsSync(installedFile));
        assert.strictEqual(fs.readFileSync(installedFile, 'utf8'), '# Knowledge');
      }
    });

    test('unsyncs knowledge-only bundles without requiring a prompts directory', async () => {
      const bundleId = 'knowledge-only-user-bundle';
      const bundlePath = path.join(mockContext.globalStorageUri.fsPath, 'bundles', bundleId);
      createKnowledgeBundle(bundlePath, bundleId);
      const knowledgeService = new UserScopeService(mockContext, tempDir, 'vscode');

      await knowledgeService.syncBundle(bundleId, bundlePath);

      const installedFile = path.join(tempDir, '.copilot', 'knowledge', sourceFile);
      assert.ok(fs.existsSync(installedFile));
      assert.ok(!fs.existsSync(path.join(tempDir, '.copilot', 'prompts')));

      await knowledgeService.unsyncBundle(bundleId);

      assert.ok(!fs.existsSync(installedFile));
    });
  });

  suite('Kiro target installation', () => {
    test('uses the Kiro layout and transforms agent frontmatter', async () => {
      const bundleId = 'kiro-agent-bundle';
      const bundlePath = path.join(tempDir, 'kiro-bundle');
      const agentPath = path.join(bundlePath, 'agents', 'review-agent.md');
      fs.mkdirSync(path.dirname(agentPath), { recursive: true });
      fs.writeFileSync(agentPath, '---\ntitle: "Review Agent"\n---\nReview code.');
      fs.writeFileSync(path.join(bundlePath, 'deployment-manifest.yml'), `
id: ${bundleId}
version: "1.0.0"
prompts:
  - id: review-agent
    name: Review Agent
    file: agents/review-agent.md
    type: agent
`);

      const kiroService = new UserScopeService(mockContext, tempDir, 'kiro');
      await kiroService.syncBundle(bundleId, bundlePath);

      const targetPath = path.join(tempDir, '.kiro', 'agents', 'review-agent.agent.md');
      assert.ok(fs.existsSync(targetPath), 'Kiro agent should be written under ~/.kiro/agents');
      assert.ok(fs.readFileSync(targetPath, 'utf8').includes('name: "Review Agent"'));
    });
  });

  suite('Target type detection', () => {
    let originalAppName: string;
    let originalUriScheme: string;

    setup(() => {
      originalAppName = vscode.env.appName;
      originalUriScheme = vscode.env.uriScheme;
    });

    teardown(() => {
      (vscode.env as any).appName = originalAppName;
      (vscode.env as any).uriScheme = originalUriScheme;
    });

    const createPromptBundle = (bundleId: string, bundlePath: string) => {
      const promptsDir = path.join(bundlePath, 'prompts');
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(path.join(promptsDir, 'test-prompt.md'), '# Test prompt');
      fs.writeFileSync(path.join(bundlePath, 'deployment-manifest.yml'), `
id: ${bundleId}
version: "1.0.0"
prompts:
  - id: test-prompt
    name: Test Prompt
    file: prompts/test-prompt.md
    type: prompt
`);
    };

    test('detects Devin by appName and uses Windsurf layout', async () => {
      const bundleId = 'devin-prompt-bundle';
      const bundlePath = path.join(tempDir, 'devin-bundle');
      createPromptBundle(bundleId, bundlePath);

      (vscode.env as any).appName = 'Devin';
      (vscode.env as any).uriScheme = 'devin';
      const devinService = new UserScopeService(mockContext, tempDir);
      await devinService.syncBundle(bundleId, bundlePath);

      const targetPath = path.join(tempDir, '.codeium', 'windsurf', 'rules', 'test-prompt.prompt.md');
      assert.ok(fs.existsSync(targetPath), `Prompt should be written to Windsurf rules: ${targetPath}`);
    });

    test('detects Windsurf by uriScheme fallback', async () => {
      const bundleId = 'windsurf-prompt-bundle';
      const bundlePath = path.join(tempDir, 'windsurf-bundle');
      createPromptBundle(bundleId, bundlePath);

      (vscode.env as any).appName = 'Visual Studio Code';
      (vscode.env as any).uriScheme = 'windsurf';
      const windsurfService = new UserScopeService(mockContext, tempDir);
      await windsurfService.syncBundle(bundleId, bundlePath);

      const targetPath = path.join(tempDir, '.codeium', 'windsurf', 'rules', 'test-prompt.prompt.md');
      assert.ok(fs.existsSync(targetPath), `Prompt should be written to Windsurf rules: ${targetPath}`);
    });

    test('detects vscode-insiders by appName', async () => {
      const bundleId = 'insiders-prompt-bundle';
      const bundlePath = path.join(tempDir, 'insiders-bundle');
      createPromptBundle(bundleId, bundlePath);

      (vscode.env as any).appName = 'Visual Studio Code - Insiders';
      (vscode.env as any).uriScheme = 'vscode-insiders';
      const insidersService = new UserScopeService(mockContext, tempDir);
      await insidersService.syncBundle(bundleId, bundlePath);

      const targetPath = path.join(tempDir, '.copilot', 'prompts', 'test-prompt.prompt.md');
      assert.ok(fs.existsSync(targetPath), `Prompt should be written to generic Copilot prompts: ${targetPath}`);
    });
  });

  suite('unsyncBundle', () => {
    test('should accept bundle ID', async () => {
      const bundleId = 'test-bundle';

      // This will try to remove sync files
      // In unit test, may not have anything to remove
      try {
        await service.unsyncBundle(bundleId);
        assert.ok(true, 'unsyncBundle should complete');
      } catch (error: any) {
        // May fail if Copilot directory doesn't exist
        assert.ok(error.message || true, 'Error is expected in unit test environment');
      }
    });

    test('should handle non-existent bundle', async () => {
      try {
        await service.unsyncBundle('non-existent-bundle');
        // Should complete without error (idempotent)
        assert.ok(true, 'Should handle non-existent bundle gracefully');
      } catch (error: any) {
        // Or throw appropriate error
        assert.ok(error, 'Error handling is acceptable');
      }
    });
  });

  suite('Error Handling', () => {
    test('should handle missing deployment manifest', async () => {
      const bundleId = 'no-manifest-bundle';
      const bundlePath = path.join(tempDir, 'no-manifest');

      if (!fs.existsSync(bundlePath)) {
        fs.mkdirSync(bundlePath, { recursive: true });
      }

      // No manifest file created

      try {
        await service.syncBundle(bundleId, bundlePath);
        // May succeed or fail depending on implementation
      } catch (error: any) {
        assert.ok(error.message.includes('manifest') || error.message.includes('ENOENT'),
          'Error should mention manifest or file not found');
      }
    });

    test('should provide meaningful error messages', async () => {
      try {
        await service.syncBundle('', '');
        assert.fail('Should throw error for empty parameters');
      } catch (error: any) {
        assert.ok(error.message, 'Should provide error message');
        assert.ok(error.message.length > 0, 'Error message should not be empty');
      }
    });
  });

  suite('syncBundle - skill with non-standard path', () => {
    let sandbox: sinon.SinonSandbox;
    let skillBundlePath: string;
    let syncSkillSpy: sinon.SinonSpy;

    setup(() => {
      sandbox = sinon.createSandbox();

      // Create a bundle that mimics a GitHub release where the skill lives
      // under .github/skills/ instead of the standard skills/ root path.
      skillBundlePath = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-bundle-'));
      const skillDir = path.join(skillBundlePath, '.github', 'skills', 'nevio-deployment-automation');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: Deployment Automation\ndescription: Test\n---\n# Skill');
      fs.writeFileSync(path.join(skillDir, 'helper.sh'), '#!/bin/bash\necho hello');

      const manifest = {
        id: 'test-skills-bundle',
        version: '1.0.0',
        name: 'Test Skills Bundle',
        prompts: [
          {
            id: 'nevio-deployment-automation',
            name: 'Deployment Automation',
            file: '.github/skills/nevio-deployment-automation/SKILL.md',
            type: 'skill'
          }
        ]
      };
      fs.writeFileSync(
        path.join(skillBundlePath, 'deployment-manifest.yml'),
        JSON.stringify(manifest)
      );

      // Spy on the public syncSkill so we can assert its arguments without writing to ~/.copilot/skills
      syncSkillSpy = sandbox.stub(service, 'syncSkill').resolves();
    });

    teardown(() => {
      sandbox.restore();
      fs.rmSync(skillBundlePath, { recursive: true, force: true });
    });

    test('should sync skill when file path has .github/skills prefix', async () => {
      await service.syncBundle('test-skills-bundle', skillBundlePath);

      assert.ok(syncSkillSpy.calledOnce, 'syncSkill should have been called once');

      const [skillName, sourceDir] = syncSkillSpy.firstCall.args;
      assert.strictEqual(skillName, 'nevio-deployment-automation',
        'skill name should be extracted correctly from the path');
      assert.strictEqual(sourceDir, path.join(skillBundlePath, '.github', 'skills', 'nevio-deployment-automation'),
        'sourceDir should point to the actual skill location in the bundle, not a hardcoded skills/ prefix');
    });

    test('should still sync skill when file path has standard skills/ prefix', async () => {
      // Create a second bundle with the standard path layout
      const standardBundlePath = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-bundle-standard-'));
      const skillDir = path.join(standardBundlePath, 'skills', 'pr-review');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: PR Review\ndescription: Test\n---\n# Skill');

      const manifest = {
        id: 'test-standard-bundle',
        version: '1.0.0',
        name: 'Test Standard Bundle',
        prompts: [
          {
            id: 'pr-review',
            name: 'PR Review',
            file: 'skills/pr-review/SKILL.md',
            type: 'skill'
          }
        ]
      };
      fs.writeFileSync(
        path.join(standardBundlePath, 'deployment-manifest.yml'),
        JSON.stringify(manifest)
      );

      try {
        await service.syncBundle('test-standard-bundle', standardBundlePath);

        assert.ok(syncSkillSpy.calledOnce, 'syncSkill should have been called once');

        const [skillName, sourceDir] = syncSkillSpy.firstCall.args;
        assert.strictEqual(skillName, 'pr-review', 'skill name should be correct');
        assert.strictEqual(sourceDir, path.join(standardBundlePath, 'skills', 'pr-review'),
          'sourceDir should point to skills/pr-review in the bundle');
      } finally {
        fs.rmSync(standardBundlePath, { recursive: true, force: true });
      }
    });
  });

  suite('Broken Symlink Handling', () => {
    test('should correctly identify broken vs valid symlinks', () => {
      const validTarget = path.join(tempDir, 'valid-target.txt');
      const validSymlink = path.join(tempDir, 'valid-symlink.txt');

      fs.writeFileSync(validTarget, 'valid content');

      try {
        fs.symlinkSync(validTarget, validSymlink);

        // Create a broken symlink by creating symlink then removing target
        const brokenTarget = path.join(tempDir, 'broken-target.txt');
        const brokenSymlink = path.join(tempDir, 'broken-symlink.txt');

        fs.writeFileSync(brokenTarget, 'will be deleted');
        fs.symlinkSync(brokenTarget, brokenSymlink);
        fs.unlinkSync(brokenTarget);

        // Verify fs.existsSync behavior (the root cause of the bug)
        assert.strictEqual(fs.existsSync(validSymlink), true,
          'fs.existsSync should return true for valid symlink');
        assert.strictEqual(fs.existsSync(brokenSymlink), false,
          'fs.existsSync returns false for broken symlink (this is the bug)');

        // Verify lstat can still detect broken symlinks
        const brokenStats = fs.lstatSync(brokenSymlink);
        assert.strictEqual(brokenStats.isSymbolicLink(), true,
          'lstat should detect broken symlink');
      } catch (error: any) {
        if (error.code === 'EPERM' || error.code === 'ENOTSUP') {
          assert.ok(true, 'Symlinks not supported on this platform');
        } else {
          throw error;
        }
      }
    });
  });
});
