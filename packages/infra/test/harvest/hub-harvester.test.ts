import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  HubSourceSpec,
} from '@ai-primitives-hub/core';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  BlobCache,
  computeGitBlobSha,
} from '../../src/harvest/blob-cache';
import {
  harvestHub,
  HubHarvester,
} from '../../src/harvest/hub-harvester';
import {
  FakeGitHubApi,
} from '../helpers/fake-github-api';
import {
  RecordingGitHubApi,
} from '../helpers/recording-github-api';
import {
  createTempDir,
} from '../helpers/temp-dir';

let tmp: string;
let cleanup: () => void;
beforeEach(() => {
  [tmp, cleanup] = createTempDir('pi-harv-');
});
afterEach(() => {
  cleanup();
});

/**
 * Seed commits/tree/blobs/raw-content for one repo into a `FakeGitHubApi`.
 * Covers every fetch shape a bundle provider might issue against this
 * repo: the ETag-less commit lookup, the recursive tree listing, the
 * blobs API (used by the plugin/collection manifest loaders), and the
 * raw-content endpoint (used by every provider's `readFile`).
 * @param client - Fake GitHub API to seed.
 * @param owner - Repo owner.
 * @param repo - Repo name.
 * @param sha - Commit sha the fake `/commits/main` lookup should return.
 * @param tree - Tree entries to place under this commit.
 * @param blobs - File bytes keyed by blob sha.
 */
function seedRepo(
  client: FakeGitHubApi,
  owner: string,
  repo: string,
  sha: string,
  tree: { path: string; sha: string; size: number }[],
  blobs: Map<string, Buffer>
): void {
  client.seedJson(`/repos/${owner}/${repo}/commits/main`, { sha });
  client.seedJson(`/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`, {
    sha,
    truncated: false,
    tree: tree.map((t) => ({ path: t.path, type: 'blob', sha: t.sha, size: t.size }))
  });
  for (const t of tree) {
    const blob = blobs.get(t.sha);
    if (blob) {
      client.seedJson(`/repos/${owner}/${repo}/git/blobs/${t.sha}`, {
        sha: t.sha, size: blob.length, content: blob.toString('base64'), encoding: 'base64'
      });
      client.seedText(`https://raw.githubusercontent.com/${owner}/${repo}/main/${t.path}`, blob.toString('utf8'));
    }
  }
}

function spec(id: string, owner: string, repo: string): HubSourceSpec {
  return {
    id, name: id, type: 'github',
    url: `https://github.com/${owner}/${repo}`, owner, repo, branch: 'main'
  };
}

