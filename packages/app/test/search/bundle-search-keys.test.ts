import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  resolveBundleSearchKeys,
} from '../../src/search';

describe('resolveBundleSearchKeys', () => {
  it('maps source-level index records to catalog bundle identities', () => {
    const keys = resolveBundleSearchKeys(
      [
        { sourceId: 'github-source', bundleId: 'github-source' },
        { sourceId: 'awesome-source', bundleId: 'collection-b' }
      ],
      [
        { sourceId: 'github-source', bundleId: 'owner-repo-v1.2.3' },
        { sourceId: 'awesome-source', bundleId: 'collection-a' },
        { sourceId: 'awesome-source', bundleId: 'collection-b' }
      ]
    );

    expect(keys).toEqual([
      'github-source\u0000owner-repo-v1.2.3',
      'awesome-source\u0000collection-b'
    ]);
  });

  it('preserves ranked order and removes duplicate catalog identities', () => {
    const keys = resolveBundleSearchKeys(
      [
        { sourceId: 'source', bundleId: 'bundle' },
        { sourceId: 'source', bundleId: 'bundle' }
      ],
      [{ sourceId: 'source', bundleId: 'bundle' }]
    );

    expect(keys).toEqual(['source\u0000bundle']);
  });
});
