import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getBundleRefKey,
} from '@ai-primitives-hub/core';
import {
  LocalFolderBundleProvider,
} from '@ai-primitives-hub/infra';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  buildIndex,
  canonicalizeIndexHubId,
  searchIndex,
  SearchIndexError,
  searchPrimitives,
} from '../../src/search';

describe('canonicalizeIndexHubId', () => {
  it('converges generated timestamp-suffixed ids with their stable base id', () => {
    expect(canonicalizeIndexHubId('amadeus-hub-788228')).toBe('amadeus-hub');
  });

  it('preserves explicit ids that do not use the generated suffix format', () => {
    expect(canonicalizeIndexHubId('team-hub')).toBe('team-hub');
  });
});

describe('searchIndex', () => {
  let tempDir: string;
  let bundleDir: string;
  let embeddedIndex: string;
  let plainIndex: string;
  let keyedIndex: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'app-search-index-test-'));
    bundleDir = path.join(tempDir, 'local-foo');
    await fs.promises.mkdir(path.join(bundleDir, 'prompts'), { recursive: true });
    await fs.promises.writeFile(
      path.join(bundleDir, 'deployment-manifest.yml'),
      'id: local-foo\nversion: 1.0.0\nname: Local Foo\nitems:\n  - path: prompts/hello.prompt.md\n    kind: prompt\n'
    );
    await fs.promises.writeFile(
      path.join(bundleDir, 'prompts', 'hello.prompt.md'),
      '# Hello Prompt\n\nA diagnostic prompt.\n'
    );

    const provider = new LocalFolderBundleProvider({ root: tempDir, sourceId: 'local' });
    embeddedIndex = path.join(tempDir, 'embedded.json');
    plainIndex = path.join(tempDir, 'plain.json');
    keyedIndex = path.join(tempDir, 'keyed.json');
    await buildIndex({ provider, outFile: embeddedIndex, embed: true });
    await buildIndex({ provider, outFile: plainIndex, embed: false });
    await buildIndex({
      provider,
      outFile: keyedIndex,
      indexKey: {
        hubId: 'local-hub',
        sourceRevision: 'source-revision-1',
        searchProfileId: 'bm25-v1'
      }
    });
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it('performs keyword search with bm25 ranking', async () => {
    const result = await searchIndex({
      indexPath: embeddedIndex,
      query: { q: 'hello', limit: 5 }
    });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0].primitive.title.toLowerCase()).toContain('hello');
  });

  it('performs hybrid search on an embedded index', async () => {
    const result = await searchIndex({
      indexPath: embeddedIndex,
      query: { q: 'diagnostic prompt', limit: 5 },
      ranking: 'hybrid'
    });
    expect(result.hits.length).toBeGreaterThan(0);
  });

  it('rejects hybrid ranking on a non-embedded index', async () => {
    await expect(searchIndex({
      indexPath: plainIndex,
      query: { q: 'diagnostic prompt', limit: 5 },
      ranking: 'hybrid'
    })).rejects.toBeInstanceOf(SearchIndexError);
  });

  it('rejects hybrid ranking without a text query', async () => {
    await expect(searchIndex({
      indexPath: embeddedIndex,
      query: { limit: 5 },
      ranking: 'hybrid'
    })).rejects.toBeInstanceOf(SearchIndexError);
  });

  it('rejects a profile that is incompatible with the persisted index', async () => {
    await expect(searchIndex({
      indexPath: embeddedIndex,
      query: { q: 'diagnostic prompt', limit: 5 },
      profile: 'ternlight-dual-v1'
    })).rejects.toMatchObject({
      code: 'PROFILE_MISMATCH'
    });
  });

  it('rejects a namespaced index with an incompatible source revision', async () => {
    await expect(searchIndex({
      indexPath: keyedIndex,
      indexKey: {
        hubId: 'local-hub',
        sourceRevision: 'source-revision-2',
        searchProfileId: 'bm25-v1'
      },
      query: { q: 'hello', limit: 5 }
    })).rejects.toMatchObject({
      code: 'SOURCE_REVISION_MISMATCH'
    });
  });

  it('reports the shared profile and embedding mode used for a query', async () => {
    const result = await searchIndex({
      indexPath: embeddedIndex,
      query: { q: 'diagnostic prompt', limit: 5 },
      profile: 'ternlight-single-v1'
    });
    expect(result.searchProfileId).toBe('ternlight-single-v1');
    expect(result.ranking).toBe('hybrid');
    expect(result.embeddingUsed).toBe(true);
  });

  it('infers the persisted embedding profile when no ranking is supplied', async () => {
    const result = await searchIndex({
      indexPath: embeddedIndex,
      query: { q: 'diagnostic prompt', limit: 5 }
    });
    expect(result.searchProfileId).toBe('ternlight-single-v1');
    expect(result.ranking).toBe('hybrid');
    expect(result.embeddingUsed).toBe(true);
  });

  it('keeps CLI-style and extension-style searches equivalent', async () => {
    const cliResult = await searchIndex({
      indexPath: embeddedIndex,
      query: { q: 'diagnostic prompt', limit: 5 }
    });
    const extensionResult = await searchIndex({
      indexPath: embeddedIndex,
      query: { q: 'diagnostic prompt', limit: 5 },
      profile: 'ternlight-single-v1'
    });

    expect(cliResult.hits.map((hit) => hit.primitive.id))
      .toEqual(extensionResult.hits.map((hit) => hit.primitive.id));
    expect(cliResult.searchProfileId).toBe(extensionResult.searchProfileId);
    expect(cliResult.ranking).toBe(extensionResult.ranking);
    expect(cliResult.embeddingUsed).toBe(extensionResult.embeddingUsed);
  });
});

