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
