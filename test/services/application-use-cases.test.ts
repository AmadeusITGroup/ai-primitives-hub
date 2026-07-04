import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createApplicationUseCases,
} from '../../src/services/application-use-cases';
import type {
  ApplicationBundle,
} from '../../src/services/application-use-cases';

suite('ApplicationUseCases', () => {
  let tempRoot: string;

  setup(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'application-use-cases-'));
  });

  teardown(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  test('install returns written files and diagnostics for a supported target', async () => {
    const useCases = createApplicationUseCases({
      root: tempRoot,
      now: () => '2025-01-01T00:00:00.000Z'
    });

    const result = await useCases.install({
      target: { type: 'vscode', scope: 'repository' },
      bundle: createBundle('1.0.0')
    });

    assert.deepStrictEqual(result, {
      success: true,
      bundleId: 'app-use-case-bundle',
      version: '1.0.0',
      writtenFiles: ['.github/prompts/review.prompt.md'],
      diagnostics: []
    });
  });

  test('update reports previous and next versions while preserving target paths', async () => {
    const useCases = createApplicationUseCases({
      root: tempRoot,
      now: () => '2025-01-01T00:00:00.000Z'
    });

    await useCases.install({
      target: { type: 'vscode', scope: 'repository' },
      bundle: createBundle('1.0.0')
    });
    const result = await useCases.update({
      target: { type: 'vscode', scope: 'repository' },
      bundle: createBundle('1.0.1')
    });

    assert.deepStrictEqual(result, {
      success: true,
      bundleId: 'app-use-case-bundle',
      previousVersion: '1.0.0',
      version: '1.0.1',
      writtenFiles: ['.github/prompts/review.prompt.md'],
      diagnostics: []
    });
  });

  test('uninstall removes managed files for the requested target scope', async () => {
    const useCases = createApplicationUseCases({
      root: tempRoot,
      now: () => '2025-01-01T00:00:00.000Z'
    });

    await useCases.install({
      target: { type: 'vscode', scope: 'repository' },
      bundle: createBundle('1.0.0')
    });
    const result = await useCases.uninstall({
      target: { type: 'vscode', scope: 'repository' },
      bundleId: 'app-use-case-bundle'
    });

    assert.deepStrictEqual(result, {
      success: true,
      bundleId: 'app-use-case-bundle',
      removedFiles: ['.github/prompts/review.prompt.md'],
      diagnostics: []
    });
  });

  test('validate rejects unsupported resources before writing files', async () => {
    const useCases = createApplicationUseCases({
      root: tempRoot,
      now: () => '2025-01-01T00:00:00.000Z'
    });

    const result = await useCases.validate({
      target: { type: 'kiro', scope: 'repository' },
      bundle: {
        id: 'unsupported-resource-bundle',
        version: '1.0.0',
        resources: [
          {
            kind: 'agent',
            id: 'planner',
            sourcePath: 'agents/planner.agent.md',
            content: '# Planner\n'
          }
        ]
      }
    });

    assert.deepStrictEqual(result, {
      valid: false,
      diagnostics: [
        {
          severity: 'error',
          code: 'unsupported-resource',
          resourceId: 'planner',
          message: 'Target kiro does not support agent resources in repository scope.'
        }
      ]
    });
  });
});

function createBundle(version: string): ApplicationBundle {
  return {
    id: 'app-use-case-bundle',
    version,
    resources: [
      {
        kind: 'prompt',
        id: 'review',
        sourcePath: 'prompts/review.prompt.md',
        content: '# Review\n'
      }
    ]
  };
}
