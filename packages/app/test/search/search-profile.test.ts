import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  createEmbeddingProvider,
  getSearchProfile,
} from '../../src/search/search-profile';

describe('search profiles', () => {
  it('exposes stable BM25 and TernLite profiles', () => {
    expect(getSearchProfile('bm25-v1')).toMatchObject({
      id: 'bm25-v1',
      ranking: 'bm25',
      embeddingStrategy: undefined
    });
    expect(getSearchProfile('ternlight-single-v1')).toMatchObject({
      id: 'ternlight-single-v1',
      ranking: 'hybrid',
      embeddingProvider: 'ternlight-mini',
      embeddingStrategy: 'single'
    });
    expect(getSearchProfile('ternlight-dual-v1')).toMatchObject({
      id: 'ternlight-dual-v1',
      ranking: 'multi',
      embeddingProvider: 'ternlight-mini',
      embeddingStrategy: 'dual'
    });
  });

  it('uses the same TernLite provider contract for embedded profiles', () => {
    const provider = createEmbeddingProvider(getSearchProfile('ternlight-single-v1'));
    expect(provider.name).toBe('ternlight-mini');
    expect(provider.dim).toBe(384);
  });

  it('does not create an embedding provider for BM25', () => {
    expect(createEmbeddingProvider(getSearchProfile('bm25-v1'))).toBeUndefined();
  });

  it('rejects unknown profiles', () => {
    expect(() => getSearchProfile('unknown-v1')).toThrow(/Unknown search profile/);
  });
});
