import * as assert from 'node:assert';
import {
  getTargetCapability,
  supportsTargetResource,
} from '../../src/services/target-capability-registry';
import type {
  TargetType,
} from '../../src/types/target';

suite('Target capability registry', () => {
  suite('VS Code capabilities', () => {
    test('vscode supports prompt, instruction, agent, and skill in both scopes', () => {
      assert.strictEqual(supportsTargetResource('vscode', 'user', 'prompt'), true);
      assert.strictEqual(supportsTargetResource('vscode', 'user', 'instruction'), true);
      assert.strictEqual(supportsTargetResource('vscode', 'user', 'agent'), true);
      assert.strictEqual(supportsTargetResource('vscode', 'user', 'skill'), true);
      assert.strictEqual(supportsTargetResource('vscode', 'repository', 'prompt'), true);
      assert.strictEqual(supportsTargetResource('vscode', 'repository', 'instruction'), true);
      assert.strictEqual(supportsTargetResource('vscode', 'repository', 'agent'), true);
      assert.strictEqual(supportsTargetResource('vscode', 'repository', 'skill'), true);
    });

    test('vscode-insiders has the same capabilities as vscode', () => {
      const vscode = getTargetCapability('vscode');
      const insiders = getTargetCapability('vscode-insiders');

      assert.ok(vscode);
      assert.ok(insiders);
      assert.deepStrictEqual(insiders.supportedScopes, vscode.supportedScopes);
      assert.deepStrictEqual(insiders.supportedResources, vscode.supportedResources);
    });
  });

  suite('Kiro capabilities', () => {
    test('kiro supports only prompt and skill', () => {
      assert.strictEqual(supportsTargetResource('kiro', 'user', 'prompt'), true);
      assert.strictEqual(supportsTargetResource('kiro', 'user', 'skill'), true);
      assert.strictEqual(supportsTargetResource('kiro', 'repository', 'prompt'), true);
      assert.strictEqual(supportsTargetResource('kiro', 'repository', 'skill'), true);
    });

    test('kiro does not support instruction or agent resources', () => {
      assert.strictEqual(supportsTargetResource('kiro', 'user', 'instruction'), false);
      assert.strictEqual(supportsTargetResource('kiro', 'user', 'agent'), false);
      assert.strictEqual(supportsTargetResource('kiro', 'repository', 'instruction'), false);
      assert.strictEqual(supportsTargetResource('kiro', 'repository', 'agent'), false);
    });
  });

  suite('unsupported target types', () => {
    const unsupportedTypes: TargetType[] = ['copilot-cli', 'windsurf', 'claude-code'];

    for (const targetType of unsupportedTypes) {
      test(`${targetType} has no declared capabilities`, () => {
        const capability = getTargetCapability(targetType);
        assert.strictEqual(capability, undefined);
      });

      test(`${targetType} does not support any resource in any scope`, () => {
        assert.strictEqual(supportsTargetResource(targetType, 'user', 'prompt'), false);
        assert.strictEqual(supportsTargetResource(targetType, 'repository', 'prompt'), false);
        assert.strictEqual(supportsTargetResource(targetType, 'user', 'skill'), false);
        assert.strictEqual(supportsTargetResource(targetType, 'repository', 'skill'), false);
      });
    }
  });
});
