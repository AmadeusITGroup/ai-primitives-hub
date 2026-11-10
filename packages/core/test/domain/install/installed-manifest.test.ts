import {
  describe,
  expect,
  it,
} from 'vitest';
import type {
  DeploymentManifest,
  InstalledBundle,
} from '../../../src/domain';
import {
  validateManifest,
} from '../../../src/domain/collection/manifest-validator';
import {
  readInstalledManifest,
} from '../../../src/domain/install/installed-manifest';
import {
  createGovernedReleaseArchive,
} from '../../fixtures/release-archives';

const legacy: DeploymentManifest = {
  common: { directories: [], files: [], include_patterns: [], exclude_patterns: [] },
  bundle_settings: {
    include_common_in_environment_bundles: true, create_common_bundle: true,
    compression: 'zip', naming: { environment_bundle: '{environment}' }
  },
  metadata: {
    manifest_version: '1.0.0', description: 'legacy desc',
    repository: { type: 'git', url: 'https://example.com/repo' },
    homepage: 'https://example.com'
  },
  prompts: [{ id: 'p1', name: 'Prompt One', description: 'd', file: 'prompts/p1.md', type: 'prompt', tags: ['a'] }],
  mcpServers: { srv: { command: 'run' } }
};

describe('readInstalledManifest', () => {
  it('reads legacy generator manifest fields via metadata fallback', () => {
    const d = readInstalledManifest(legacy);
    expect(d.name).toBeUndefined();
    expect(d.description).toBe('legacy desc');
    expect(d.repositoryUrl).toBe('https://example.com/repo');
    expect(d.homepage).toBe('https://example.com');
    expect(d.prompts).toHaveLength(1);
    expect(d.prompts?.[0]).toMatchObject({ id: 'p1', file: 'prompts/p1.md', type: 'prompt' });
    expect(d.mcpServers).toEqual({ srv: { command: 'run' } });
  });

  it('formatVersion 1 canonical items win, including empty array', () => {
    const release = {
      ...validateManifest(createGovernedReleaseArchive(), {}),
      description: 'rel', repository: 'https://rel.example',
      prompts: [{ id: 'stale', file: 'stale.md', type: 'prompt' }]
    };
    const d = readInstalledManifest(release);
    expect(d.repositoryUrl).toBe('https://rel.example');
    expect(d.prompts).toHaveLength(1);
    expect(d.description).toBe('rel');
    expect(d.prompts?.[0].file).toBe('prompts/hello.prompt.md');
    // empty canonical items still authoritative over stale compat prompts
    const d2 = readInstalledManifest({ ...release, items: [] });
    expect(d2.prompts).toEqual([]);
    expect(readInstalledManifest({ ...release, items: null }).prompts).toEqual([]);
  });

  it('legacy manifest with malformed items falls back to prompts', () => {
    const m = { id: 'x', version: '1.0.0', name: 'X', items: [{ noPath: true }, { file: 'bad.md', kind: 'prompt' }], prompts: [{ file: 'p.md' }] };
    const d = readInstalledManifest(m);
    expect(d.prompts).toEqual([{ id: 'p.md', name: 'p.md', description: '', file: 'p.md', type: 'prompt', tags: undefined }]);
  });

  it('minimal ValidatedManifest (id/name/version only) reads safely', () => {
    const d = readInstalledManifest({ id: 'm', version: '1.0.0', name: 'M' });
    expect(d).toEqual({ name: 'M', description: undefined, repositoryUrl: undefined, homepage: undefined });
  });

  it('malformed input returns {} and never mutates', () => {
    expect(readInstalledManifest(null)).toEqual({});
    expect(readInstalledManifest('x')).toEqual({});
    const invalid = readInstalledManifest({
      metadata: [], mcpServers: [], prompts: [null, { file: 1 }, { file: 'valid.md', tags: [1, 'safe'] }]
    });
    expect(invalid.mcpServers).toBeUndefined();
    expect(invalid.prompts).toHaveLength(1);
    expect(invalid.prompts?.[0].tags).toEqual(['safe']);
    const raw = structuredClone(legacy);
    readInstalledManifest(legacy);
    expect(legacy).toEqual(raw);
    expect(readInstalledManifest(legacy)).not.toHaveProperty('common');
    expect(readInstalledManifest(legacy)).not.toHaveProperty('bundle_settings');
  });

  it('InstalledBundle.manifest accepts ValidatedManifest without casts', () => {
    const bundle: InstalledBundle = {
      bundleId: 'b', version: '1.0.0', installedAt: 't', scope: 'user',
      installPath: '/p', manifest: { id: 'm', version: '1.0.0', name: 'M' }
    };
    expect(bundle.manifest).toEqual({ id: 'm', version: '1.0.0', name: 'M' });
    const manifest = validateManifest(createGovernedReleaseArchive(), {});
    const governed: InstalledBundle = { ...bundle, manifest };
    expect(governed.manifest).toEqual(manifest);
  });
});
