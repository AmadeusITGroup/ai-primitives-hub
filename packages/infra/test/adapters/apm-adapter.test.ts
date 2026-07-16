import type {
  GitHubApi,
  RegistrySource,
  TokenProvider,
} from '@ai-primitives-hub/core';
import * as yaml from 'js-yaml';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  ApmAdapter,
} from '../../src/adapters/apm-adapter';
import {
  FakeGitHubApi,
} from '../helpers/fake-github-api';
import {
  FakeProcessRunner,
} from '../helpers/fake-process-runner';
import {
  FixedClock,
} from '../helpers/fixed-clock';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';
import {
  RecordingGitHubApi,
} from '../helpers/recording-github-api';

function makeSource(overrides: Partial<RegistrySource> = {}): RegistrySource {
  return {
    id: 'apm-test',
    name: 'APM Test',
    type: 'apm',
    url: 'https://github.com/owner/repo',
    enabled: true,
    priority: 0,
    ...overrides
  };
}

const TREE_PATH = '/repos/owner/repo/git/trees/main?recursive=1';
const RAW_BASE = 'https://raw.githubusercontent.com/owner/repo/main';

function apmManifestYaml(overrides: Record<string, unknown> = {}): string {
  return yaml.dump({
    name: 'My Package',
    version: '1.0.0',
    description: 'A package',
    author: 'jdoe',
    tags: ['azure', 'testing'],
    license: 'MIT',
    ...overrides
  });
}

/**
 * Registers an `apm --version` handler so `ensureRuntimeAvailable` reports `apm` as installed.
 * @param processRunner - Fake to register the handler on.
 * @param version - Version string the handler resolves with.
 */
function withApmInstalled(processRunner: FakeProcessRunner, version = '1.2.3'): FakeProcessRunner {
  return processRunner.on('apm --version', async () => ({ stdout: version, stderr: '' }));
}

interface AdapterOverrides {
  source?: RegistrySource;
  githubApi?: GitHubApi;
  processRunner?: FakeProcessRunner;
  fs?: InMemoryFileSystem;
  clock?: FixedClock;
  tokenProvider?: TokenProvider;
}

function makeAdapter(overrides: AdapterOverrides = {}): ApmAdapter {
  return new ApmAdapter(
    overrides.source ?? makeSource(),
    overrides.githubApi ?? new FakeGitHubApi(),
    overrides.processRunner ?? withApmInstalled(new FakeProcessRunner()),
    overrides.fs ?? new InMemoryFileSystem(),
    overrides.clock ?? new FixedClock(0),
    overrides.tokenProvider
  );
}

