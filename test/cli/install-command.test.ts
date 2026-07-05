import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createApplicationUseCases,
} from '../../src/services/application-use-cases';
import type {
  ApplicationBundle,
  ApplicationInstallResult,
  ApplicationUpdateResult,
  ApplicationUseCases,
} from '../../src/services/application-use-cases';
import type {
  Target,
} from '../../src/types/target';

type InstallCommandModule = {
  loadLocalBundle(bundlePath: string): Promise<ApplicationBundle>;
  executeInstallCommand(
    input: {
      bundleRef: string;
      target: Target;
    },
    dependencies: {
      loadBundle(bundleRef: string): Promise<ApplicationBundle>;
      useCases: Pick<ApplicationUseCases, 'install' | 'update'>;
    }
  ): Promise<ApplicationInstallResult>;
  executeUpdateCommand(
    input: {
      bundleRef: string;
      target: Target;
    },
    dependencies: {
      loadBundle(bundleRef: string): Promise<ApplicationBundle>;
      useCases: Pick<ApplicationUseCases, 'install' | 'update'>;
    }
  ): Promise<ApplicationUpdateResult>;
};

suite('CLI install command', () => {
  test('loadLocalBundle installs a fixture bundle through the shared application use case', async () => {
    const command = await loadInstallCommandModule();
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-install-command-'));
    const fixtureBundlePath = path.join(process.cwd(), 'test', 'fixtures', 'local-library', 'example-bundle');

    try {
      const useCases = createApplicationUseCases({
        root: tempRoot,
        now: () => '2025-01-01T00:00:00.000Z'
      });

      const result = await command.executeInstallCommand(
        {
          bundleRef: fixtureBundlePath,
          target: { type: 'vscode', scope: 'repository' }
        },
        {
          loadBundle: (bundleRef: string) => command.loadLocalBundle(bundleRef),
          useCases
        }
      );

      assert.deepStrictEqual(result, {
        success: true,
        bundleId: 'example-bundle',
        version: '1.0.0',
        writtenFiles: [
          '.github/prompts/code-review.prompt.md',
          '.github/prompts/bug-analyzer.prompt.md',
          '.github/prompts/refactoring-guide.prompt.md'
        ],
        diagnostics: []
      });
      assert.match(
        await fs.readFile(path.join(tempRoot, 'repository', '.github', 'prompts', 'code-review.prompt.md'), 'utf8'),
        /Code Review Assistant/
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('executeInstallCommand loads the bundle and delegates to the shared install use case', async () => {
    const command = await loadInstallCommandModule();
    const bundle = createBundle('1.0.0');
    const target: Target = { type: 'vscode', scope: 'repository' };
    const requests: unknown[] = [];
    let loadedBundleRef = '';

    const result = await command.executeInstallCommand(
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
          install: (request) => {
            requests.push(request);
            return Promise.resolve({
              success: true,
              bundleId: bundle.id,
              version: bundle.version,
              writtenFiles: ['.github/prompts/review.prompt.md'],
              diagnostics: []
            });
          },
          update: () => {
            throw new Error('update should not be called');
          }
        }
      }
    );

    assert.strictEqual(loadedBundleRef, 'fixtures/review-bundle');
    assert.deepStrictEqual(requests, [
      {
        target,
        bundle,
        source: {
          id: bundle.id,
          type: 'local',
          url: 'fixtures/review-bundle'
        }
      }
    ]);
    assert.deepStrictEqual(result, {
      success: true,
      bundleId: bundle.id,
      version: bundle.version,
      writtenFiles: ['.github/prompts/review.prompt.md'],
      diagnostics: []
    });
  });

  test('executeUpdateCommand loads the bundle and delegates to the shared update use case', async () => {
    const command = await loadInstallCommandModule();
    const bundle = createBundle('1.0.1');
    const target: Target = { type: 'vscode', scope: 'repository' };
    const requests: unknown[] = [];

    const result = await command.executeUpdateCommand(
      {
        bundleRef: 'fixtures/review-bundle',
        target
      },
      {
        loadBundle: () => Promise.resolve(bundle),
        useCases: {
          install: () => {
            throw new Error('install should not be called');
          },
          update: (request) => {
            requests.push(request);
            return Promise.resolve({
              success: true,
              bundleId: bundle.id,
              previousVersion: '1.0.0',
              version: bundle.version,
              writtenFiles: ['.github/prompts/review.prompt.md'],
              diagnostics: []
            });
          }
        }
      }
    );

    assert.deepStrictEqual(requests, [
      {
        target,
        bundle,
        source: {
          id: bundle.id,
          type: 'local',
          url: 'fixtures/review-bundle'
        }
      }
    ]);
    assert.deepStrictEqual(result, {
      success: true,
      bundleId: bundle.id,
      previousVersion: '1.0.0',
      version: bundle.version,
      writtenFiles: ['.github/prompts/review.prompt.md'],
      diagnostics: []
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

async function loadInstallCommandModule(): Promise<InstallCommandModule> {
  return import('../../src/cli/commands/install');
}
