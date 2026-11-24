import {
  describe,
  expectTypeOf,
  it,
} from 'vitest';
import type {
  Bundle,
  SourceAdapter,
} from '../../src';

describe('source adapter compatibility v1', () => {
  it('accepts existing callback-based extension catalogs without changing their argument contract', () => {
    type IncrementalCatalog = (onPartialBundles?: (bundles: Bundle[]) => void | Promise<void>) => Promise<Bundle[]>;
    expectTypeOf<IncrementalCatalog>().toExtend<SourceAdapter['fetchBundles']>();
  });
});