describe('ApmAdapter', () => {
  describe('constructor', () => {
    it('rejects a URL that is not an exact https://github.com/owner/repo', () => {
      for (const url of ['not-a-url', 'https://github.com/owner/repo/extra', 'git@github.com:owner/repo.git', 'http://github.com/owner/repo']) {
        expect(() => makeAdapter({ source: makeSource({ url }) })).toThrow('Invalid GitHub URL');
      }
    });

    it('accepts a plain repo URL and one with a .git suffix', () => {
      for (const url of ['https://github.com/owner/repo', 'https://github.com/owner/repo.git']) {
        expect(() => makeAdapter({ source: makeSource({ url }) })).not.toThrow();
      }
    });
  });

  describe('getManifestUrl / getDownloadUrl', () => {
    it('always points at the root apm.yml for the default branch', () => {
      const adapter = makeAdapter();
      expect(adapter.getManifestUrl()).toBe(`${RAW_BASE}/apm.yml`);
      expect(adapter.getDownloadUrl()).toBe(`${RAW_BASE}/apm.yml`);
    });

    it('respects a configured branch', () => {
      const adapter = makeAdapter({ source: makeSource({ config: { branch: 'dev' } }) });
      expect(adapter.getManifestUrl()).toBe('https://raw.githubusercontent.com/owner/repo/dev/apm.yml');
    });
  });

  describe('requiresAuthentication', () => {
    it('defaults to false when the source is not marked private', () => {
      expect(makeAdapter().requiresAuthentication()).toBe(false);
    });

    it('is true when the source is marked private', () => {
      expect(makeAdapter({ source: makeSource({ private: true }) }).requiresAuthentication()).toBe(true);
    });
  });

  describe('fetchBundles', () => {
    it('discovers the root apm.yml and one apm.yml per immediate subdirectory, skipping deeper nesting and skip-listed directories', async () => {
      const api = new FakeGitHubApi()
        .seedJson(TREE_PATH, {
          tree: [
            { path: 'apm.yml' },
            { path: 'pkg-a/apm.yml' },
            { path: 'pkg-a/README.md' },
            { path: 'node_modules/apm.yml' },
            { path: 'deep/nested/apm.yml' }
          ]
        })
        .seedText(`${RAW_BASE}/apm.yml`, apmManifestYaml({ name: 'Root Package' }))
        .seedText(`${RAW_BASE}/pkg-a/apm.yml`, apmManifestYaml({ name: 'Package A', tags: ['frontend'] }));

      const bundles = await makeAdapter({ githubApi: api }).fetchBundles();

      expect(bundles.map((b) => b.name).toSorted()).toEqual(['Package A', 'Root Package']);
    });

    it('builds a bundle with fields mapped from the apm.yml manifest', async () => {
      const api = new FakeGitHubApi().seedJson(TREE_PATH, { tree: [{ path: 'apm.yml' }] }).seedText(
        `${RAW_BASE}/apm.yml`,
        apmManifestYaml({
          name: 'My Package',
          version: '2.0.0',
          description: 'desc',
          author: 'jdoe',
          tags: ['azure'],
          license: 'Apache-2.0',
          dependencies: { apm: ['other/pkg'] }
        })
      );

      const [bundle] = await makeAdapter({ githubApi: api, clock: new FixedClock(1_700_000_000_000) }).fetchBundles();

      expect(bundle).toMatchObject({
        id: 'owner-my-package',
        name: 'My Package',
        version: '2.0.0',
        description: 'desc',
        author: 'jdoe',
        sourceId: 'apm-test',
        tags: ['azure', 'apm'],
        environments: ['cloud'],
        size: '1 dependency',
        dependencies: [{ bundleId: 'other/pkg', versionRange: '*', optional: false }],
        license: 'Apache-2.0',
        manifestUrl: `${RAW_BASE}/apm.yml`,
        downloadUrl: `${RAW_BASE}/apm.yml`,
        repository: 'https://github.com/owner/repo'
      });
      expect(bundle.lastUpdated).toBe(new Date(1_700_000_000_000).toISOString());
    });

    it('defaults version/author/license/environments/tags when the manifest omits them', async () => {
      const api = new FakeGitHubApi().seedJson(TREE_PATH, { tree: [{ path: 'apm.yml' }] }).seedText(`${RAW_BASE}/apm.yml`, yaml.dump({ name: 'Bare' }));

      const [bundle] = await makeAdapter({ githubApi: api }).fetchBundles();

      expect(bundle).toMatchObject({ version: '1.0.0', author: 'owner', license: 'MIT', environments: ['general'], tags: ['apm'] });
    });

    it('skips a subdirectory whose apm.yml fails to parse, without failing the whole fetch', async () => {
      const api = new FakeGitHubApi()
        .seedJson(TREE_PATH, { tree: [{ path: 'apm.yml' }, { path: 'broken/apm.yml' }] })
        .seedText(`${RAW_BASE}/apm.yml`, apmManifestYaml({ name: 'Good' }))
        .seedText(`${RAW_BASE}/broken/apm.yml`, 'name: [this is not: valid yaml');

      const bundles = await makeAdapter({ githubApi: api }).fetchBundles();
      expect(bundles.map((b) => b.name)).toEqual(['Good']);
    });

    it('resolves to an empty list, rather than throwing, when the git tree cannot be fetched', async () => {
      const bundles = await makeAdapter({ githubApi: new FakeGitHubApi() }).fetchBundles();
      expect(bundles).toEqual([]);
    });

    it('throws when neither apm nor uvx is available', async () => {
      const processRunner = new FakeProcessRunner()
        .on('apm --version', () => Promise.reject(new Error('not found')))
        .on('uvx --version', () => Promise.reject(new Error('not found')));

      await expect(makeAdapter({ processRunner }).fetchBundles()).rejects.toThrow(
        'APM runtime is not available. Please install apm-cli or uv.'
      );
    });

    it('succeeds via uvx when apm itself is not installed', async () => {
      const api = new FakeGitHubApi().seedJson(TREE_PATH, { tree: [{ path: 'apm.yml' }] }).seedText(`${RAW_BASE}/apm.yml`, apmManifestYaml());
      const processRunner = new FakeProcessRunner()
        .on('apm --version', () => Promise.reject(new Error('not found')))
        .on('uvx --version', async () => ({ stdout: '', stderr: '' }));

      const bundles = await makeAdapter({ githubApi: api, processRunner }).fetchBundles();
      expect(bundles).toHaveLength(1);
    });

    it('caches results within the TTL and re-fetches once the TTL has elapsed', async () => {
      const api = new FakeGitHubApi().seedJson(TREE_PATH, { tree: [{ path: 'apm.yml' }] }).seedText(`${RAW_BASE}/apm.yml`, apmManifestYaml());
      const recordingApi = new RecordingGitHubApi(api);
      const clock = new FixedClock(0);

      const adapter = makeAdapter({ githubApi: recordingApi, clock });
      await adapter.fetchBundles();
      await adapter.fetchBundles();
      expect(recordingApi.countOf('getJson')).toBe(1);

      clock.advance(5 * 60 * 1000 + 1);
      await adapter.fetchBundles();
      expect(recordingApi.countOf('getJson')).toBe(2);
    });
  });

  describe('downloadBundle', () => {
    it('produces a real ZIP archive from files written by the install command (.apm, apm_modules, install root)', async () => {
      const fs = new InMemoryFileSystem();
      const processRunner = withApmInstalled(new FakeProcessRunner()).on('apm install', async (_command, options) => {
        const dir = options.cwd;
        if (!dir) {
          throw new Error('expected a cwd');
        }
        await fs.writeFile(`${dir}/.apm/agents/code-reviewer.md`, '# Code Reviewer');
        await fs.writeFile(`${dir}/apm_modules/dep/helper.prompt.md`, '# Helper');
        await fs.writeFile(`${dir}/root.prompt.md`, '# Root');
        return { stdout: '', stderr: '' };
      });

      const adapter = makeAdapter({ fs, processRunner });
      const bundle = { id: 'owner-pkg', name: 'Pkg', description: 'd', author: 'owner', downloadUrl: `${RAW_BASE}/apm.yml` } as never;
      const zip = await adapter.downloadBundle(bundle);

      // ZIP local-file-header magic number: "PK\x03\x04".
      expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4B, 0x03, 0x04]));
      expect(zip.length).toBeGreaterThan(0);
    });

    it('writes a temp apm.yml declaring the subdirectory package as a dependency', async () => {
      const fs = new InMemoryFileSystem();
      let installedManifest = '';
      const processRunner = withApmInstalled(new FakeProcessRunner()).on('apm install', async (_command, options) => {
        installedManifest = await fs.readFile(`${options.cwd}/apm.yml`);
        return { stdout: '', stderr: '' };
      });

      const adapter = makeAdapter({ fs, processRunner });
      await adapter.downloadBundle({ downloadUrl: `${RAW_BASE}/pkg-a/apm.yml` } as never);

      expect(installedManifest).toContain('owner/repo/pkg-a');
    });

    it('falls back to "uvx apm install" when apm itself is not installed', async () => {
      const processRunner = new FakeProcessRunner()
        .on('apm --version', () => Promise.reject(new Error('not found')))
        .on('uvx --version', async () => ({ stdout: '', stderr: '' }))
        .on('uvx apm install');

      const adapter = makeAdapter({ processRunner });
      await adapter.downloadBundle({ downloadUrl: `${RAW_BASE}/apm.yml` } as never);

      expect(processRunner.calls.map((c) => c.command)).toContain('uvx apm install');
    });

    it('passes a resolved token as GITHUB_TOKEN to the install command', async () => {
      const processRunner = withApmInstalled(new FakeProcessRunner()).on('apm install');
      const tokenProvider: TokenProvider = { getToken: async () => 'gho_secret' };

      const adapter = makeAdapter({ processRunner, tokenProvider });
      await adapter.downloadBundle({ downloadUrl: `${RAW_BASE}/apm.yml` } as never);

      const installCall = processRunner.calls.find((c) => c.command === 'apm install');
      expect(installCall?.options.env).toEqual({ GITHUB_TOKEN: 'gho_secret' });
    });

    it('omits the env override entirely when no token is available', async () => {
      const processRunner = withApmInstalled(new FakeProcessRunner()).on('apm install');
      const adapter = makeAdapter({ processRunner });
      await adapter.downloadBundle({ downloadUrl: `${RAW_BASE}/apm.yml` } as never);

      const installCall = processRunner.calls.find((c) => c.command === 'apm install');
      expect(installCall?.options.env).toBeUndefined();
    });

    it('wraps an install failure with a descriptive error', async () => {
      const processRunner = withApmInstalled(new FakeProcessRunner()).on('apm install', () => Promise.reject(new Error('network error')));
      await expect(makeAdapter({ processRunner }).downloadBundle({ downloadUrl: `${RAW_BASE}/apm.yml` } as never)).rejects.toThrow(
        'Failed to install package: network error'
      );
    });

    it('throws when the downloadUrl does not match this source\'s repo/branch', async () => {
      await expect(makeAdapter().downloadBundle({ downloadUrl: 'https://example.com/unrelated' } as never)).rejects.toThrow(
        'Cannot determine package reference from downloadUrl'
      );
    });

    it('throws when neither apm nor uvx is available', async () => {
      const processRunner = new FakeProcessRunner()
        .on('apm --version', () => Promise.reject(new Error('not found')))
        .on('uvx --version', () => Promise.reject(new Error('not found')));
      await expect(makeAdapter({ processRunner }).downloadBundle({ downloadUrl: `${RAW_BASE}/apm.yml` } as never)).rejects.toThrow(
        'APM runtime is not available'
      );
    });
  });

  describe('fetchMetadata', () => {
    it('reports the repo name, bundle count, and detected apm version', async () => {
      const api = new FakeGitHubApi().seedJson(TREE_PATH, { tree: [{ path: 'apm.yml' }] }).seedText(`${RAW_BASE}/apm.yml`, apmManifestYaml());
      const processRunner = withApmInstalled(new FakeProcessRunner(), '3.4.5');
      const clock = new FixedClock(1_700_000_000_000);

      const metadata = await makeAdapter({ githubApi: api, processRunner, clock }).fetchMetadata();

      expect(metadata).toEqual({
        name: 'owner/repo',
        description: 'APM packages from https://github.com/owner/repo',
        bundleCount: 1,
        lastUpdated: new Date(1_700_000_000_000).toISOString(),
        version: '3.4.5'
      });
    });
  });

  describe('validate', () => {
    it('is invalid when the APM CLI is not installed, even if uvx is available', async () => {
      const processRunner = new FakeProcessRunner()
        .on('apm --version', () => Promise.reject(new Error('not found')))
        .on('uvx --version', async () => ({ stdout: '', stderr: '' }));

      expect(await makeAdapter({ processRunner }).validate()).toEqual({
        valid: false,
        errors: ['APM CLI is not installed. Install with: pip install apm-cli'],
        warnings: [],
        bundlesFound: 0
      });
    });

    it('is valid with a warning when installed but no packages are found', async () => {
      const result = await makeAdapter({ githubApi: new FakeGitHubApi().seedJson(TREE_PATH, { tree: [] }) }).validate();
      expect(result).toEqual({ valid: true, errors: [], warnings: ['No APM packages found'], bundlesFound: 0 });
    });

    it('is valid with the bundle count when packages are found', async () => {
      const api = new FakeGitHubApi().seedJson(TREE_PATH, { tree: [{ path: 'apm.yml' }] }).seedText(`${RAW_BASE}/apm.yml`, apmManifestYaml());
      const result = await makeAdapter({ githubApi: api }).validate();
      expect(result).toEqual({ valid: true, errors: [], warnings: [], bundlesFound: 1 });
    });

    it('caches the runtime status within its own TTL, independent of the bundle cache', async () => {
      const api = new FakeGitHubApi().seedJson(TREE_PATH, { tree: [] });
      const processRunner = withApmInstalled(new FakeProcessRunner());
      const clock = new FixedClock(0);
      const adapter = makeAdapter({ githubApi: api, processRunner, clock });

      await adapter.validate();
      await adapter.validate();
      expect(processRunner.calls.filter((c) => c.command === 'apm --version')).toHaveLength(1);

      clock.advance(60 * 1000 + 1);
      await adapter.validate();
      expect(processRunner.calls.filter((c) => c.command === 'apm --version')).toHaveLength(2);
    });
  });
});
