import type {
  Clock,
  HttpClient,
  ProcessRunner,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import type {
  SourceAdapterFactoryDeps,
} from '../../src/registry/create-source-adapter';
import {
  validateHubConfigFile,
} from '../../src/registry/validate-hub-config-file';
import type {
  HubValidationProgress,
} from '../../src/registry/validate-hub-config-file';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

const clock: Clock = {
  now: () => 0,
  nowIso: () => '1970-01-01T00:00:00.000Z'
};

const httpClient: HttpClient = {
  fetch: async () => {
    throw new Error('HTTP should not be called for a local source');
  }
};

const processRunner: ProcessRunner = {
  exec: async () => {
    throw new Error('Process execution should not be called for a local source');
  }
};

function makeDeepDeps(fs: InMemoryFileSystem): SourceAdapterFactoryDeps {
  return {
    fs,
    clock,
    httpClient,
    processRunner,
    fallbackTokenProviders: []
  };
}

function makeLocalHubYaml(bundleId: string, version: string, required = true): string {
  return `version: 1.0.0
metadata:
  name: Test Hub
  description: Test hub
  maintainer: test
  updatedAt: '2026-01-01T00:00:00Z'
sources:
  - id: local-source
    name: Local Source
    type: local
    url: /registry
    enabled: true
    priority: 1
profiles:
  - id: test-profile
    name: Test Profile
    description: Test profile
    bundles:
      - id: ${bundleId}
        version: ${version}
        source: local-source
        required: ${required}
`;
}

describe('validateHubConfigFile deep validation', () => {
  it('fails when a profile references a bundle absent from the source catalog', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed('/registry/existing/deployment-manifest.yml', `id: existing
name: Existing
version: 1.0.0
description: Existing bundle
author: Test
`);
    fs.seed('/hub-config.yml', `version: 1.0.0
metadata:
  name: Test Hub
  description: Test hub
  maintainer: test
  updatedAt: '2026-01-01T00:00:00Z'
sources:
  - id: local-source
    name: Local Source
    type: local
    url: /registry
    enabled: true
    priority: 1
profiles:
  - id: test-profile
    name: Test Profile
    description: Test profile
    bundles:
      - id: missing
        version: latest
        source: local-source
        required: true
`);

    const result = await validateHubConfigFile(fs, '/hub-config.yml', {
      deep: true,
      sourceAdapterDeps: makeDeepDeps(fs)
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "Profile 'test-profile' references bundle 'missing' from source 'local-source', but no matching bundle was discovered."
    );
  });

  it('warns instead of failing for an absent optional bundle', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed('/registry/existing/deployment-manifest.yml', `id: existing
name: Existing
version: 1.0.0
description: Existing bundle
author: Test
`);
    fs.seed('/hub-config.yml', makeLocalHubYaml('missing', 'latest', false));

    const result = await validateHubConfigFile(fs, '/hub-config.yml', {
      deep: true,
      sourceAdapterDeps: makeDeepDeps(fs)
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toContain(
      "Profile 'test-profile' references bundle 'missing' from source 'local-source', but no matching bundle was discovered."
    );
  });

  it('requires an exact version for a pinned profile reference', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed('/registry/existing/deployment-manifest.yml', `id: existing
name: Existing
version: 2.0.0
description: Existing bundle
author: Test
`);
    fs.seed('/hub-config.yml', makeLocalHubYaml('existing', '1.0.0'));

    const result = await validateHubConfigFile(fs, '/hub-config.yml', {
      deep: true,
      sourceAdapterDeps: makeDeepDeps(fs)
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "Profile 'test-profile' requires bundle 'existing' at version '1.0.0' from source 'local-source', but available versions are: 2.0.0."
    );
  });

  it('skips disabled sources and reports referenced bundles as unavailable', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed('/hub-config.yml', makeLocalHubYaml('existing', 'latest'));
    const disabledYaml = (await fs.readFile('/hub-config.yml')).replace('enabled: true', 'enabled: false');
    await fs.writeFile('/hub-config.yml', disabledYaml);

    const result = await validateHubConfigFile(fs, '/hub-config.yml', {
      deep: true,
      sourceAdapterDeps: makeDeepDeps(fs)
    });

    expect(result.valid).toBe(false);
    expect(result.sources[0]).toMatchObject({ sourceId: 'local-source', skipped: true, bundlesFound: 0 });
    expect(result.errors).toContain("Profile 'test-profile' references disabled source 'local-source'.");
  });

  it('reports deterministic progress for source and profile resolution', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed('/registry/existing/deployment-manifest.yml', `id: existing
name: Existing
version: 1.0.0
description: Existing bundle
author: Test
`);
    fs.seed('/hub-config.yml', makeLocalHubYaml('existing', 'latest'));
    const events: HubValidationProgress[] = [];

    const result = await validateHubConfigFile(fs, '/hub-config.yml', {
      deep: true,
      onProgress: (event) => events.push(event),
      sourceAdapterDeps: makeDeepDeps(fs)
    });

    expect(result.valid).toBe(true);
    expect(events).toEqual([
      { phase: 'started', sourcesTotal: 1, profilesTotal: 1 },
      {
        phase: 'source',
        status: 'started',
        current: 1,
        total: 1,
        sourceId: 'local-source',
        sourceType: 'local',
        enabled: true
      },
      {
        phase: 'catalog',
        status: 'started',
        current: 1,
        total: 1,
        sourceId: 'local-source',
        sourceType: 'local'
      },
      {
        phase: 'catalog',
        status: 'completed',
        current: 1,
        total: 1,
        sourceId: 'local-source',
        sourceType: 'local',
        bundlesFound: 1
      },
      {
        phase: 'source',
        status: 'completed',
        current: 1,
        total: 1,
        sourceId: 'local-source',
        sourceType: 'local',
        enabled: true,
        valid: true,
        bundlesFound: 1
      },
      {
        phase: 'profile',
        status: 'started',
        current: 1,
        total: 1,
        profileId: 'test-profile',
        bundlesTotal: 1
      },
      {
        phase: 'profile',
        status: 'completed',
        current: 1,
        total: 1,
        profileId: 'test-profile',
        bundlesTotal: 1,
        valid: true,
        errors: 0,
        warnings: 0
      },
      {
        phase: 'completed',
        sourcesTotal: 1,
        profilesTotal: 1,
        bundlesFound: 1,
        valid: true
      }
    ]);
  });
});
