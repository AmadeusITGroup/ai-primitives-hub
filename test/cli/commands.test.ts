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
import type {
  Target,
} from '../../src/types/target';

suite('CLI uninstall command', () => {
  test('executeUninstallCommand delegates to the shared uninstall use case', async () => {
    const mod = await import('../../src/cli/commands/uninstall');
    const target: Target = { type: 'vscode', scope: 'repository' };
    const requests: unknown[] = [];

    const result = await mod.executeUninstallCommand(
      {
        bundleId: 'example-bundle',
        target
      },
      {
        useCases: {
          uninstall: (request) => {
            requests.push(request);
            return Promise.resolve({
              success: true,
              bundleId: 'example-bundle',
              removedFiles: ['.github/prompts/code-review.prompt.md'],
              diagnostics: []
            });
          }
        }
      }
    );

    assert.deepStrictEqual(requests, [{ target, bundleId: 'example-bundle' }]);
    assert.deepStrictEqual(result, {
      success: true,
      bundleId: 'example-bundle',
      removedFiles: ['.github/prompts/code-review.prompt.md'],
      diagnostics: []
    });
  });

  test('executeUninstallCommand removes files from a real fixture install', async () => {
    const installMod = await import('../../src/cli/commands/install');
    const uninstallMod = await import('../../src/cli/commands/uninstall');
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-uninstall-'));
    const fixtureBundlePath = path.join(process.cwd(), 'test', 'fixtures', 'local-library', 'example-bundle');

    try {
      const useCases = createApplicationUseCases({
        root: tempRoot,
        now: () => '2025-01-01T00:00:00.000Z'
      });
      const target: Target = { type: 'vscode', scope: 'repository' };

      await installMod.executeInstallCommand(
        { bundleRef: fixtureBundlePath, target },
        { loadBundle: installMod.loadLocalBundle, useCases }
      );

      const result = await uninstallMod.executeUninstallCommand(
        { bundleId: 'example-bundle', target },
        { useCases }
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.bundleId, 'example-bundle');
      assert.ok(result.removedFiles.length > 0);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

suite('CLI validate command', () => {
  test('executeValidateCommand loads the bundle and delegates to the shared validate use case', async () => {
    const mod = await import('../../src/cli/commands/validate');
    const bundle = createBundle('1.0.0');
    const target: Target = { type: 'vscode', scope: 'user' };
    const requests: unknown[] = [];
    let loadedBundleRef = '';

    const result = await mod.executeValidateCommand(
      {
        bundleRef: 'fixtures/review-bundle',
        target
      },
      {
        loadBundle: (bundleRef: string) => {
          loadedBundleRef = bundleRef;
          return Promise.resolve(bundle);
        },
        useCases: {
          validate: (request) => {
            requests.push(request);
            return Promise.resolve({
              valid: true,
              diagnostics: []
            });
          }
        }
      }
    );

    assert.strictEqual(loadedBundleRef, 'fixtures/review-bundle');
    assert.deepStrictEqual(requests, [{ target, bundle }]);
    assert.deepStrictEqual(result, { valid: true, diagnostics: [] });
  });

  test('executeValidateCommand reports diagnostics for unsupported resources', async () => {
    const mod = await import('../../src/cli/commands/validate');
    const bundle = createBundle('1.0.0');
    const target: Target = { type: 'vscode', scope: 'user' };

    const result = await mod.executeValidateCommand(
      { bundleRef: 'fixtures/review-bundle', target },
      {
        loadBundle: () => Promise.resolve(bundle),
        useCases: {
          validate: () => Promise.resolve({
            valid: false,
            diagnostics: [
              {
                severity: 'error',
                code: 'unsupported-resource',
                resourceId: 'review',
                message: 'Target vscode does not support prompt resources in user scope.'
              }
            ]
          })
        }
      }
    );

    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.diagnostics.length, 1);
    assert.strictEqual(result.diagnostics[0].code, 'unsupported-resource');
  });
});

suite('CLI list command', () => {
  test('executeListCommand delegates to the shared list use case', async () => {
    const mod = await import('../../src/cli/commands/list');
    const requests: unknown[] = [];

    const result = await mod.executeListCommand(
      {},
      {
        useCases: {
          list: (request) => {
            requests.push(request);
            return Promise.resolve({
              bundles: [
                { bundleId: 'example-bundle', version: '1.0.0', target: { type: 'vscode', scope: 'repository' } }
              ]
            });
          }
        }
      }
    );

    assert.deepStrictEqual(requests, [{ target: undefined }]);
    assert.deepStrictEqual(result, {
      bundles: [
        { bundleId: 'example-bundle', version: '1.0.0', target: { type: 'vscode', scope: 'repository' } }
      ]
    });
  });

  test('executeListCommand filters by target when provided', async () => {
    const mod = await import('../../src/cli/commands/list');
    const target: Target = { type: 'kiro', scope: 'user' };
    const requests: unknown[] = [];

    await mod.executeListCommand(
      { target },
      {
        useCases: {
          list: (request) => {
            requests.push(request);
            return Promise.resolve({ bundles: [] });
          }
        }
      }
    );

    assert.deepStrictEqual(requests, [{ target }]);
  });
});

suite('CLI inspect command', () => {
  test('executeInspectCommand loads the bundle and delegates to the shared inspect use case', async () => {
    const mod = await import('../../src/cli/commands/inspect');
    const bundle = createBundle('1.0.0');
    const target: Target = { type: 'vscode', scope: 'user' };
    const requests: unknown[] = [];
    let loadedBundleRef = '';

    const result = await mod.executeInspectCommand(
      {
        bundleRef: 'fixtures/review-bundle',
        target
      },
      {
        loadBundle: (bundleRef: string) => {
          loadedBundleRef = bundleRef;
          return Promise.resolve(bundle);
        },
        useCases: {
          inspect: (request) => {
            requests.push(request);
            return Promise.resolve({
              bundleId: bundle.id,
              version: bundle.version,
              resources: bundle.resources.map((r) => ({ kind: r.kind, id: r.id }))
            });
          }
        }
      }
    );

    assert.strictEqual(loadedBundleRef, 'fixtures/review-bundle');
    assert.deepStrictEqual(requests, [{ target, bundle }]);
    assert.deepStrictEqual(result, {
      bundleId: bundle.id,
      version: bundle.version,
      resources: [{ kind: 'prompt', id: 'review' }]
    });
  });
});

function createBundle(version: string): ApplicationBundle {
  return {
    id: 'cli-command-bundle',
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
