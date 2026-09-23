import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
  HubSourceSpec,
  ProcessExecutor,
  ProcessResult,
  ProcessRunOptions,
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

class SourceAwareHarvestHttpClient implements HttpClient {
  public constructor(
    private readonly metadataStatus = 200,
    private readonly repositoryPrivate = false
  ) {}

  public async fetch(request: HttpRequest): Promise<HttpResponse> {
    const pathName = new URL(request.url).pathname;
    let statusCode = 200;
    let body: unknown = {};
    if (pathName.endsWith('/owner/repo')) {
      statusCode = request.headers?.Authorization === 'token generic-token' ? this.metadataStatus : 200;
      body = { private: this.repositoryPrivate };
    } else if (pathName.endsWith('/commits/main')) {
      body = { sha: 'source-aware-sha' };
    } else if (pathName.includes('/git/trees/')) {
      body = { tree: [], truncated: false };
    }
    return {
      statusCode,
      body: new TextEncoder().encode(statusCode === 200 ? JSON.stringify(body) : '{}'),
      finalUrl: request.url,
      headers: {}
    };
  }
}

class RecordingAppProcessExecutor implements ProcessExecutor {
  public readonly calls: { file: string; args: readonly string[]; options: ProcessRunOptions | undefined }[] = [];

  public async execFile(file: string, args: readonly string[], options?: ProcessRunOptions): Promise<ProcessResult> {
    this.calls.push({ file, args, options });
    return args.includes('setup')
      ? { stdout: '', stderr: '' }
      : { stdout: 'installation-token\n', stderr: '' };
  }
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
    expect(result.sourceCoverage).toEqual([
      { sourceId: 'src-1', state: 'indexed', primitives: 1, revision: 'sha-o1r1' },
      { sourceId: 'src-2', state: 'indexed', primitives: 1, revision: 'sha-o2r2' }
    ]);
  });

  it('uses a separate client from the factory for each source', async () => {
    const promptBytes = Buffer.from('---\ntitle: Hello\n---\n# Hello\n', 'utf8');
    const promptSha = computeGitBlobSha(promptBytes);
    const client = new FakeGitHubApi();
    seedRepo(client, 'o1', 'r1', 'sha-o1r1', [{ path: 'prompts/a.prompt.md', sha: promptSha, size: promptBytes.length }], new Map([[promptSha, promptBytes]]));
    seedRepo(client, 'o2', 'r2', 'sha-o2r2', [{ path: 'prompts/b.prompt.md', sha: promptSha, size: promptBytes.length }], new Map([[promptSha, promptBytes]]));
    const created: string[] = [];
    const cache = new BlobCache(path.join(tmp, 'blobs'));

    const result = await new HubHarvester({
      sources: [spec('src-1', 'o1', 'r1'), spec('src-2', 'o2', 'r2')],
      client,
      clientFactory: (source) => {
        created.push(source.id);
        return new RecordingGitHubApi(client);
      },
      cache,
      progressFile: path.join(tmp, 'progress.jsonl'),
      concurrency: 2
    }).run();

    expect(result.done).toBe(2);
    expect(created.toSorted()).toEqual(['src-1', 'src-2']);
  });

  it('reuses a source-aware preflight commit revision', async () => {
    const client = new FakeGitHubApi();
    seedRepo(client, 'o', 'r', 'preflight-sha', [], new Map());
    const recording = new RecordingGitHubApi(client);
    const result = await new HubHarvester({
      sources: [spec('src-1', 'o', 'r')],
      client: recording,
      sourcePreflightRevisions: new Map([['src-1', 'preflight-sha']]),
      cache: new BlobCache(path.join(tmp, 'blobs')),
      progressFile: path.join(tmp, 'progress.jsonl'),
      concurrency: 1,
      dryRun: true
    }).run();

    expect(result.skip).toBe(1);
    expect(recording.calls.filter((call) => call.pathOrUrl.includes('/commits/'))).toHaveLength(0);
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
    expect(second.sourceCoverage).toEqual([
      { sourceId: 'src-1', state: 'skipped', message: 'already-harvested', revision: 'fixed-sha' }
    ]);
  });

  it('retains the last successful source snapshot when a warm run fails', async () => {
    const promptBytes = Buffer.from('---\ntitle: Hello\n---\n# Hello\n', 'utf8');
    const promptSha = computeGitBlobSha(promptBytes);
    const fake = new FakeGitHubApi();
    seedRepo(fake, 'o', 'r', 'first-sha', [{ path: 'prompts/a.prompt.md', sha: promptSha, size: promptBytes.length }], new Map([[promptSha, promptBytes]]));
    const cache = new BlobCache(path.join(tmp, 'blobs'));
    const options = {
      sources: [spec('src-1', 'o', 'r')],
      client: fake,
      cache,
      progressFile: path.join(tmp, 'progress.jsonl'),
      concurrency: 1
    } as const;

    const first = await new HubHarvester(options).run();
    expect(first.index.stats().primitives).toBe(1);

    // The commit moved, but the subsequent tree request is unavailable. The
    // warm run must keep the last known-good primitive rather than replacing
    // the persisted source snapshot with an empty array.
    fake.seedJson('/repos/o/r/commits/main', { sha: 'second-sha' });
    const second = await new HubHarvester(options).run();
    expect(second.error).toBe(1);
    expect(second.index.stats().primitives).toBe(1);
    expect(second.sourceCoverage).toHaveLength(1);
    expect(second.sourceCoverage[0]).toMatchObject({
      sourceId: 'src-1',
      state: 'failed',
      revision: 'second-sha'
    });
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

    it('does not write an index during a dry run', async () => {
      const outFile = path.join(tmp, 'dry-run-index.json');
      await harvestHub({
        noHubConfig: true,
        dryRun: true,
        outFile,
        progressFile: path.join(tmp, 'dry-run-progress.jsonl'),
        cacheDir: path.join(tmp, 'dry-run-cache')
      });
      expect(fs.existsSync(outFile)).toBe(false);
    });

    it('allows public extra-source harvests to continue anonymously when no token exists', async () => {
      // Keep this test local and deterministic by injecting its boundaries.
      const client = new FakeGitHubApi();
      seedRepo(client, 'octocat', 'hello-world', 'hello-sha', [], new Map());

      const result = await harvestHub({
        noHubConfig: true,
        dryRun: true,
        extraSources: ['id=hello,type=github,url=https://github.com/octocat/hello-world'],
        outFile: path.join(tmp, 'anonymous-index.json'),
        progressFile: path.join(tmp, 'anonymous-progress.jsonl'),
        cacheDir: path.join(tmp, 'anonymous-cache'),
        githubApi: client,
        tokenResolver: {
          readEnv: () => undefined,
          readGhCli: () => Promise.resolve(undefined)
        }
      });

      expect(result.tokenSource).toBe('none');
    });

    it('runs generic source-aware preflight and harvests with category-bound clients', async () => {
      const configFile = path.join(tmp, 'hub-config.yml');
      fs.writeFileSync(configFile, [
        'sources:',
        '  - id: public-source',
        '    type: github',
        '    url: https://github.com/owner/repo',
        'profiles: []',
        ''
      ].join('\n'));

      const result = await harvestHub({
        hubConfigFile: configFile,
        dryRun: true,
        httpClient: new SourceAwareHarvestHttpClient(),
        outFile: path.join(tmp, 'source-aware-index.json'),
        progressFile: path.join(tmp, 'source-aware-progress.jsonl'),
        cacheDir: path.join(tmp, 'source-aware-cache')
      }, {
        AI_PRIMITIVES_HUB_GH_APP_AUTH_ENABLED: 'true',
        GH_TOKEN: 'generic-token'
      });

      expect(result.tokenSource).toBe('source-aware');
      expect(result.totals.error).toBe(0);
      expect(result).toHaveProperty('sourcePreflight');
      expect((result as { sourcePreflight?: { valid: boolean; results: { sourceId: string; category: string }[] } }).sourcePreflight).toMatchObject({
        valid: true,
        results: [{ sourceId: 'public-source', category: 'public-generic' }]
      });
      expect(result.sourceCoverage).toEqual([{
        sourceId: 'public-source',
        state: 'skipped',
        revision: 'source-aware-sha',
        authenticationCategory: 'public-generic',
        message: 'dry-run'
      }]);
    });

    it('provisions an ephemeral App config from pipeline inputs before authenticated harvest', async () => {
      const configFile = path.join(tmp, 'private-bootstrap-config.yml');
      fs.writeFileSync(configFile, [
        'sources:',
        '  - id: private-source',
        '    type: github',
        '    url: https://github.com/owner/repo',
        '    owner: owner',
        '    repo: repo',
        '    branch: main',
        'profiles: []',
        ''
      ].join('\n'));
      const executor = new RecordingAppProcessExecutor();
      const result = await harvestHub({
        hubConfigFile: configFile,
        dryRun: true,
        githubAppId: '123',
        githubAppKeyFile: '/tmp/app-key.pem',
        processExecutor: executor,
        httpClient: new SourceAwareHarvestHttpClient(404),
        outFile: path.join(tmp, 'private-bootstrap-index.json'),
        progressFile: path.join(tmp, 'private-bootstrap-progress.jsonl'),
        cacheDir: path.join(tmp, 'private-bootstrap-cache')
      }, {
        GH_TOKEN: 'generic-token'
      });

      expect(result.tokenSource).toBe('source-aware');
      expect(result.sourceCoverage).toEqual([{
        sourceId: 'private-source',
        state: 'skipped',
        revision: 'source-aware-sha',
        authenticationCategory: 'app-authenticated',
        message: 'dry-run'
      }]);
      expect(executor.calls).toHaveLength(2);
      expect(executor.calls[0]?.args).toContain('github.com/owner/*');
      expect(executor.calls[1]?.args).toContain('github.com/owner/repo');
      const configPath = executor.calls[0]?.options?.env?.GH_APP_AUTH_CONFIG;
      expect(configPath).toBeDefined();
      expect(fs.existsSync(configPath!)).toBe(false);
    });

    it('fails source-aware harvest when a private source has no App configuration', async () => {
      const configFile = path.join(tmp, 'private-hub-config.yml');
      fs.writeFileSync(configFile, [
        'sources:',
        '  - id: private-source',
        '    type: github',
        '    url: https://github.com/owner/repo',
        'profiles: []',
        ''
      ].join('\n'));

      await expect(harvestHub({
        hubConfigFile: configFile,
        dryRun: true,
        httpClient: new SourceAwareHarvestHttpClient(404),
        outFile: path.join(tmp, 'private-index.json'),
        progressFile: path.join(tmp, 'private-progress.jsonl'),
        cacheDir: path.join(tmp, 'private-cache')
      }, {
        AI_PRIMITIVES_HUB_GH_APP_AUTH_ENABLED: 'true',
        GH_TOKEN: 'generic-token'
      })).rejects.toMatchObject({
        code: 'GH_SOURCE_PREFLIGHT_FAILED',
        report: {
          valid: false,
          results: [{
            sourceId: 'private-source',
            errorCode: 'GH_APP_AUTH_CONFIG_MISSING'
          }]
        }
      });
    });

    it('preserves the complete source preflight report on a fail-closed harvest error', async () => {
      const configFile = path.join(tmp, 'structured-preflight-config.yml');
      fs.writeFileSync(configFile, [
        'sources:',
        '  - id: private-source',
        '    type: github',
        '    url: https://github.com/owner/repo',
        'profiles: []',
        ''
      ].join('\n'));

      await expect(harvestHub({
        hubConfigFile: configFile,
        dryRun: true,
        httpClient: new SourceAwareHarvestHttpClient(404, true),
        outFile: path.join(tmp, 'structured-preflight-index.json'),
        progressFile: path.join(tmp, 'structured-preflight-progress.jsonl'),
        cacheDir: path.join(tmp, 'structured-preflight-cache')
      }, {
        AI_PRIMITIVES_HUB_GH_APP_AUTH_ENABLED: 'true',
        GH_TOKEN: 'generic-token'
      })).rejects.toMatchObject({
        code: 'GH_SOURCE_PREFLIGHT_FAILED',
        report: {
          valid: false,
          appRoutes: ['github.com/owner/*'],
          results: [{
            sourceId: 'private-source',
            category: 'unresolved',
            errorCode: 'GH_APP_AUTH_CONFIG_MISSING',
            operations: ['repository metadata']
          }]
        }
      });
    });
  });
});
