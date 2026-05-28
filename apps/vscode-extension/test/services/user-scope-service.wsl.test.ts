/**
 * UserScopeService WSL Support Tests
 * Tests WSL-specific path resolution and remote environment handling
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  UserScopeService,
} from '../../src/services/user-scope-service';
import {
  createMockBundleDirectory,
} from '../helpers/bundle-test-helpers';

suite('UserScopeService - WSL Support', () => {
  // Use require() instead of import * — Node's cached module object has writable
  // properties, whereas ES module namespace objects do not (non-configurable).
  const childProcess = require('node:child_process');
  let sandbox: sinon.SinonSandbox;
  let tempDir: string;

  setup(() => {
    sandbox = sinon.createSandbox();
    tempDir = path.join(__dirname, '..', '..', '..', 'test-temp-wsl');

    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
  });

  teardown(() => {
    sandbox.restore();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const createMockContext = (globalStoragePath: string): any => ({
    globalStorageUri: { fsPath: globalStoragePath },
    storageUri: { fsPath: '/home/testuser/workspace' },
    extensionPath: __dirname,
    subscriptions: []
  });

  /**
   * Sync a probe bundle and return the prompts directory where the file landed.
   * Uses the shared createMockBundleDirectory helper, then exercises syncBundle
   * to discover the resolved path.
   * @param service
   * @param parentDir
   */
  const getResolvedPromptsDir = async (service: UserScopeService, parentDir: string): Promise<string> => {
    const bundleId = 'probe-bundle';
    const bundlePath = createMockBundleDirectory({
      basePath: path.join(parentDir, 'bundles'),
      bundleId
    });
    await service.syncBundle(bundleId, bundlePath);
    const targetFileName = 'test-prompt.prompt.md';
    const found = findFile(tempDir, targetFileName);
    assert.ok(found, `Expected to find ${targetFileName} under ${tempDir}`);
    return path.dirname(found);
  };

  /**
   * Recursively find a file by name under a directory.
   * @param dir
   * @param name
   */
  const findFile = (dir: string, name: string): string | undefined => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const result = findFile(fullPath, name);
        if (result) {
          return result;
        }
      } else if (entry.name === name) {
        return fullPath;
      }
    }
    return undefined;
  };

  const stubWSLEnvironment = (
    windowsHomePath: string,
    uriScheme = 'vscode'
  ): void => {
    sandbox.stub(vscode.env, 'remoteName').value('wsl');
    sandbox.stub(vscode.env, 'uriScheme').value(uriScheme);
    // Production code calls .trim() on the result, so include trailing newline
    sandbox.stub(childProcess, 'execSync').returns(windowsHomePath + '\n');
  };

  suite('Path Resolution (via wslpath)', () => {
    test('should construct Windows prompts dir from wslpath output', async () => {
      const windowsHome = path.join(tempDir, 'mnt', 'c', 'Users', 'testuser');
      const globalStorage = path.join(tempDir, 'wsl-home');
      stubWSLEnvironment(windowsHome, 'vscode');
      const mockContext = createMockContext(globalStorage);
      const service = new UserScopeService(mockContext);
      const promptsDir = await getResolvedPromptsDir(service, globalStorage);

      assert.strictEqual(promptsDir, path.join(windowsHome, 'AppData', 'Roaming', 'Code', 'User', 'prompts'));
    });

    const uriSchemeCases: Map<string, string> = new Map([
      ['vscode', 'Code'],
      ['vscode-insiders', 'Code - Insiders']
    ]);

    uriSchemeCases.forEach((expectedFolder, uriScheme) => {
      test(`should map uriScheme '${uriScheme}' to folder '${expectedFolder}'`, async () => {
        const windowsHome = path.join(tempDir, 'mnt', 'c', 'Users', 'testuser');
        const globalStorage = path.join(tempDir, 'wsl-home');
        stubWSLEnvironment(windowsHome, uriScheme);
        const mockContext = createMockContext(globalStorage);
        const service = new UserScopeService(mockContext);
        const promptsDir = await getResolvedPromptsDir(service, globalStorage);

        assert.ok(promptsDir.includes(expectedFolder));
      });
    });

    test('should fall back to Code when uriScheme is unknown', async () => {
      const windowsHome = path.join(tempDir, 'mnt', 'c', 'Users', 'testuser');
      const globalStorage = path.join(tempDir, 'wsl-home');
      stubWSLEnvironment(windowsHome, 'unknown-ide');
      const mockContext = createMockContext(globalStorage);
      const service = new UserScopeService(mockContext);
      const promptsDir = await getResolvedPromptsDir(service, globalStorage);

      assert.ok(promptsDir.includes('/Code/'), `Expected path to include '/Code/' but got: ${promptsDir}`);
      assert.ok(!promptsDir.includes('Insiders'), `Expected path to NOT include 'Insiders' but got: ${promptsDir}`);
    });

    test('should fall through to globalStorageUri parsing when wslpath fails', async () => {
      sandbox.stub(childProcess, 'execSync').throws(new Error('cmd.exe not found'));
      sandbox.stub(vscode.env, 'remoteName').value('wsl');
      const showWarningStub = sandbox.stub(vscode.window, 'showWarningMessage');
      const globalStorage = path.join(tempDir, 'data', 'User', 'globalStorage');
      const mockContext = createMockContext(globalStorage);
      const service = new UserScopeService(mockContext);
      const promptsDir = await getResolvedPromptsDir(service, globalStorage);

      assert.ok(promptsDir.endsWith(path.join('User', 'prompts')));
      assert.ok(showWarningStub.calledOnce, 'Expected a warning message when WSL path resolution fails');
      assert.ok(
        showWarningStub.firstCall.args[0].includes('Unable to resolve Windows path from WSL'),
        'Warning message should mention WSL path resolution failure'
      );
    });
  });

  suite('File Operations', () => {
    test('should create copies (not symlinks) when syncing in WSL', async () => {
      const windowsUserDir = path.join(tempDir, 'Users', 'testuser');
      const wslUserDir = path.join(tempDir, 'home', 'testuser');
      stubWSLEnvironment(windowsUserDir, 'vscode');

      const bundleId = 'test-bundle';
      const bundlePath = path.join(wslUserDir, 'bundles', bundleId);
      fs.mkdirSync(path.join(bundlePath, 'prompts'), { recursive: true });

      const promptContent = 'My insanely good prompt. Hey AI, praise my exceeding intelligence ( Natural btw ) XD';
      fs.writeFileSync(path.join(bundlePath, 'prompts', 'my-prompt.md'), promptContent);
      fs.writeFileSync(path.join(bundlePath, 'deployment-manifest.yml'), [
        `id: ${bundleId}`,
        'version: "1.0.0"',
        'name: Test Bundle',
        'prompts:',
        '  - id: my-prompt',
        '    name: My Prompt',
        '    file: prompts/my-prompt.md'
      ].join('\n'));

      const mockContext = createMockContext(wslUserDir);
      const service = new UserScopeService(mockContext);
      await service.syncBundle(bundleId, bundlePath);

      const targetFile = path.join(windowsUserDir, 'AppData', 'Roaming', 'Code', 'User', 'prompts', 'my-prompt.prompt.md');
      assert.ok(fs.existsSync(targetFile), 'Target file should exist');
      assert.ok(!fs.lstatSync(targetFile).isSymbolicLink(), 'Target should be a regular file, not a symlink');
      assert.strictEqual(fs.readFileSync(targetFile, 'utf8'), promptContent);
    });

    test('should delete copied file during unsync when content matches (CRLF-normalized)', async () => {
      const windowsUserDir = path.join(tempDir, 'Users', 'testuser');
      const globalStorageDir = path.join(tempDir, 'home', 'testuser');
      stubWSLEnvironment(windowsUserDir, 'vscode');

      const bundleId = 'test-bundle';
      const bundlePath = path.join(globalStorageDir, 'bundles', bundleId);
      fs.mkdirSync(path.join(bundlePath, 'prompts'), { recursive: true });

      const promptContent = 'Line one\nLine two\nLine three';
      fs.writeFileSync(path.join(bundlePath, 'prompts', 'my-prompt.md'), promptContent);
      fs.writeFileSync(path.join(bundlePath, 'deployment-manifest.yml'), [
        `id: ${bundleId}`,
        'version: "1.0.0"',
        'name: Test Bundle',
        'prompts:',
        '  - id: my-prompt',
        '    name: My Prompt',
        '    file: prompts/my-prompt.md',
        '    type: prompt'
      ].join('\n'));

      const mockContext = createMockContext(globalStorageDir);
      const service = new UserScopeService(mockContext);

      await service.syncBundle(bundleId, bundlePath);

      const targetFile = path.join(windowsUserDir, 'AppData', 'Roaming', 'Code', 'User', 'prompts', 'my-prompt.prompt.md');
      assert.ok(fs.existsSync(targetFile), 'File should exist after sync');

      // Simulate Windows converting LF → CRLF
      const content = fs.readFileSync(targetFile, 'utf8');
      fs.writeFileSync(targetFile, content.replace(/\n/g, '\r\n'), 'utf8');

      assert.notStrictEqual(
        fs.readFileSync(targetFile, 'utf8'),
        promptContent,
        'CRLF content should differ from original LF content'
      );

      await service.unsyncBundle(bundleId);

      assert.ok(
        !fs.existsSync(targetFile),
        'File should be deleted after unsync even with CRLF line endings'
      );
    });
  });

  suite('Negative Cases', () => {
    test('should NOT activate WSL mode when remoteName is undefined (local)', async () => {
      sandbox.stub(vscode.env, 'remoteName').value(undefined);

      const globalStorage = path.join(tempDir, 'Code', 'User', 'globalStorage', 'pub.ext');
      const mockContext = createMockContext(globalStorage);
      const service = new UserScopeService(mockContext);
      const promptsDir = await getResolvedPromptsDir(service, globalStorage);

      assert.ok(!promptsDir.includes('/mnt/'), `Local should not use WSL mount, got: ${promptsDir}`);
      assert.ok(promptsDir.endsWith('prompts'), `Should end with prompts, got: ${promptsDir}`);
    });

    test('should NOT activate WSL mode when remoteName is ssh-remote', async () => {
      sandbox.stub(vscode.env, 'remoteName').value('ssh-remote');

      const globalStorage = path.join(tempDir, 'data', 'User', 'globalStorage', 'pub.ext');
      const mockContext = createMockContext(globalStorage);
      const service = new UserScopeService(mockContext);
      const promptsDir = await getResolvedPromptsDir(service, globalStorage);

      assert.ok(!promptsDir.includes('/mnt/'), `SSH should not use WSL mount, got: ${promptsDir}`);
      assert.strictEqual(promptsDir, path.join(tempDir, 'data', 'User', 'prompts'));
    });

    test('should NOT activate WSL mode when remoteName is tunnel', async () => {
      sandbox.stub(vscode.env, 'remoteName').value('tunnel');

      const globalStorage = path.join(tempDir, 'data', 'User', 'globalStorage', 'pub.ext');
      const mockContext = createMockContext(globalStorage);
      const service = new UserScopeService(mockContext);
      const promptsDir = await getResolvedPromptsDir(service, globalStorage);

      assert.ok(!promptsDir.includes('/mnt/'), `Tunnel should not use WSL mount, got: ${promptsDir}`);
      assert.ok(promptsDir.endsWith('prompts'));
    });

    test('should gracefully handle missing cmd.exe in WSL (no crash)', async () => {
      sandbox.stub(vscode.env, 'remoteName').value('wsl');
      sandbox.stub(childProcess, 'execSync').throws(new Error('cmd.exe not found'));

      const globalStorage = path.join(tempDir, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'pub.ext');
      const mockContext = createMockContext(globalStorage);
      const service = new UserScopeService(mockContext);
      const promptsDir = await getResolvedPromptsDir(service, globalStorage);

      assert.ok(typeof promptsDir === 'string', 'Should return a valid string path');
      assert.ok(promptsDir.length > 0, 'Path should not be empty');
      assert.ok(promptsDir.endsWith('prompts'), 'Should still resolve to a prompts directory');
    });
  });
});
