import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  generateSourceId,
  normalizeUrl,
} from '../../src';

describe('Artifactory source IDs', () => {
  it('includes the configured Artifactory index path and preserves URL path case', () => {
    expect(normalizeUrl('https://ART.example/Repo/Path', true)).toBe('art.example/Repo/Path');
    expect(generateSourceId('artifactory', 'https://art.example/Repo/Path'))
      .toBe(generateSourceId('artifactory', 'https://art.example/Repo/Path', { indexFile: 'index-v1.json' }));
    expect(generateSourceId('artifactory', 'https://ART.example/Repo/Path', { indexFile: 'INDEX.JSON' }))
      .toBe(generateSourceId('artifactory', 'https://art.example/Repo/Path', { indexFile: 'INDEX.JSON' }));
    expect(generateSourceId('artifactory', 'https://art.example/Repo/Path', { indexFile: 'INDEX.JSON' }))
      .not.toBe(generateSourceId('artifactory', 'https://art.example/repo/path', { indexFile: 'INDEX.JSON' }));
    expect(generateSourceId('artifactory', 'https://art.example/Repo/Path', { indexFile: 'INDEX.JSON' }))
      .not.toBe(generateSourceId('artifactory', 'https://art.example/Repo/Path', { indexFile: 'index.json' }));
  });
});
