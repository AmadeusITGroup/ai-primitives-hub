/**
 * Tests for infra/hub/validate-hub-config.ts.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  validateHubConfig,
  validateHubConfigDocument,
} from '../../src/hub/validate-hub-config';

function validConfig(): Record<string, unknown> {
  return {
    version: '1.0.0',
    metadata: {
      name: 'Test Hub',
      description: 'A test hub',
      maintainer: 'someone',
      updatedAt: '2024-01-01T00:00:00.000Z'
    },
    sources: [
      { id: 'src-1', type: 'github' }
    ],
    profiles: [
      {
        id: 'profile-1',
        name: 'Profile One',
        bundles: [{ id: 'bundle-1', source: 'src-1' }]
      }
    ]
  };
}

function schemaValidConfig(): Record<string, unknown> {
  return {
    version: '1.0.0',
    metadata: {
      name: 'Test Hub',
      description: 'A test hub',
      maintainer: 'someone',
      updatedAt: '2024-01-01T00:00:00.000Z'
    },
    sources: [
      {
        id: 'github-source',
        type: 'github',
        url: 'https://github.com/example-org/example-repository',
        enabled: true,
        priority: 1
      }
    ],
    profiles: [
      {
        id: 'profile-1',
        name: 'Profile One',
        description: 'A test profile',
        bundles: [
          {
            id: 'example-org-example-repository-example-bundle',
            version: 'latest',
            source: 'github-source',
            required: true
          }
        ]
      }
    ]
  };
}

describe('validateHubConfig', () => {
  it('accepts a well-formed config', () => {
    const result = validateHubConfig(validConfig());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('requires version', () => {
    const config = validConfig();
    delete config.version;
    const result = validateHubConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('version is required');
  });

  it('rejects non-semver version', () => {
    const config = { ...validConfig(), version: 'not-a-version' };
    const result = validateHubConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('version must be in semver format (e.g., 1.0.0)');
  });

  it('requires metadata', () => {
    const config = validConfig();
    delete config.metadata;
    const result = validateHubConfig(config);
    expect(result.errors).toContain('metadata is required');
  });

  it('requires each metadata field', () => {
    const config = { ...validConfig(), metadata: {} };
    const result = validateHubConfig(config);
    expect(result.errors).toContain('metadata.name is required');
    expect(result.errors).toContain('metadata.description is required');
    expect(result.errors).toContain('metadata.maintainer is required');
    expect(result.errors).toContain('metadata.updatedAt is required');
  });

  it('rejects a malformed checksum', () => {
    const config = validConfig();
    (config.metadata as Record<string, unknown>).checksum = 'not-a-checksum';
    const result = validateHubConfig(config);
    expect(result.errors).toContain('metadata.checksum must be in format "sha256:hash" or "sha512:hash"');
  });

  it('accepts a well-formed checksum', () => {
    const config = validConfig();
    (config.metadata as Record<string, unknown>).checksum = 'sha256:abcdef0123456789';
    const result = validateHubConfig(config);
    expect(result.valid).toBe(true);
  });

  it('requires sources to be present and an array', () => {
    const missing = validConfig();
    delete missing.sources;
    expect(validateHubConfig(missing).errors).toContain('sources is required');

    const notArray = { ...validConfig(), sources: 'nope' };
    expect(validateHubConfig(notArray).errors).toContain('sources must be an array');
  });

  it('requires each source to have an id and type', () => {
    const config = { ...validConfig(), sources: [{}] };
    const result = validateHubConfig(config);
    expect(result.errors).toContain('source[0].id is required');
    expect(result.errors).toContain('source[0].type is required');
  });

  it('rejects path traversal in a source id', () => {
    const config = { ...validConfig(), sources: [{ id: '../evil', type: 'github' }] };
    const result = validateHubConfig(config);
    expect(result.errors.some((e) => e.includes('path traversal'))).toBe(true);
  });

  it('requires profiles to be an array when present', () => {
    const config = { ...validConfig(), profiles: 'nope' };
    const result = validateHubConfig(config);
    expect(result.errors).toContain('profiles must be an array');
  });

  it('requires each profile to have an id and name', () => {
    const config = { ...validConfig(), profiles: [{}] };
    const result = validateHubConfig(config);
    expect(result.errors).toContain('profile[0].id is required');
    expect(result.errors).toContain('profile[0].name is required');
  });

  it('rejects path traversal in a bundle id', () => {
    const config = validConfig();
    (config.profiles as Record<string, unknown>[])[0].bundles = [{ id: '../evil', source: 'src-1' }];
    const result = validateHubConfig(config);
    expect(result.errors.some((e) => e.includes('path traversal'))).toBe(true);
  });

  it('rejects a bundle referencing a non-existent source', () => {
    const config = validConfig();
    (config.profiles as Record<string, unknown>[])[0].bundles = [{ id: 'bundle-1', source: 'missing-src' }];
    const result = validateHubConfig(config);
    expect(result.errors.some((e) => e.includes('references non-existent source'))).toBe(true);
  });
});

describe('validateHubConfigDocument', () => {
  it('accepts a schema-valid config and the source policies', () => {
    const result = validateHubConfigDocument(schemaValidConfig());

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('includes JSON schema errors for missing source fields', () => {
    const config = schemaValidConfig();
    delete (config.sources as Record<string, unknown>[])[0].enabled;

    const result = validateHubConfigDocument(config);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes("'enabled'") || error.includes('enabled'))).toBe(true);
  });

  it('rejects a github source that defines config', () => {
    const config = schemaValidConfig();
    (config.sources as Record<string, unknown>[])[0].config = { branch: 'main' };

    const result = validateHubConfigDocument(config);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "Source 'github-source' has type 'github' and must not define 'config'."
    );
  });

  it('rejects an awesome-copilot source without config', () => {
    const config = schemaValidConfig();
    const source = (config.sources as Record<string, unknown>[])[0];
    source.type = 'awesome-copilot';

    const result = validateHubConfigDocument(config);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "Source 'github-source' has type 'awesome-copilot' and must define 'config'."
    );
  });

  it('rejects a github profile bundle with the wrong repository prefix', () => {
    const config = schemaValidConfig();
    const bundle = ((config.profiles as Record<string, unknown>[])[0].bundles as Record<string, unknown>[])[0];
    bundle.id = 'another-org-another-repository-example-bundle';

    const result = validateHubConfigDocument(config);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "Profile 'profile-1' bundle #1 must reference GitHub source 'github-source' "
      + "with an ID starting 'example-org-example-repository-'."
    );
  });

  it('rejects duplicate source and profile IDs', () => {
    const config = schemaValidConfig();
    config.sources = [
      ...(config.sources as Record<string, unknown>[]),
      { ...(config.sources as Record<string, unknown>[])[0] }
    ];
    config.profiles = [
      ...(config.profiles as Record<string, unknown>[]),
      { ...(config.profiles as Record<string, unknown>[])[0] }
    ];

    const result = validateHubConfigDocument(config);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('Duplicate source ID'))).toBe(true);
    expect(result.errors.some((error) => error.includes('Duplicate profile ID'))).toBe(true);
  });
});