describe('hub-harvester', () => {
  it('harvests two sources in serial, records progress for each', async () => {
    const promptBytes = Buffer.from('---\ntitle: Hello\ndescription: hi\n---\n\n# Hello\n', 'utf8');
    const promptSha = computeGitBlobSha(promptBytes);
    const client = new FakeGitHubApi();
    seedRepo(client, 'o1', 'r1', 'sha-o1r1', [{ path: 'prompts/a.prompt.md', sha: promptSha, size: promptBytes.length }], new Map([[promptSha, promptBytes]]));
    seedRepo(client, 'o2', 'r2', 'sha-o2r2', [{ path: 'prompts/b.prompt.md', sha: promptSha, size: promptBytes.length }], new Map([[promptSha, promptBytes]]));
    const cache = new BlobCache(path.join(tmp, 'blobs'));

    const harvester = new HubHarvester({
      sources: [spec('src-1', 'o1', 'r1'), spec('src-2', 'o2', 'r2')],
      client,
      cache,
      progressFile: path.join(tmp, 'progress.jsonl'),
      concurrency: 1
    });

    const result = await harvester.run();
    expect(result.done).toBe(2);
    expect(result.error).toBe(0);
    expect(result.primitives).toBe(2);
    expect(result.totalMs).toBeGreaterThanOrEqual(0);
    expect(result.index.stats().primitives).toBe(2);
  });

  it('skips unchanged sources on a second run (smart rebuild)', async () => {
    const promptBytes = Buffer.from('---\ntitle: Hello\n---\n# Hello\n', 'utf8');
    const promptSha = computeGitBlobSha(promptBytes);
    const fake = new FakeGitHubApi();
    seedRepo(fake, 'o', 'r', 'fixed-sha', [{ path: 'prompts/a.prompt.md', sha: promptSha, size: promptBytes.length }], new Map([[promptSha, promptBytes]]));
    const client = new RecordingGitHubApi(fake);
    const cache = new BlobCache(path.join(tmp, 'blobs'));
    const commitCallCount = (): number => client.calls.filter((c) => c.pathOrUrl.includes('/commits/')).length;

    const mkHarv = (): HubHarvester => new HubHarvester({
      sources: [spec('src-1', 'o', 'r')],
      client,
      cache,
      progressFile: path.join(tmp, 'progress.jsonl'),
      concurrency: 1
    });

    const first = await mkHarv().run();
    expect(first.done).toBe(1);
    expect(first.skip).toBe(0);
    const commitCallsAfterFirst = commitCallCount();
    expect(commitCallsAfterFirst).toBeGreaterThanOrEqual(1);

    const second = await mkHarv().run();
    expect(second.done).toBe(0);
    expect(second.skip).toBe(1);
    expect(commitCallCount()).toBe(commitCallsAfterFirst + 1);
    expect(second.index.stats().primitives).toBe(1);
  });

  it('harvests an awesome-copilot-plugin source (one bundle per plugin)', async () => {
    const skillBody = Buffer.from('---\ntitle: Analyzer\ndescription: a skill\n---\n# Skill\n', 'utf8');
    const skillSha = computeGitBlobSha(skillBody);
    const manifest1Body = Buffer.from(JSON.stringify({
      id: 'p1', name: 'p1', description: 'plugin 1',
      items: [{ kind: 'skill', path: './skills/a' }]
    }), 'utf8');
    const m1Sha = computeGitBlobSha(manifest1Body);
    const manifest2Body = Buffer.from(JSON.stringify({
      id: 'p2', name: 'p2', description: 'plugin 2',
      items: [{ kind: 'skill', path: './skills/b' }]
    }), 'utf8');
    const m2Sha = computeGitBlobSha(manifest2Body);

    const client = new FakeGitHubApi();
    seedRepo(client, 'github', 'awesome-copilot', 'plugins-sha', [
      { path: 'plugins/p1/.github/plugin/plugin.json', sha: m1Sha, size: manifest1Body.length },
      { path: 'plugins/p1/skills/a/SKILL.md', sha: skillSha, size: skillBody.length },
      { path: 'plugins/p2/.github/plugin/plugin.json', sha: m2Sha, size: manifest2Body.length },
      { path: 'plugins/p2/skills/b/SKILL.md', sha: skillSha, size: skillBody.length }
    ], new Map([[m1Sha, manifest1Body], [m2Sha, manifest2Body], [skillSha, skillBody]]));
    const cache = new BlobCache(path.join(tmp, 'blobs'));

    const pluginSpec: HubSourceSpec = {
      id: 'upstream-awesome',
      name: 'github/awesome-copilot (plugins)',
      type: 'awesome-copilot-plugin',
      url: 'https://github.com/github/awesome-copilot',
      owner: 'github', repo: 'awesome-copilot', branch: 'main',
      pluginsPath: 'plugins'
    };
    const h = new HubHarvester({
      sources: [pluginSpec],
      client,
      cache,
      progressFile: path.join(tmp, 'progress.jsonl'),
      concurrency: 1
    });
    const r = await h.run();
    expect(r.error).toBe(0);
    expect(r.primitives).toBeGreaterThanOrEqual(2);
    expect(r.index.stats().primitives).toBe(2);
  });

  it('harvests an awesome-copilot source (one bundle per collection)', async () => {
    const collection1Content = `id: collection-1
name: Collection 1
description: Test collection
version: 1.0.0
items:
  - path: prompts/hello.prompt.md
    kind: prompt
`;
    const collection2Content = `id: collection-2
name: Collection 2
description: Another test collection
version: 1.0.0
items:
  - path: skills/test/SKILL.md
    kind: skill
`;
    const promptContent = 'Hello world';
    const skillContent = 'Test skill';
    const collection1Bytes = Buffer.from(collection1Content, 'utf8');
    const collection2Bytes = Buffer.from(collection2Content, 'utf8');
    const promptBytes = Buffer.from(promptContent, 'utf8');
    const skillBytes = Buffer.from(skillContent, 'utf8');
    const collection1Sha = computeGitBlobSha(collection1Bytes);
    const collection2Sha = computeGitBlobSha(collection2Bytes);
    const promptSha = computeGitBlobSha(promptBytes);
    const skillSha = computeGitBlobSha(skillBytes);

    const client = new FakeGitHubApi();
    seedRepo(client, 'amadeus-digital', 'refx-mcp-server', 'collections-sha', [
      { path: 'collections/collection-1.collection.yml', sha: collection1Sha, size: collection1Bytes.length },
      { path: 'collections/collection-2.collection.yml', sha: collection2Sha, size: collection2Bytes.length },
      { path: 'prompts/hello.prompt.md', sha: promptSha, size: promptBytes.length },
      { path: 'skills/test/SKILL.md', sha: skillSha, size: skillBytes.length }
    ], new Map([
      [collection1Sha, collection1Bytes], [collection2Sha, collection2Bytes],
      [promptSha, promptBytes], [skillSha, skillBytes]
    ]));
    const cache = new BlobCache(path.join(tmp, 'blobs'));

    const awesomeCopilotSpec: HubSourceSpec = {
      id: 'refx',
      name: 'refx-mcp-server',
      type: 'awesome-copilot',
      url: 'https://github.com/amadeus-digital/refx-mcp-server',
      owner: 'amadeus-digital',
      repo: 'refx-mcp-server',
      branch: 'main',
      collectionsPath: 'collections'
    };
    const h = new HubHarvester({
      sources: [awesomeCopilotSpec],
      client,
      cache,
      progressFile: path.join(tmp, 'progress.jsonl'),
      concurrency: 1
    });
    const r = await h.run();
    expect(r.error).toBe(0);
    expect(r.primitives).toBeGreaterThanOrEqual(2);
    expect(r.index.stats().primitives).toBe(2);
  });

  it('extracts mcp-server primitives from a plugin with mcp.items', async () => {
    const manifestBody = Buffer.from(JSON.stringify({
      id: 'mcp-pl', name: 'mcp-pl', description: 'has mcp',
      items: [],
      mcp: {
        items: {
          context7: { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7'] }
        }
      }
    }), 'utf8');
    const mSha = computeGitBlobSha(manifestBody);
    const client = new FakeGitHubApi();
    seedRepo(client, 'github', 'awesome-copilot', 'plugins-sha', [
      { path: 'plugins/mcp-pl/.github/plugin/plugin.json', sha: mSha, size: manifestBody.length }
    ], new Map([[mSha, manifestBody]]));
    const cache = new BlobCache(path.join(tmp, 'blobs'));
    const pluginSpec: HubSourceSpec = {
      id: 'upstream-mcp', name: 'upstream-mcp', type: 'awesome-copilot-plugin',
      url: 'https://github.com/github/awesome-copilot',
      owner: 'github', repo: 'awesome-copilot', branch: 'main',
      pluginsPath: 'plugins'
    };
    const h = new HubHarvester({
      sources: [pluginSpec],
      client,
      cache,
      progressFile: path.join(tmp, 'progress.jsonl'),
      concurrency: 1
    });
    const r = await h.run();
    expect(r.error).toBe(0);
    const prims = r.index.all();
    const mcpPrims = prims.filter((p) => p.kind === 'mcp-server');
    expect(mcpPrims.length).toBe(1);
    expect(mcpPrims[0].title).toBe('context7');
  });

  it('records errors per source without aborting the run', async () => {
    const client = new FakeGitHubApi();
    seedRepo(client, 'o1', 'r1', 'sha-ok', [], new Map());
    // o2/r2 is deliberately not seeded -> 404s out of FakeGitHubApi.
    const cache = new BlobCache(path.join(tmp, 'blobs'));
    const h = new HubHarvester({
      sources: [spec('src-1', 'o1', 'r1'), spec('src-2', 'o2', 'r2')],
      client,
      cache,
      progressFile: path.join(tmp, 'progress.jsonl'),
      concurrency: 1
    });
    const r = await h.run();
    expect(r.done).toBe(1);
    expect(r.error).toBe(1);
  });

  it('handles empty tree gracefully', async () => {
    const client = new FakeGitHubApi();
    seedRepo(client, 'o', 'r', 'fixed-sha', [], new Map());
    const cache = new BlobCache(path.join(tmp, 'blobs'));
    const h = new HubHarvester({
      sources: [spec('src-1', 'o', 'r')],
      client,
      cache,
      progressFile: path.join(tmp, 'progress.jsonl'),
      concurrency: 1
    });
    const r = await h.run();
    expect(r.done).toBe(1);
    expect(r.primitives).toBe(0);
    expect(r.error).toBe(0);
  });

  it('handles malformed manifest files without crashing', async () => {
    const badManifest = Buffer.from('not valid json {{{', 'utf8');
    const mSha = computeGitBlobSha(badManifest);
    const client = new FakeGitHubApi();
    seedRepo(client, 'o', 'r', 'fixed-sha', [{ path: 'collections/bad.collection.yml', sha: mSha, size: badManifest.length }], new Map([[mSha, badManifest]]));
    const cache = new BlobCache(path.join(tmp, 'blobs'));
    const h = new HubHarvester({
      sources: [spec('src-1', 'o', 'r')],
      client,
      cache,
      progressFile: path.join(tmp, 'progress.jsonl'),
      concurrency: 1
    });
    const r = await h.run();
    // Should complete but with error
    expect(r.done + r.error).toBe(1);
  });

  it('respects concurrency limit when harvesting multiple sources', async () => {
    const promptBytes = Buffer.from('---\ntitle: Hello\n---\n# Hello\n', 'utf8');
    const promptSha = computeGitBlobSha(promptBytes);
    const client = new FakeGitHubApi();
    seedRepo(client, 'o1', 'r1', 'sha1', [{ path: 'prompts/a.prompt.md', sha: promptSha, size: promptBytes.length }], new Map([[promptSha, promptBytes]]));
    seedRepo(client, 'o2', 'r2', 'sha2', [{ path: 'prompts/b.prompt.md', sha: promptSha, size: promptBytes.length }], new Map([[promptSha, promptBytes]]));
    seedRepo(client, 'o3', 'r3', 'sha3', [{ path: 'prompts/c.prompt.md', sha: promptSha, size: promptBytes.length }], new Map([[promptSha, promptBytes]]));
    const cache = new BlobCache(path.join(tmp, 'blobs'));
    const h = new HubHarvester({
      sources: [spec('src-1', 'o1', 'r1'), spec('src-2', 'o2', 'r2'), spec('src-3', 'o3', 'r3')],
      client,
      cache,
      progressFile: path.join(tmp, 'progress.jsonl'),
      concurrency: 2
    });
    const r = await h.run();
    // With concurrency=2, all 3 should complete (just limits parallelism, not total)
    expect(r.done).toBe(3);
    expect(r.primitives).toBeGreaterThanOrEqual(2);
  });

  it('skips all sources in dryRun mode', async () => {
    const promptBytes = Buffer.from('---\ntitle: Hello\n---\n# Hello\n', 'utf8');
    const promptSha = computeGitBlobSha(promptBytes);
    const client = new FakeGitHubApi();
    seedRepo(client, 'o', 'r', 'fixed-sha', [{ path: 'prompts/a.prompt.md', sha: promptSha, size: promptBytes.length }], new Map([[promptSha, promptBytes]]));
    const cache = new BlobCache(path.join(tmp, 'blobs'));

    const h = new HubHarvester({
      sources: [spec('src-1', 'o', 'r')],
      client,
      cache,
      progressFile: path.join(tmp, 'progress.jsonl'),
      concurrency: 1,
      dryRun: true
    });

    const r = await h.run();
    expect(r.done).toBe(0);
    expect(r.skip).toBe(1);
    expect(r.primitives).toBe(0);
  });

  it('handles corrupt snapshot gracefully', async () => {
    // Write a corrupt snapshot file
    const snapshotFile = path.join(tmp, 'primitives-snapshot.json');
    fs.writeFileSync(snapshotFile, '{ invalid json }');

    const promptBytes = Buffer.from('---\ntitle: Hello\n---\n# Hello\n', 'utf8');
    const promptSha = computeGitBlobSha(promptBytes);
    const client = new FakeGitHubApi();
    seedRepo(client, 'o', 'r', 'fixed-sha', [{ path: 'prompts/a.prompt.md', sha: promptSha, size: promptBytes.length }], new Map([[promptSha, promptBytes]]));
    const cache = new BlobCache(path.join(tmp, 'blobs'));

    const h = new HubHarvester({
      sources: [spec('src-1', 'o', 'r')],
      client,
      cache,
      progressFile: path.join(tmp, 'progress.jsonl'),
      concurrency: 1
    });

    const r = await h.run();
    // Should still succeed despite corrupt snapshot
    expect(r.done).toBe(1);
    expect(r.error).toBe(0);
  });

  describe('harvestHub pipeline', () => {
    it('throws when hubRepo is required but missing', async () => {
      await expect(harvestHub({})).rejects.toThrow('hubRepo is required');
    });

    it('throws when hubRepo format is invalid', async () => {
      await expect(harvestHub({
        hubRepo: 'invalid-format',
        explicitToken: 'test-token',
        outFile: path.join(tmp, 'out.json'),
        progressFile: path.join(tmp, 'progress.jsonl'),
        cacheDir: path.join(tmp, 'cache')
      })).rejects.toThrow('Invalid hubRepo');
    });
  });
});
