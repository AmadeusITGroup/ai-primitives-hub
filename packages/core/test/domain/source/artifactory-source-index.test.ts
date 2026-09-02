import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  type ArtifactorySourceIndex,
  compareSemVer,
  isValidSemVer,
  validateArtifactorySourceIndex,
} from '../../../src';

type IndexWithBundles = ArtifactorySourceIndex;

const object = (path: string) => ({
  path,
  size: 1,
  sha256: 'a'.repeat(64),
  mediaType: 'application/zip'
});

const validIndex = (): IndexWithBundles => ({
  formatVersion: 1,
  source: { id: 'example', name: 'Example', updatedAt: '2026-01-01T00:00:00Z' },
  bundles: [{
    id: 'bundle', version: '1.0.0', name: 'Bundle', description: 'Description', author: 'Author',
    environments: [], tags: [], lastUpdated: '2026-01-01T00:00:00Z', dependencies: [], license: 'Apache-2.0',
    manifest: { ...object('bundles/bundle/1.0.0/deployment-manifest.yml'), mediaType: 'application/yaml' },
    archive: object('bundles/bundle/1.0.0/bundle.zip')
  }]
});

describe('Artifactory source index', () => {
  it('validates the contract and rejects duplicate bundle versions and unsafe paths', () => {
    const index = validIndex();
    index.bundles.push({ ...index.bundles[0], archive: { ...index.bundles[0].archive, path: '../escape.zip' } });
    expect(validateArtifactorySourceIndex(index)).toMatchObject({ valid: false });
    expect(validateArtifactorySourceIndex({ ...validIndex(), bundles: [validIndex().bundles[0], validIndex().bundles[0]] }).errors.join(' ')).toMatch(/duplicate/i);
  });

  it('exposes strict SemVer validity and ordering helpers', () => {
    expect(isValidSemVer('1.2.3-alpha.1')).toBe(true);
    expect(isValidSemVer('1.2')).toBe(false);
    expect(compareSemVer('1.0.0', '1.0.0-alpha')).toBeGreaterThan(0);
  });
});
