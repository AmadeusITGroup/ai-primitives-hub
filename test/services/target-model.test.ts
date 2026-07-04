import * as assert from 'node:assert';
import {
  isResourceKind,
  isTargetScope,
  isTargetType,
  RESOURCE_KINDS,
  TARGET_SCOPES,
  TARGET_TYPES,
  validateTargetCapability,
  validateTargetLayout,
} from '../../src/types/target';
import type {
  InstallOperation,
  Resource,
  ResourceTransformer,
  Target,
} from '../../src/types/target';

suite('TargetModel', () => {
  suite('target type validation', () => {
    test('recognizes supported target types', () => {
      assert.deepStrictEqual(TARGET_TYPES, [
        'vscode',
        'vscode-insiders',
        'copilot-cli',
        'kiro',
        'windsurf',
        'claude-code'
      ]);

      for (const targetType of TARGET_TYPES) {
        assert.strictEqual(isTargetType(targetType), true);
      }

      assert.strictEqual(isTargetType('unknown-ide'), false);
    });
  });

  suite('scope validation', () => {
    test('recognizes only user and repository target scopes', () => {
      assert.deepStrictEqual(TARGET_SCOPES, ['user', 'repository']);
      assert.strictEqual(isTargetScope('user'), true);
      assert.strictEqual(isTargetScope('repository'), true);
      assert.strictEqual(isTargetScope('workspace'), false);
    });
  });

  suite('resource validation', () => {
    test('recognizes installable primitive resource kinds', () => {
      assert.deepStrictEqual(RESOURCE_KINDS, ['prompt', 'instruction', 'agent', 'skill']);

      for (const resourceKind of RESOURCE_KINDS) {
        assert.strictEqual(isResourceKind(resourceKind), true);
      }

      assert.strictEqual(isResourceKind('manifest'), false);
    });
  });

  suite('capability validation', () => {
    test('rejects capabilities that support resources without any scope', () => {
      const result = validateTargetCapability({
        targetType: 'kiro',
        supportedScopes: [],
        supportedResources: ['prompt']
      });

      assert.strictEqual(result.valid, false);
      assert.deepStrictEqual(result.errors, ['Target capability must support at least one scope']);
    });

    test('rejects unsupported resource declarations', () => {
      const result = validateTargetCapability({
        targetType: 'vscode',
        supportedScopes: ['user'],
        supportedResources: ['prompt', 'manifest' as never]
      });

      assert.strictEqual(result.valid, false);
      assert.deepStrictEqual(result.errors, ['Unsupported resource kind: manifest']);
    });
  });

  suite('layout validation', () => {
    test('requires routes for every supported resource kind', () => {
      const result = validateTargetLayout({
        targetType: 'vscode',
        scope: 'repository',
        basePath: '${workspaceRoot}',
        routes: {
          prompt: '.github/prompts',
          instruction: '.github/instructions',
          agent: '.github/agents'
        }
      });

      assert.strictEqual(result.valid, false);
      assert.deepStrictEqual(result.errors, ['Missing route for resource kind: skill']);
    });

    test('accepts a complete repository layout', () => {
      const result = validateTargetLayout({
        targetType: 'vscode',
        scope: 'repository',
        basePath: '${workspaceRoot}',
        routes: {
          prompt: '.github/prompts',
          instruction: '.github/instructions',
          agent: '.github/agents',
          skill: '.github/skills'
        }
      });

      assert.strictEqual(result.valid, true);
      assert.deepStrictEqual(result.errors, []);
    });
  });

  suite('shared operation contracts', () => {
    test('models target, resource, transformer, and install operation contracts', async () => {
      const target: Target = {
        type: 'vscode',
        scope: 'repository'
      };
      const resource: Resource = {
        kind: 'prompt',
        id: 'review',
        sourcePath: 'prompts/review.prompt.md',
        content: '# Review\n'
      };
      const transformer: ResourceTransformer = {
        transform: async (input) => ({
          resource: input,
          diagnostics: []
        })
      };
      const operation: InstallOperation = {
        target,
        resources: [resource],
        layout: {
          targetType: 'vscode',
          scope: 'repository',
          basePath: '${workspaceRoot}',
          routes: {
            prompt: '.github/prompts',
            instruction: '.github/instructions',
            agent: '.github/agents',
            skill: '.github/skills'
          }
        }
      };

      const result = await transformer.transform(operation.resources[0], operation.target);

      assert.strictEqual(operation.target.type, 'vscode');
      assert.deepStrictEqual(result, {
        resource,
        diagnostics: []
      });
    });
  });
});