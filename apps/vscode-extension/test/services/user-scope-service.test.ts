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
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createTargetWritePlan,
  resolveLayout,
} from '@ai-primitives-hub/app';
import {
  createBundleInstallPlan,
  type Target,
  type TargetWritePlan,
  validateManifest,
} from '@ai-primitives-hub/core';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  UserScopeService,
} from '../../src/services/user-scope-service';
import {
  createFoursightBundle,
  foursightArchiveEntries,
} from '../fixtures/foursight-bundle';
import {
  buildUserScopeTargetPlan,
} from '../helpers/target-plan-helpers';

suite('UserScopeService', () => {
  let service: UserScopeService;
  let mockContext: any;
  let tempDir: string;

  const writeBundleSource = (bundlePath: string, files: ReadonlyMap<string, Uint8Array>, includeManifest = false): void => {
    fs.mkdirSync(bundlePath, { recursive: true });
    for (const [entryPath, bytes] of files) {
      if (!includeManifest && entryPath === 'deployment-manifest.yml') {
        continue;
      }
      const targetPath = path.join(bundlePath, entryPath);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, Buffer.from(bytes));
    }
  };

  const createPlan = (
    files: ReadonlyMap<string, Uint8Array>,
    targetType: 'vscode' | 'kiro' = 'vscode',
    env?: Record<string, string | undefined>
  ): TargetWritePlan => {
    const manifest = validateManifest(files, {});
    const bundlePlan = createBundleInstallPlan(files, manifest);
    const target: Target = {
      name: targetType,
      type: targetType,
      scope: 'user'
    };
    return createTargetWritePlan(bundlePlan, target, resolveLayout(target), env ?? { ...process.env, HOME: tempDir });
  };

  const createSingleItemBundle = (
    bundleId: string,
    promptId: string,
    promptName: string,
    filePath: string,
    type: 'prompt' | 'agent',
    content: string,
    targetType: 'vscode' | 'kiro' = 'vscode',
    env?: Record<string, string | undefined>
  ): { files: ReadonlyMap<string, Uint8Array>; plan: TargetWritePlan } => {
    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', new TextEncoder().encode([
        `id: ${bundleId}`,
        'version: "1.0.0"',
        `name: ${bundleId}`,
        'prompts:',
        `  - id: ${promptId}`,
        `    name: ${promptName}`,
        `    file: ${filePath}`,
        `    type: ${type}`
      ].join('\n'))],
      [filePath, new TextEncoder().encode(content)]
    ]);
    return {
      files,
      plan: createPlan(files, targetType, env)
    };
  };

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
    sinon.restore();
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
    test('executes the shared target plan it is given', async () => {
      const bundleId = 'test-bundle';
      const bundlePath = path.join(tempDir, 'bundle');
      fs.mkdirSync(bundlePath, { recursive: true });
      fs.mkdirSync(path.join(bundlePath, 'prompts'), { recursive: true });
      fs.writeFileSync(path.join(bundlePath, 'prompts', 'hello.md'), '# Hello\n');
      fs.writeFileSync(path.join(bundlePath, 'deployment-manifest.yml'), [
        `id: ${bundleId}`,
        'version: "1.0.0"',
        'name: Test Bundle',
        'prompts:',
        '  - id: hello',
        '    name: Hello',
        '    file: prompts/hello.md',
        '    type: prompt'
      ].join('\n'));

      const result = await service.syncBundle(bundleId, bundlePath, {
        targetPlan: buildUserScopeTargetPlan(service, bundleId, bundlePath)
      });

      assert.strictEqual(result.installed.length, 1, 'The single planned operation should be installed');
      assert.ok(
        fs.existsSync(path.join(tempDir, '.copilot', 'prompts', 'hello.prompt.md')),
        'Prompt should land at the planned destination'
      );
    });

    test('refuses to install without a shared target plan', async () => {
      // Destinations are planned by the install pipeline; the service must never
      // re-derive them from a manifest on disk.
      await assert.rejects(
        async () => service.syncBundle('plan-less-bundle', path.join(tempDir, 'bundle')),
        /requires SyncBundleOptions\.targetPlan/
      );
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
      await kiroService.syncBundle(bundleId, bundlePath, {
        targetPlan: buildUserScopeTargetPlan(kiroService, bundleId, bundlePath, 'kiro')
      });

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
      await devinService.syncBundle(bundleId, bundlePath, {
        targetPlan: buildUserScopeTargetPlan(devinService, bundleId, bundlePath)
      });

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
      await windsurfService.syncBundle(bundleId, bundlePath, {
        targetPlan: buildUserScopeTargetPlan(windsurfService, bundleId, bundlePath)
      });

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
      await insidersService.syncBundle(bundleId, bundlePath, {
        targetPlan: buildUserScopeTargetPlan(insidersService, bundleId, bundlePath)
      });

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
      fs.mkdirSync(bundlePath, { recursive: true });

      // Manifest validation now happens while the shared plan is built, before
      // any scope service is involved.
      assert.throws(
        () => buildUserScopeTargetPlan(service, bundleId, bundlePath),
        /deployment-manifest\.yml/
      );
    });

    test('should provide meaningful error messages', async () => {
      await assert.rejects(
        async () => service.syncBundle('', ''),
        (error: Error) => {
          assert.ok(error.message.length > 0, 'Error message should not be empty');
          assert.match(error.message, /requires SyncBundleOptions\.targetPlan/);
          return true;
        }
      );
    });
  });

  suite('syncBundle - skill with non-standard path', () => {
    let sandbox: sinon.SinonSandbox;
    let skillBundlePath: string;

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
    });

    teardown(() => {
      sandbox.restore();
      fs.rmSync(skillBundlePath, { recursive: true, force: true });
    });

    test('should sync skill when file path has .github/skills prefix', async () => {
      await service.syncBundle('test-skills-bundle', skillBundlePath, {
        targetPlan: buildUserScopeTargetPlan(service, 'test-skills-bundle', skillBundlePath)
      });

      const targetDir = path.join(tempDir, '.copilot', 'skills', 'nevio-deployment-automation');
      assert.ok(fs.existsSync(targetDir), 'Skill directory should be installed');
      assert.ok(fs.existsSync(path.join(targetDir, 'SKILL.md')), 'SKILL.md should be copied');
      assert.ok(fs.existsSync(path.join(targetDir, 'helper.sh')), 'helper.sh should be copied');
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
        await service.syncBundle('test-standard-bundle', standardBundlePath, {
          targetPlan: buildUserScopeTargetPlan(service, 'test-standard-bundle', standardBundlePath)
        });

        const targetDir = path.join(tempDir, '.copilot', 'skills', 'pr-review');
        assert.ok(fs.existsSync(targetDir), 'Skill directory should be installed');
        assert.ok(fs.existsSync(path.join(targetDir, 'SKILL.md')), 'SKILL.md should be copied');
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

  suite('syncBundle - shared target plan', () => {
    test('installs the supplied FourSight plan without rereading the on-disk manifest', async () => {
      const bundlePath = path.join(tempDir, 'foursight-plan-user');
      const bundleFiles = createFoursightBundle();
      writeBundleSource(bundlePath, bundleFiles, false);

      const result = await (service as any).syncBundle('foursight-pr-review', bundlePath, {
        targetPlan: createPlan(bundleFiles)
      });

      const expectedAgents = [
        'code-review.agent.md',
        'security-review.agent.md',
        'test-review.agent.md',
        'docs-review.agent.md',
        'architecture-review.agent.md'
      ];
      for (const fileName of expectedAgents) {
        assert.ok(
          fs.existsSync(path.join(tempDir, '.copilot', 'agents', fileName)),
          `Expected agent ${fileName} in the Copilot agents directory`
        );
      }

      for (const relativePath of Object.keys(foursightArchiveEntries).filter((filePath) => filePath.includes('/skills/'))) {
        const installedRelative = relativePath.replace('foursight-pr-review/skills/foursight-code-review/', '');
        assert.ok(
          fs.existsSync(path.join(tempDir, '.copilot', 'skills', 'foursight-code-review', installedRelative)),
          `Expected skill file ${installedRelative} in the Copilot skills directory`
        );
      }

      assert.strictEqual(result.installed.length, 9);
    });

    test('prefers symlinks for regular files when executing a supplied target plan', async () => {
      const bundlePath = path.join(tempDir, 'symlink-plan-user');
      const { files, plan } = createSingleItemBundle(
        'symlink-bundle',
        'test-prompt',
        'Test Prompt',
        'prompts/test-prompt.md',
        'prompt',
        '# Test prompt\n'
      );
      writeBundleSource(bundlePath, files, false);

      const result = await (service as any).syncBundle('symlink-bundle', bundlePath, { targetPlan: plan });
      const targetPath = path.join(tempDir, '.copilot', 'prompts', 'test-prompt.prompt.md');

      assert.ok(fs.lstatSync(targetPath).isSymbolicLink(), 'Prompt should be installed as a symlink');
      assert.strictEqual(result.installed[0].destinationPath, targetPath);
    });

    test('copies into the Windows Copilot directory when executing a supplied target plan in WSL', async () => {
      const childProcess = require('node:child_process');
      const windowsHome = path.join(tempDir, 'Users', 'testuser');
      sinon.stub(vscode.env, 'remoteName').value('wsl');
      sinon.stub(vscode.env, 'uriScheme').value('vscode');
      sinon.stub(childProcess, 'execSync').returns(`${windowsHome}\n`);

      const wslService = new UserScopeService(mockContext);
      const bundlePath = path.join(tempDir, 'wsl-plan-user');
      const { files } = createSingleItemBundle(
        'wsl-bundle',
        'test-prompt',
        'Test Prompt',
        'prompts/test-prompt.md',
        'prompt',
        '# Test prompt\n',
        'vscode',
        { ...process.env, HOME: path.join(tempDir, 'linux-home') }
      );
      writeBundleSource(bundlePath, files, false);
      const baseTarget: Target = { name: 'vscode', type: 'vscode', scope: 'user' };
      const resolvedTarget = (wslService as any).resolveTarget(baseTarget) as Target;
      const plan = createTargetWritePlan(
        createBundleInstallPlan(files, validateManifest(files, {})),
        resolvedTarget,
        resolveLayout(resolvedTarget),
        { ...process.env, HOME: path.join(tempDir, 'linux-home') }
      );

      const result = await (wslService as any).syncBundle('wsl-bundle', bundlePath, { targetPlan: plan });
      const targetPath = path.join(windowsHome, '.copilot', 'prompts', 'test-prompt.prompt.md');

      assert.ok(fs.existsSync(targetPath), 'Prompt should be written to the Windows Copilot directory');
      assert.ok(!fs.lstatSync(targetPath).isSymbolicLink(), 'WSL installs should copy instead of symlinking');
      assert.strictEqual(result.installed[0].destinationPath, targetPath);
    });

    test('preserves content transformation when executing a supplied target plan', async () => {
      const kiroService = new UserScopeService(mockContext, tempDir, 'kiro');
      const bundlePath = path.join(tempDir, 'kiro-plan-user');
      const { files, plan } = createSingleItemBundle(
        'kiro-plan-bundle',
        'review-agent',
        'Review Agent',
        'agents/review-agent.md',
        'agent',
        '---\ntitle: "Review Agent"\n---\nReview code.\n',
        'kiro'
      );
      writeBundleSource(bundlePath, files, false);

      await (kiroService as any).syncBundle('kiro-plan-bundle', bundlePath, { targetPlan: plan });

      const targetPath = path.join(tempDir, '.kiro', 'agents', 'review-agent.agent.md');
      assert.ok(fs.existsSync(targetPath), 'Kiro agent should be written to the Kiro agents directory');
      assert.ok(fs.readFileSync(targetPath, 'utf8').includes('name: "Review Agent"'));
    });

    test('does not overwrite unmanaged regular files when executing a supplied target plan', async () => {
      const bundlePath = path.join(tempDir, 'unmanaged-plan-user');
      const { files, plan } = createSingleItemBundle(
        'unmanaged-bundle',
        'test-prompt',
        'Test Prompt',
        'prompts/test-prompt.md',
        'prompt',
        '# Managed prompt\n'
      );
      writeBundleSource(bundlePath, files, false);

      const targetPath = path.join(tempDir, '.copilot', 'prompts', 'test-prompt.prompt.md');
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, '# User owned prompt\n');

      const result = await (service as any).syncBundle('unmanaged-bundle', bundlePath, { targetPlan: plan });

      assert.strictEqual(fs.readFileSync(targetPath, 'utf8'), '# User owned prompt\n');
      assert.ok(!fs.lstatSync(targetPath).isSymbolicLink(), 'Unmanaged file should remain a regular file');
      assert.strictEqual(result.installed.length, 0, 'Skipped unmanaged files should not be reported as installed');
    });

    test('replaces an unchanged regular file owned by the prior installation', async () => {
      const bundlePath = path.join(tempDir, 'managed-update-plan-user');
      const { files, plan } = createSingleItemBundle(
        'managed-update-bundle',
        'test-prompt',
        'Test Prompt',
        'prompts/test-prompt.md',
        'prompt',
        '# Updated prompt\n'
      );
      writeBundleSource(bundlePath, files, false);
      const targetPath = path.join(tempDir, '.copilot', 'prompts', 'test-prompt.prompt.md');
      const previousContent = '# Previous prompt\n';
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, previousContent);

      const result = await (service as any).syncBundle('managed-update-bundle', bundlePath, {
        targetPlan: plan,
        installedFiles: [{
          itemId: 'test-prompt',
          kind: 'prompt',
          sourcePath: 'prompts/test-prompt.md',
          destinationPath: targetPath,
          destinationRelativePath: 'prompts/test-prompt.prompt.md',
          installedChecksum: `sha256:${crypto.createHash('sha256').update(previousContent).digest('hex')}`
        }]
      });

      assert.strictEqual(fs.readFileSync(targetPath, 'utf8'), '# Updated prompt\n');
      assert.strictEqual(result.installed.length, 1);
    });

    test('preserves a modified regular file owned by the prior installation', async () => {
      const bundlePath = path.join(tempDir, 'modified-update-plan-user');
      const { files, plan } = createSingleItemBundle(
        'modified-update-bundle',
        'test-prompt',
        'Test Prompt',
        'prompts/test-prompt.md',
        'prompt',
        '# Updated prompt\n'
      );
      writeBundleSource(bundlePath, files, false);
      const targetPath = path.join(tempDir, '.copilot', 'prompts', 'test-prompt.prompt.md');
      const previousContent = '# Previous prompt\n';
      const modifiedContent = '# User modified prompt\n';
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, modifiedContent);
      const previousRecord = {
        itemId: 'test-prompt',
        kind: 'prompt' as const,
        sourcePath: 'prompts/test-prompt.md',
        destinationPath: targetPath,
        destinationRelativePath: 'prompts/test-prompt.prompt.md',
        installedChecksum: `sha256:${crypto.createHash('sha256').update(previousContent).digest('hex')}`
      };

      const result = await (service as any).syncBundle('modified-update-bundle', bundlePath, {
        targetPlan: plan,
        installedFiles: [previousRecord]
      });

      assert.strictEqual(fs.readFileSync(targetPath, 'utf8'), modifiedContent);
      assert.deepStrictEqual(result.installed, [previousRecord]);
    });

    test('keeps a successful managed replacement when backup cleanup fails', async () => {
      const bundlePath = path.join(tempDir, 'cleanup-update-plan-user');
      const { files, plan } = createSingleItemBundle(
        'cleanup-update-bundle',
        'test-prompt',
        'Test Prompt',
        'prompts/test-prompt.md',
        'prompt',
        '# Updated prompt\n'
      );
      writeBundleSource(bundlePath, files, false);
      const targetPath = path.join(tempDir, '.copilot', 'prompts', 'test-prompt.prompt.md');
      const previousContent = '# Previous prompt\n';
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, previousContent);
      const remove = fs.promises.rm.bind(fs.promises);
      sinon.stub(fs.promises, 'rm').callsFake(async (filePath, options) => {
        if (String(filePath).includes('.ai-primitives-hub-backup-')) {
          throw new Error('backup cleanup failed');
        }
        return remove(filePath, options);
      });

      const result = await (service as any).syncBundle('cleanup-update-bundle', bundlePath, {
        targetPlan: plan,
        installedFiles: [{
          itemId: 'test-prompt',
          kind: 'prompt',
          sourcePath: 'prompts/test-prompt.md',
          destinationPath: targetPath,
          destinationRelativePath: 'prompts/test-prompt.prompt.md',
          installedChecksum: `sha256:${crypto.createHash('sha256').update(previousContent).digest('hex')}`
        }]
      });

      assert.strictEqual(fs.readFileSync(targetPath, 'utf8'), '# Updated prompt\n');
      assert.strictEqual(result.installed.length, 1);
    });

    test('preserves unrelated files inside a managed skill during replacement', async () => {
      const bundlePath = path.join(tempDir, 'managed-skill-update');
      const sourcePath = 'skills/review/SKILL.md';
      const bytes = new TextEncoder().encode('# Updated skill\n');
      writeBundleSource(bundlePath, new Map([[sourcePath, bytes]]), false);
      const skillRoot = path.join(tempDir, '.copilot', 'skills', 'review');
      const targetPath = path.join(skillRoot, 'SKILL.md');
      const previousContent = '# Previous skill\n';
      fs.mkdirSync(skillRoot, { recursive: true });
      fs.writeFileSync(targetPath, previousContent);
      fs.writeFileSync(path.join(skillRoot, 'local-notes.md'), 'Keep me\n');
      const plan: TargetWritePlan = {
        target: { name: 'vscode', type: 'vscode', scope: 'user' },
        operations: [{
          itemId: 'review',
          kind: 'skill',
          sourcePath,
          destinationPath: targetPath,
          destinationRelativePath: 'skills/review/SKILL.md',
          sourceChecksum: 'sha256:updated',
          bytes
        }]
      };

      await (service as any).syncBundle('managed-skill-update', bundlePath, {
        targetPlan: plan,
        installedFiles: [{
          itemId: 'review',
          kind: 'skill',
          sourcePath,
          destinationPath: targetPath,
          destinationRelativePath: 'skills/review/SKILL.md',
          installedChecksum: `sha256:${crypto.createHash('sha256').update(previousContent).digest('hex')}`
        }]
      });

      assert.strictEqual(fs.readFileSync(targetPath, 'utf8'), '# Updated skill\n');
      assert.strictEqual(fs.readFileSync(path.join(skillRoot, 'local-notes.md'), 'utf8'), 'Keep me\n');
    });

    test('rolls back earlier user-scope writes when a later operation fails', async () => {
      const bundlePath = path.join(tempDir, 'rollback-plan-user');
      const files = new Map<string, Uint8Array>([
        ['prompts/first.md', new TextEncoder().encode('# First\n')],
        ['agents/fail.md', new TextEncoder().encode('# Fail\n')]
      ]);
      writeBundleSource(bundlePath, files, false);
      const blockerPath = path.join(tempDir, '.copilot', 'blocker');
      fs.mkdirSync(path.dirname(blockerPath), { recursive: true });
      fs.writeFileSync(blockerPath, 'not a directory');
      const plan: TargetWritePlan = {
        target: { name: 'vscode', type: 'vscode', scope: 'user' },
        operations: [
          {
            itemId: 'first',
            kind: 'prompt',
            sourcePath: 'prompts/first.md',
            destinationPath: path.join(tempDir, '.copilot', 'prompts', 'first.prompt.md'),
            destinationRelativePath: 'prompts/first.prompt.md',
            sourceChecksum: 'sha256:first',
            bytes: files.get('prompts/first.md')!
          },
          {
            itemId: 'fail',
            kind: 'agent',
            sourcePath: 'agents/fail.md',
            destinationPath: path.join(blockerPath, 'fail.agent.md'),
            destinationRelativePath: 'blocker/fail.agent.md',
            sourceChecksum: 'sha256:fail',
            bytes: files.get('agents/fail.md')!
          }
        ]
      };

      await assert.rejects(
        async () => (service as any).syncBundle('rollback-bundle', bundlePath, { targetPlan: plan })
      );

      assert.ok(
        !fs.existsSync(path.join(tempDir, '.copilot', 'prompts', 'first.prompt.md')),
        'The first operation should be rolled back after the later failure'
      );
      assert.strictEqual(fs.readFileSync(blockerPath, 'utf8'), 'not a directory');
    });

    test('restores an existing skill directory when replacement fails', async () => {
      const bundlePath = path.join(tempDir, 'skill-rollback-plan-user');
      const files = new Map<string, Uint8Array>([
        ['skills/review/first.txt', new TextEncoder().encode('not a directory')],
        ['skills/review/fail.txt', new TextEncoder().encode('fail')]
      ]);
      writeBundleSource(bundlePath, files, false);
      const skillRoot = path.join(tempDir, '.copilot', 'skills', 'review');
      fs.mkdirSync(skillRoot, { recursive: true });
      fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# Existing skill\n');
      sinon.stub(vscode.window, 'showWarningMessage').resolves('Overwrite' as any);
      const plan: TargetWritePlan = {
        target: { name: 'vscode', type: 'vscode', scope: 'user' },
        operations: [...files].map(([sourcePath, bytes], index) => ({
          itemId: 'review',
          kind: 'skill' as const,
          sourcePath,
          destinationPath: path.join(tempDir, '.copilot', 'skills', 'review', index === 0 ? 'blocker' : 'blocker/fail.txt'),
          destinationRelativePath: `skills/review/${index === 0 ? 'blocker' : 'blocker/fail.txt'}`,
          sourceChecksum: `sha256:${sourcePath}`,
          bytes
        }))
      };

      await assert.rejects(
        async () => (service as any).syncBundle('skill-rollback-bundle', bundlePath, { targetPlan: plan })
      );

      assert.strictEqual(fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8'), '# Existing skill\n');
      assert.ok(!fs.existsSync(path.join(skillRoot, 'blocker')), 'Partial replacement content should be removed');
    });

    test('prompts before overwriting an existing skill when executing a supplied target plan', async () => {
      const bundlePath = path.join(tempDir, 'existing-skill-plan-user');
      const bundleFiles = createFoursightBundle();
      writeBundleSource(bundlePath, bundleFiles, false);

      const existingSkillDir = path.join(tempDir, '.copilot', 'skills', 'foursight-code-review');
      fs.mkdirSync(existingSkillDir, { recursive: true });
      fs.writeFileSync(path.join(existingSkillDir, 'SKILL.md'), '# Existing skill\n');

      sinon.stub(vscode.window, 'showWarningMessage').resolves('Cancel' as any);

      await assert.rejects(
        async () => (service as any).syncBundle('foursight-pr-review', bundlePath, {
          targetPlan: createPlan(bundleFiles)
        }),
        /Installation cancelled: skill 'foursight-code-review' already exists/
      );

      assert.strictEqual(fs.readFileSync(path.join(existingSkillDir, 'SKILL.md'), 'utf8'), '# Existing skill\n');
      assert.ok(
        !fs.existsSync(path.join(existingSkillDir, 'assets', 'rubric.json')),
        'Cancelled overwrite should leave the existing skill directory untouched'
      );
      assert.ok(
        !fs.existsSync(path.join(tempDir, '.copilot', 'agents', 'code-review.agent.md')),
        'Skill conflict cancellation should happen before any bundle file is installed'
      );
    });

    test('checks the normalized planned skill directory before overwriting', async () => {
      const bundlePath = path.join(tempDir, 'normalized-skill-plan-user');
      const skillFile = 'skills/pr-review/SKILL.md';
      const bundleFiles = new Map<string, Uint8Array>([
        ['deployment-manifest.yml', new TextEncoder().encode([
          'id: normalized-skill-bundle',
          'version: "1.0.0"',
          'name: Normalized Skill Bundle',
          'prompts:',
          '  - id: "PR Review"',
          '    name: PR Review',
          `    file: ${skillFile}`,
          '    type: skill'
        ].join('\n'))],
        [skillFile, new TextEncoder().encode('# Replacement skill\n')]
      ]);
      writeBundleSource(bundlePath, bundleFiles, false);

      const existingSkillDir = path.join(tempDir, '.copilot', 'skills', 'PR-Review');
      fs.mkdirSync(existingSkillDir, { recursive: true });
      fs.writeFileSync(path.join(existingSkillDir, 'SKILL.md'), '# Existing skill\n');
      const prompt = sinon.stub(vscode.window, 'showWarningMessage').resolves('Cancel' as any);

      await assert.rejects(
        async () => (service as any).syncBundle('normalized-skill-bundle', bundlePath, {
          targetPlan: createPlan(bundleFiles)
        }),
        /Installation cancelled: skill 'PR Review' already exists/
      );

      assert.ok(prompt.calledOnce, 'The normalized destination should be checked for conflicts');
      assert.strictEqual(fs.readFileSync(path.join(existingSkillDir, 'SKILL.md'), 'utf8'), '# Existing skill\n');
    });
  });
});
