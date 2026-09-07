import * as assert from 'node:assert';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  UserScopeService,
} from '../../src/services/user-scope-service';

suite('UserScopeService - Unsync Bundle Fix', () => {
  let tempDir: string;
  let bundlesDir: string;
  let copilotDir: string;
  let context: vscode.ExtensionContext;
  let service: UserScopeService;

  setup(() => {
    // Create temp directory structure
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-sync-test-'));

    // Mock a realistic structure: .../User/globalStorage/prompt-registry
    const userDir = path.join(tempDir, 'User');
    const globalStorageDir = path.join(userDir, 'globalStorage', 'prompt-registry');

    bundlesDir = path.join(globalStorageDir, 'bundles');
    // Default prompts dir is .../.copilot/prompts
    copilotDir = path.join(tempDir, '.copilot', 'prompts');

    fs.mkdirSync(bundlesDir, { recursive: true });
    fs.mkdirSync(copilotDir, { recursive: true });

    // Mock context
    context = {
      globalStorageUri: { fsPath: globalStorageDir },
      storageUri: { fsPath: tempDir },
      extensionPath: __dirname,
      subscriptions: []
    } as any;

    service = new UserScopeService(context, tempDir);
  });

  teardown(() => {
    // Cleanup
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {
      console.error('Cleanup failed:', e);
    }
  });

  const checksum = (contents: string): string =>
    `sha256:${crypto.createHash('sha256').update(contents).digest('hex')}`;

  test('uses persisted installed records when the bundle cache has already been deleted', async () => {
    const bundleId = 'test-bundle-installed-records';
    const bundlePath = path.join(bundlesDir, bundleId);
    fs.mkdirSync(bundlePath, { recursive: true });

    const linkedSourcePath = path.join(bundlePath, 'linked.prompt.md');
    const copiedSourcePath = path.join(bundlePath, 'copied.prompt.md');
    const modifiedSourcePath = path.join(bundlePath, 'modified.prompt.md');

    const linkedTargetPath = path.join(copilotDir, 'linked.prompt.md');
    const copiedTargetPath = path.join(copilotDir, 'copied.prompt.md');
    const modifiedTargetPath = path.join(copilotDir, 'modified.prompt.md');

    fs.writeFileSync(linkedSourcePath, '# Linked prompt');
    fs.writeFileSync(copiedSourcePath, '# Copied prompt');
    fs.writeFileSync(modifiedSourcePath, '# Original prompt');

    fs.symlinkSync(linkedSourcePath, linkedTargetPath);
    fs.writeFileSync(copiedTargetPath, '# Copied prompt');
    fs.writeFileSync(modifiedTargetPath, '# User modified prompt');

    const installedFiles = [
      {
        itemId: 'linked',
        kind: 'prompt' as const,
        sourcePath: 'linked.prompt.md',
        destinationPath: linkedTargetPath,
        destinationRelativePath: 'prompts/linked.prompt.md',
        installedChecksum: checksum('# Linked prompt')
      },
      {
        itemId: 'copied',
        kind: 'prompt' as const,
        sourcePath: 'copied.prompt.md',
        destinationPath: copiedTargetPath,
        destinationRelativePath: 'prompts/copied.prompt.md',
        installedChecksum: checksum('# Copied prompt')
      },
      {
        itemId: 'modified',
        kind: 'prompt' as const,
        sourcePath: 'modified.prompt.md',
        destinationPath: modifiedTargetPath,
        destinationRelativePath: 'prompts/modified.prompt.md',
        installedChecksum: checksum('# Original prompt')
      }
    ];

    fs.rmSync(bundlePath, { recursive: true, force: true });

    const result = await service.unsyncBundle(bundleId, { installedFiles });

    assert.strictEqual(fs.existsSync(linkedTargetPath), false, 'Broken symlink should be removed using the persisted record');
    assert.strictEqual(fs.existsSync(copiedTargetPath), false, 'Unmodified copied file should be removed using the persisted record');
    assert.strictEqual(fs.existsSync(modifiedTargetPath), true, 'Modified copied file should be preserved');
    assert.deepStrictEqual(result.retained, [installedFiles[2]], 'Modified files should retain their ownership metadata');
  });

  test('prunes removed skill ancestors while preserving a retained nested file', async () => {
    const bundleId = 'skill-records';
    const skillRoot = path.join(tempDir, '.copilot', 'skills', 'review');
    const skillPath = path.join(skillRoot, 'SKILL.md');
    const assetPath = path.join(skillRoot, 'assets', 'rubric.json');
    const retainedPath = path.join(skillRoot, 'scripts', 'check.sh');
    fs.mkdirSync(path.dirname(assetPath), { recursive: true });
    fs.mkdirSync(path.dirname(retainedPath), { recursive: true });
    fs.writeFileSync(skillPath, '# Review');
    fs.writeFileSync(assetPath, '{}');
    fs.writeFileSync(retainedPath, 'user edit');
    const installedFiles = [
      {
        itemId: 'review',
        kind: 'skill' as const,
        sourcePath: 'skills/review/SKILL.md',
        destinationPath: skillPath,
        destinationRelativePath: 'skills/review/SKILL.md',
        installedChecksum: checksum('# Review')
      },
      {
        itemId: 'review',
        kind: 'skill' as const,
        sourcePath: 'skills/review/assets/rubric.json',
        destinationPath: assetPath,
        destinationRelativePath: 'skills/review/assets/rubric.json',
        installedChecksum: checksum('{}')
      },
      {
        itemId: 'review',
        kind: 'skill' as const,
        sourcePath: 'skills/review/scripts/check.sh',
        destinationPath: retainedPath,
        destinationRelativePath: 'skills/review/scripts/check.sh',
        installedChecksum: checksum('original script')
      }
    ];

    const result = await service.unsyncBundle(bundleId, { installedFiles });

    assert.ok(!fs.existsSync(path.join(skillRoot, 'assets')), 'Empty removed-file ancestors should be pruned');
    assert.ok(fs.existsSync(retainedPath), 'Modified nested content should remain');
    assert.deepStrictEqual(result.retained, [installedFiles[2]]);
  });

  test('should delete copied file (not symlink) if content matches source', async () => {
    const bundleId = 'test-bundle';
    const bundlePath = path.join(bundlesDir, bundleId);

    // 1. Create bundle with manifest and prompt
    fs.mkdirSync(bundlePath, { recursive: true });

    const promptContent = '# Test Prompt\nThis is a test prompt.';
    const promptFile = 'test.prompt.md';

    fs.writeFileSync(path.join(bundlePath, promptFile), promptContent);

    const manifest = {
      id: bundleId,
      version: '1.0.0',
      name: 'Test Bundle',
      prompts: [
        {
          id: 'test-prompt',
          name: 'Test Prompt',
          file: promptFile,
          type: 'prompt'
        }
      ]
    };

    fs.writeFileSync(
      path.join(bundlePath, 'deployment-manifest.yml'),
      JSON.stringify(manifest) // JSON is valid YAML
    );

    // 2. Simulate "copied" file in Copilot directory (as happens in WSL fallback)
    // Target filename format: id.type.md
    const targetFile = path.join(copilotDir, 'test-prompt.prompt.md');
    fs.writeFileSync(targetFile, promptContent); // Same content

    // Verify setup
    assert.ok(fs.existsSync(targetFile), 'Target file should exist');
    assert.strictEqual(fs.lstatSync(targetFile).isSymbolicLink(), false, 'Target file should NOT be a symlink');

    // 3. Run unsyncBundle
    await service.unsyncBundle(bundleId);

    // 4. Verify deletion
    assert.strictEqual(fs.existsSync(targetFile), false, 'Target file should be deleted because content matched');
  });

  test('should NOT delete copied file if content differs', async () => {
    const bundleId = 'test-bundle-diff';
    const bundlePath = path.join(bundlesDir, bundleId);

    // 1. Create bundle with manifest and prompt
    fs.mkdirSync(bundlePath, { recursive: true });

    const promptContent = '# Original Prompt';
    const promptFile = 'test.prompt.md';

    fs.writeFileSync(path.join(bundlePath, promptFile), promptContent);

    const manifest = {
      id: bundleId,
      version: '1.0.0',
      name: 'Test Bundle Diff',
      prompts: [
        {
          id: 'test-prompt-diff',
          name: 'Test Prompt Diff',
          file: promptFile,
          type: 'prompt'
        }
      ]
    };

    fs.writeFileSync(
      path.join(bundlePath, 'deployment-manifest.yml'),
      JSON.stringify(manifest)
    );

    // 2. Simulate "modified" file in Copilot directory
    const targetFile = path.join(copilotDir, 'test-prompt-diff.prompt.md');
    const modifiedContent = '# Modified Prompt\nUser changed this.';
    fs.writeFileSync(targetFile, modifiedContent); // Different content

    // Verify setup
    assert.ok(fs.existsSync(targetFile), 'Target file should exist');
    assert.strictEqual(fs.lstatSync(targetFile).isSymbolicLink(), false, 'Target file should NOT be a symlink');

    // 3. Run unsyncBundle
    await service.unsyncBundle(bundleId);

    // 4. Verify persistence
    assert.ok(fs.existsSync(targetFile), 'Target file should NOT be deleted because content differed');
  });

  test('should handle line ending differences (CRLF vs LF)', async () => {
    const bundleId = 'test-bundle-crlf';
    const bundlePath = path.join(bundlesDir, bundleId);

    // 1. Create bundle with manifest and prompt (using LF)
    fs.mkdirSync(bundlePath, { recursive: true });

    const promptContentLF = '# Test Prompt\nLine 2\nLine 3';
    const promptFile = 'test.prompt.md';

    fs.writeFileSync(path.join(bundlePath, promptFile), promptContentLF);

    const manifest = {
      id: bundleId,
      version: '1.0.0',
      name: 'Test Bundle CRLF',
      prompts: [
        {
          id: 'test-prompt-crlf',
          name: 'Test Prompt CRLF',
          file: promptFile,
          type: 'prompt'
        }
      ]
    };

    fs.writeFileSync(
      path.join(bundlePath, 'deployment-manifest.yml'),
      JSON.stringify(manifest)
    );

    // 2. Simulate file with CRLF in Copilot directory
    const targetFile = path.join(copilotDir, 'test-prompt-crlf.prompt.md');
    const promptContentCRLF = '# Test Prompt\r\nLine 2\r\nLine 3';
    fs.writeFileSync(targetFile, promptContentCRLF);

    // Verify setup
    assert.ok(fs.existsSync(targetFile), 'Target file should exist');

    // 3. Run unsyncBundle
    await service.unsyncBundle(bundleId);

    // 4. Verify deletion (normalization should handle it)
    assert.strictEqual(fs.existsSync(targetFile), false, 'Target file should be deleted despite line ending differences');
  });
});
