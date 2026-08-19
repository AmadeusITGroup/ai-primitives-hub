import {
  cosineSim,
} from '@ternlight/mini';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  TernlightEmbeddingProvider,
} from '../../src/search/embedding/ternlight-embedding-provider';

function l2Norm(v: Float32Array): number {
  let sum = 0;
  for (const x of v) {
    sum += x * x;
  }
  return Math.sqrt(sum);
}

describe('TernlightEmbeddingProvider', () => {
  it('exposes a 384-dimensional embedding model', () => {
    const provider = new TernlightEmbeddingProvider();
    expect(provider.dim).toBe(384);
  });

  it('embeds a batch of texts into unit L2-normalised vectors', async () => {
    const provider = new TernlightEmbeddingProvider();
    const vectors = await provider.embed(['hello world', 'unit test example']);
    expect(vectors).toHaveLength(2);
    for (const v of vectors) {
      expect(v).toBeInstanceOf(Float32Array);
      expect(v.length).toBe(384);
      expect(l2Norm(v)).toBeCloseTo(1, 5);
    }
  });

  it('returns an empty array for an empty batch', async () => {
    const provider = new TernlightEmbeddingProvider();
    const vectors = await provider.embed([]);
    expect(vectors).toStrictEqual([]);
  });

  it('produces higher cosine similarity for related texts than unrelated ones', async () => {
    const provider = new TernlightEmbeddingProvider();
    const [a, b, c] = await provider.embed([
      'write unit tests for an Angular component',
      'generate Jasmine unit tests',
      'deploy a Docker container to Kubernetes'
    ]);
    const related = cosineSim(a, b);
    const unrelated = cosineSim(a, c);
    expect(related).toBeGreaterThan(unrelated);
    expect(related).toBeGreaterThan(0);
  });
});
