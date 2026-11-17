import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  findMissingRequiredBundles,
} from '../../../src/domain/hub/profile-requirements';
import type {
  HubProfileBundle,
} from '../../../src/domain/hub/types';

const bundle = (id: string, required: boolean): HubProfileBundle => ({ id, version: '1.0.0', source: 'src', required });

describe('findMissingRequiredBundles', () => {
  it('returns required bundles that were not installed, in profile order', () => {
    const bundles = [bundle('c', true), bundle('a', true), bundle('b', true)];

    expect(findMissingRequiredBundles(bundles, ['a'])).toEqual(['c', 'b']);
  });

  it('ignores optional bundles that were not installed', () => {
    const bundles = [bundle('a', true), bundle('opt', false)];

    expect(findMissingRequiredBundles(bundles, ['a'])).toEqual([]);
  });

  it('returns an empty list when every required bundle is installed', () => {
    expect(findMissingRequiredBundles([bundle('a', true)], new Set(['a', 'extra']))).toEqual([]);
  });
});
