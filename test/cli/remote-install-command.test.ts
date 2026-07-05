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
  ApplicationSource,
  ApplicationUseCases,
} from '../../src/services/application-use-cases';
import type {
  Target,
} from '../../src/types/target';

type InstallCommandModule = {
  executeRemoteInstallCommand(
    input: {
      bundleRef: string;
      source: ApplicationSource;
      target: Target;
    },
    dependencies: {
      loadBundle(bundleRef: string, source: ApplicationSource): Promise<ApplicationBundle>;
      useCases: Pick<ApplicationUseCases, 'install'>;
    }
  ): Promise<ApplicationInstallResult>;
};

suite('CLI remote install command', () => {
  test('executeRemoteInstallCommand installs remote bundles through the shared application use case', async () => {
    const command = await loadInstallCommandModule();
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-remote-install-command-'));
    const target: Target = { type: 'vscode', scope: 'repository' };
    const source: ApplicationSource = {
      id: 'github:owner/repo',
      type: 'github',
      url: 'https://github.com/owner/repo'
    };

    try {
      const useCases = createApplicationUseCases({
        root: tempRoot,
        now: () => '2025-01-01T00:00:00.000Z'
      });

      const result = await command.executeRemoteInstallCommand(
        {
          bundleRef: 'example-bundle',
          source,
          target
        },
        {
          loadBundle: (bundleRef: string, receivedSource: ApplicationSource) => {
            assert.strictEqual(bundleRef, 'example-bundle');
            assert.deepStrictEqual(receivedSource, source);
            return Promise.resolve(createBundle('1.0.0'));
          },
          useCases
        }
      );

      assert.deepStrictEqual(result, {
        success: true,
        bundleId: 'cli-remote-bundle',
        version: '1.0.0',
        writtenFiles: ['.github/prompts/review.prompt.md'],
        diagnostics: []
      });

      const lockfile = JSON.parse(
        await fs.readFile(path.join(tempRoot, 'repository', 'prompt-registry.lock.json'), 'utf8')
      ) as {
        bundles: Record<string, {
          files: { checksum: string; path: string }[];
          installedAt: string;
          sourceId: string;
          sourceType: string;
          version: string;
        }>;
        sources: Record<string, { type: string; url: string }>;
      };

      assert.deepStrictEqual(lockfile.bundles['cli-remote-bundle'], {
        version: '1.0.0',
        sourceId: 'github:owner/repo',
        sourceType: 'github',
        installedAt: '2025-01-01T00:00:00.000Z',
        files: [
          {
            path: '.github/prompts/review.prompt.md',
            checksum: '0000000000000000000000000000000000000000000000000000000000000001'
          }
        ]
      });
      assert.deepStrictEqual(lockfile.sources['github:owner/repo'], {
        type: 'github',
        url: 'https://github.com/owner/repo'
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('executeRemoteInstallCommand forwards remote source metadata to the shared install use case', async () => {
    const command = await loadInstallCommandModule();
    const bundle = createBundle('1.0.1');
    const target: Target = { type: 'vscode', scope: 'repository' };
    const source: ApplicationSource = {
      id: 'github:owner/repo',
      type: 'github',
      url: 'https://github.com/owner/repo'
    };
    const requests: unknown[] = [];

    const result = await command.executeRemoteInstallCommand(
      {
        bundleRef: 'example-bundle',
        source,
        target
      },
      {
        loadBundle: (bundleRef: string, receivedSource: ApplicationSource) => {
          assert.strictEqual(bundleRef, 'example-bundle');
          assert.deepStrictEqual(receivedSource, source);
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
          }
        }
      }
    );

    assert.deepStrictEqual(requests, [
      {
        target,
        bundle,
        source
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
});

function createBundle(version: string): ApplicationBundle {
  return {
    id: 'cli-remote-bundle',
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
  const modulePath = '../../src/cli/commands/install';
  return import(modulePath) as Promise<InstallCommandModule>;
}
