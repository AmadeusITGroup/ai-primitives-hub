import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  isBundleUpdateArray,
  isSourceArray,
} from '../../../src/domain/registry/guards';

describe('isBundleUpdateArray', () => {
  it('accepts a well-formed BundleUpdate array', () => {
    expect(isBundleUpdateArray([
      { bundleId: 'a', currentVersion: '1.0.0', latestVersion: '2.0.0' }
    ])).toBe(true);
  });

  it('accepts an empty array', () => {
    expect(isBundleUpdateArray([])).toBe(true);
  });

  it('rejects a non-array', () => {
    expect(isBundleUpdateArray({})).toBe(false);
    expect(isBundleUpdateArray(null)).toBe(false);
    expect(isBundleUpdateArray(undefined)).toBe(false);
  });

  it('rejects an array with items missing required fields', () => {
    expect(isBundleUpdateArray([{ bundleId: 'a' }])).toBe(false);
    expect(isBundleUpdateArray([{ bundleId: 'a', currentVersion: '1.0.0' }])).toBe(false);
    expect(isBundleUpdateArray([null])).toBe(false);
  });
});

describe('isSourceArray', () => {
  it('accepts a well-formed source array', () => {
    expect(isSourceArray([
      { id: 'gh-1', type: 'github', name: 'GH' }
    ])).toBe(true);
  });

  it('accepts an empty array', () => {
    expect(isSourceArray([])).toBe(true);
  });

  it('rejects a non-array', () => {
    expect(isSourceArray('not-an-array')).toBe(false);
  });

  it('rejects an array with items missing required fields', () => {
    expect(isSourceArray([{ id: 'gh-1', type: 'github' }])).toBe(false);
    expect(isSourceArray([{}])).toBe(false);
  });
});
