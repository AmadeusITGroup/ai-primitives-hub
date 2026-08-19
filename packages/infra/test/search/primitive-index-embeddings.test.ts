import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  harvest,
} from '../../src/harvest/harvester';
import {
  TernlightEmbeddingProvider,
} from '../../src/search/embedding/ternlight-embedding-provider';
import {
  PrimitiveIndex,
} from '../../src/search/primitive-index';
import {
  loadIndex,
  saveIndex,
} from '../../src/stores/json-index-store';
import {
  createFixtureBundles,
  FakeBundleProvider,
} from '../fixtures/primitive-index';

async function buildEmbeddedIndex(): Promise<PrimitiveIndex> {
  const provider = new FakeBundleProvider(createFixtureBundles());
  return PrimitiveIndex.buildFrom(provider, {
    embeddings: new TernlightEmbeddingProvider()
  });
}

describe('PrimitiveIndex embeddings', () => {
  it('builds an index with embeddings when a provider is supplied', async () => {
    const idx = await buildEmbeddedIndex();
    const json = idx.toJSON() as {
      searchProfileId?: string | null;
      embeddingsMeta?: { provider: string; dim: number } | null;
      primitives: { embedding?: number[] }[];
    };
    expect(json.searchProfileId).toBe('ternlight-single-v1');
    expect(json.embeddingsMeta).toBeTruthy();
    expect(json.embeddingsMeta?.dim).toBe(384);
    expect(json.embeddingsMeta?.strategy).toBe('summary');

    const withEmbedding = json.primitives.filter((p) => p.embedding && p.embedding.length > 0);
    expect(withEmbedding.length).toBe(json.primitives.length);
  });

  it('buildFromPrimitives without embeddings does not store embeddings', async () => {
    const provider = new FakeBundleProvider(createFixtureBundles());
    const prims = await harvest(provider);
    const idx = PrimitiveIndex.fromPrimitives(prims);
    const json = idx.toJSON() as {
      embeddingsMeta?: { provider: string; dim: number } | null;
    };
    expect(json.embeddingsMeta ?? null).toBeNull();
  });

  it('supports hybrid search with a query embedding', async () => {
    const idx = await buildEmbeddedIndex();
    const embedder = new TernlightEmbeddingProvider();
    const [queryEmbedding] = await embedder.embed(['rust setup']);
    const res = idx.search({ q: 'rust setup', ranking: 'hybrid', queryEmbedding, limit: 5 });
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.hits[0].score).toBeGreaterThan(0);
  });

  it('round-trips embeddings through saveIndex/loadIndex', async () => {
    const idx = await buildEmbeddedIndex();
    const file = path.join(os.tmpdir(), `pi-embed-${Date.now()}.json`);
    try {
      saveIndex(idx, file);
      const loaded = loadIndex(file);
      const json = loaded.toJSON() as {
        embeddingsMeta?: { provider: string; dim: number } | null;
        primitives: { embedding?: number[] }[];
      };
      expect(json.embeddingsMeta).toBeTruthy();
      expect(json.embeddingsMeta?.strategy).toBe('summary');
      expect(json.primitives.some((p) => p.embedding && p.embedding.length === 384)).toBe(true);

      const embedder = new TernlightEmbeddingProvider();
      const [queryEmbedding] = await embedder.embed(['terraform']);
      const res = loaded.search({ q: 'terraform', ranking: 'hybrid', queryEmbedding, limit: 5 });
      expect(res.hits.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('builds a dual-embedding index and supports multi-vector search', async () => {
    const provider = new FakeBundleProvider(createFixtureBundles());
    const idx = await PrimitiveIndex.buildFrom(provider, {
      embeddings: new TernlightEmbeddingProvider(),
      embeddingStrategy: 'dual'
    });
    const json = idx.toJSON() as {
      searchProfileId?: string | null;
      embeddingsMeta?: { provider: string; dim: number; embeddingStrategy?: string } | null;
      primitives: { embeddings?: Record<string, number[]> }[];
    };
    expect(json.searchProfileId).toBe('ternlight-dual-v1');
    expect(json.embeddingsMeta?.embeddingStrategy).toBe('dual');
    expect(json.primitives[0]?.embeddings?.metadata).toHaveLength(384);
    expect(json.primitives[0]?.embeddings?.body).toHaveLength(384);

    const embedder = new TernlightEmbeddingProvider();
    const [metadataQuery] = await embedder.embed(['terraform']);
    const [bodyQuery] = await embedder.embed(['infrastructure provisioning']);
    const res = idx.search({
      q: 'terraform infrastructure',
      ranking: 'multi',
      queryEmbeddings: { metadata: metadataQuery, body: bodyQuery },
      embeddingWeights: { bm25: 0.6, metadata: 0.15, body: 0.25 },
      limit: 5
    });
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.hits[0].score).toBeGreaterThan(0);
  });
});
