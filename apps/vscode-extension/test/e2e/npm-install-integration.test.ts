/**
 * Npm Install Integration Tests
 *
 * Integration tests for the npm install flow after scaffolding.
 *
 * NOTE: The npm install prompt is handled in ScaffoldCommand.handlePostScaffoldActions(),
 * which is called from runWithUI(), not from execute() directly.
 * These tests verify the NpmCliWrapper.promptAndInstall() functionality.
 *
 * Feature: workflow-bundle-scaffolding
 * Requirements: 13.1, 13.2, 13.3
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  NpmCliWrapper,
} from '../../src/utils/npm-cli-wrapper';

suite('E2E: Npm Install Integration Tests', () => {
  let testDir: string;
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    // Create unique temp directory for each test
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-install-e2e-'));
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    sandbox.restore();
  });

  suite('NpmCliWrapper.installWithProgress()', () => {
    /**
     * Test: installWithProgress() executes npm install command
     * Requirements: 13.2, 13.3 - Execute npm install with visible output
     */
    test('E2E: installWithProgress() attempts to run npm install', async function () {
      this.timeout(30_000);

      // Create a package.json in the test directory
      fs.writeFileSync(path.join(testDir, 'package.json'), JSON.stringify({ name: 'test' }));

      // Mock child_process.spawn to prevent actual npm execution
      const childProcess = require('node:child_process');
      const spawnStub = sandbox.stub(childProcess, 'spawn').callsFake((..._spawnArgs: any[]) => {
        const mockProcess = {
          on: (event: string, callback: (...args: unknown[]) => void) => {
            if (event === 'close') {
              setTimeout(() => callback(0), 10);
            }
            return mockProcess;
          },
          kill: sandbox.stub(),
          stderr: { on: sandbox.stub() },
          stdout: { on: sandbox.stub() }
        };
        return mockProcess;
      });

      // Mock VS Code withProgress
      sandbox.stub(vscode.window, 'withProgress')
        .callsFake((_options: any, task: (progress: any, token: any) => PromiseLike<unknown>) => {
          const progress = { report: sandbox.stub() };
          const token = {
            isCancellationRequested: false,
            onCancellationRequested: sandbox.stub()
          };
          return task(progress, token);
        });

      const npmWrapper = NpmCliWrapper.getInstance();
      await npmWrapper.installWithProgress(testDir);

      assert.ok(spawnStub.called, 'Should attempt to spawn npm process');
    });
  });
});