describe('searchPrimitives', () => {
  let tempDir: string;
  let bundleDir: string;
  let embeddedIndex: string;
  let plainIndex: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'app-search-primitives-test-'));
    bundleDir = path.join(tempDir, 'local-foo');
    await fs.promises.mkdir(path.join(bundleDir, 'prompts'), { recursive: true });
    await fs.promises.writeFile(
      path.join(bundleDir, 'deployment-manifest.yml'),
      'id: local-foo\nversion: 1.0.0\nname: Local Foo\nitems:\n  - path: prompts/hello.prompt.md\n    kind: prompt\n'
    );
    await fs.promises.writeFile(
      path.join(bundleDir, 'prompts', 'hello.prompt.md'),
      '# Hello Prompt\n\nA diagnostic prompt.\n'
    );

    const provider = new LocalFolderBundleProvider({ root: tempDir, sourceId: 'local' });
    embeddedIndex = path.join(tempDir, 'embedded.json');
    plainIndex = path.join(tempDir, 'plain.json');
    await buildIndex({ provider, outFile: embeddedIndex, embed: true });
    await buildIndex({ provider, outFile: plainIndex, embed: false });
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it('returns a typed ready response for a compatible persisted index', async () => {
    const response = await searchPrimitives({
      indexPath: plainIndex,
      request: { q: 'hello', limit: 5 }
    });

    expect(response.status).toBe('ready');
    expect(response.index.state).toBe('ready');
    expect(response.index.searchProfileId).toBe('bm25-v1');
    expect(response.result?.hits[0]?.primitive.title).toBe('Hello Prompt');
    expect(response.warning).toBeUndefined();
  });

  it('preserves lifecycle partial and refreshing states while returning indexed results', async () => {
    const partial = await searchPrimitives({
      indexPath: plainIndex,
      indexStatus: {
        state: 'partial',
        sourceCoverage: [{ sourceId: 'unsupported-source', state: 'unsupported' }]
      },
      request: { q: 'hello', limit: 5 }
    });
    const refreshing = await searchPrimitives({
      indexPath: plainIndex,
      indexStatus: { state: 'refreshing' },
      request: { q: 'hello', limit: 5 }
    });

    expect(partial.status).toBe('degraded');
    expect(partial.index.state).toBe('partial');
    expect(partial.result?.hits).toHaveLength(1);
    expect(refreshing.status).toBe('degraded');
    expect(refreshing.index.state).toBe('refreshing');
    expect(refreshing.result?.hits).toHaveLength(1);
  });

  it('applies the installed bundle overlay without rebuilding the index', async () => {
    const initial = await searchPrimitives({
      indexPath: plainIndex,
      request: { q: 'hello', limit: 5 }
    });
    const bundle = initial.result?.hits[0]?.primitive.bundle;
    expect(bundle).toBeDefined();

    const response = await searchPrimitives({
      indexPath: plainIndex,
      installedBundleKeys: [getBundleRefKey(bundle!)],
      request: { q: 'hello', installedOnly: true, limit: 5 }
    });

    expect(response.status).toBe('ready');
    expect(response.result?.hits).toHaveLength(1);
    expect(response.result?.hits[0]?.primitive.bundle.installed).toBe(true);
  });

  it('maps a missing persisted index to an unavailable response', async () => {
    const response = await searchPrimitives({
      indexPath: path.join(tempDir, 'missing.json'),
      request: { q: 'hello' }
    });

    expect(response).toMatchObject({
      status: 'unavailable',
      index: { state: 'missing' },
      warning: { code: 'INDEX_MISSING' }
    });
  });

  it('maps an incompatible profile to an unavailable response with a typed cause', async () => {
    const response = await searchPrimitives({
      indexPath: embeddedIndex,
      request: { q: 'diagnostic prompt', profile: 'ternlight-dual-v1' }
    });

    expect(response).toMatchObject({
      status: 'unavailable',
      index: { state: 'incompatible' },
      warning: {
        code: 'INDEX_INCOMPATIBLE',
        causeCode: 'PROFILE_MISMATCH'
      }
    });
  });

  it('maps an unreadable persisted index to a failed response', async () => {
    const malformedIndex = path.join(tempDir, 'malformed.json');
    await fs.promises.writeFile(malformedIndex, '{ not-json }');

    const response = await searchPrimitives({
      indexPath: malformedIndex,
      request: { q: 'hello' }
    });

    expect(response).toMatchObject({
      status: 'unavailable',
      index: { state: 'failed' },
      warning: { code: 'SEARCH_FAILED' }
    });
  });
});
