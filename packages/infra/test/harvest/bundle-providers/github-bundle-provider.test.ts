import type {
  BundleRef,
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
} from '../../../src/harvest/blob-cache';
import {
  GitHubSingleBundleProvider,
} from '../../../src/harvest/bundle-providers/github-bundle-provider';
import {
  FakeGitHubApi,
} from '../../helpers/fake-github-api';
import {
  RecordingGitHubApi,
} from '../../helpers/recording-github-api';
import {
  createTempDir,
} from '../../helpers/temp-dir';

let tmp: string;
let cleanup: () => void;
beforeEach(() => {
  [tmp, cleanup] = createTempDir('pi-ghprov-');
});
afterEach(() => {
  cleanup();
});

function makeSpec(): HubSourceSpec {
  return {
    id: 'src-a', name: 'Src A', type: 'github',
    url: 'https://github.com/o/r', owner: 'o', repo: 'r',
    branch: 'main'
  };
}

async function collectRefs(provider: GitHubSingleBundleProvider): Promise<BundleRef[]> {
  const refs: BundleRef[] = [];
  for await (const r of provider.listBundles()) {
    refs.push(r);
  }
  return refs;
}

describe('GitHubSingleBundleProvider', () => {
  it('readFile delegates to the authorized client for the raw content URL', async () => {
    const skillContent = '---\ntitle: My Skill\n---\n\n# My Skill\nBody text.\n';
    const skillBytes = Buffer.from(skillContent, 'utf8');
    const skillSha = computeGitBlobSha(skillBytes);
    const fake = new FakeGitHubApi();
    fake.seedJson('/repos/o/r/commits/main', { sha: 'deadbeef' });
    fake.seedJson('/repos/o/r/git/trees/deadbeef?recursive=1', {
      sha: 'deadbeef',
      truncated: false,
      tree: [{ path: 'skills/my-skill/SKILL.md', type: 'blob', sha: skillSha, size: skillBytes.length }]
    });
    fake.seedText('https://raw.githubusercontent.com/o/r/main/skills/my-skill/SKILL.md', skillContent);
    const client = new RecordingGitHubApi(fake);
    const cache = new BlobCache(tmp);
    const provider = new GitHubSingleBundleProvider({ spec: makeSpec(), client, cache });

    const refs = await collectRefs(provider);
    const content = await provider.readFile(refs[0], 'skills/my-skill/SKILL.md');
    expect(content).toContain('title: My Skill');
    // The provider must delegate the raw fetch to the same authorized
    // client it was given, rather than an unauthenticated fetch of its
    // own — auth-header correctness itself is GitHubApiClient's concern
    // (covered by github-api-client.test.ts).
    expect(
      client.calls.some((c) => c.method === 'getText' && c.pathOrUrl.includes('raw.githubusercontent.com'))
    ).toBe(true);
  });

  it('lists one bundle with commit sha from the branch ref', async () => {
    const client = new FakeGitHubApi();
    client.seedJson('/repos/o/r/commits/main', { sha: 'abc123' });
    client.seedJson('/repos/o/r/git/trees/abc123?recursive=1', { sha: 'abc123', truncated: false, tree: [] });
    const cache = new BlobCache(tmp);
    const provider = new GitHubSingleBundleProvider({ spec: makeSpec(), client, cache });
    const refs = await collectRefs(provider);
    expect(refs.length).toBe(1);
    expect(refs[0]).toStrictEqual({
      sourceId: 'src-a', sourceType: 'github',
      bundleId: 'src-a', bundleVersion: 'abc123', installed: false
    });
  });

  it('readManifest synthesises items from the tree', async () => {
    const promptBytes = Buffer.from('---\ntitle: P\n---\n\n# P\n', 'utf8');
    const promptSha = computeGitBlobSha(promptBytes);
    const client = new FakeGitHubApi();
    client.seedJson('/repos/o/r/commits/main', { sha: 'sha1' });
    client.seedJson('/repos/o/r/git/trees/sha1?recursive=1', {
      sha: 'sha1',
      truncated: false,
      tree: [
        { path: 'prompts/p.prompt.md', type: 'blob', sha: promptSha, size: promptBytes.length },
        { path: 'README.md', type: 'blob', sha: '0000', size: 100 }
      ]
    });
    client.seedText('https://raw.githubusercontent.com/o/r/main/prompts/p.prompt.md', promptBytes.toString('utf8'));
    const cache = new BlobCache(tmp);
    const provider = new GitHubSingleBundleProvider({ spec: makeSpec(), client, cache });
    const refs = await collectRefs(provider);
    const manifest = await provider.readManifest(refs[0]);
    expect(manifest.id).toBe('src-a');
    expect(manifest.version).toBe('sha1');
    expect(manifest.items?.length).toBe(1);
    expect(manifest.items?.[0].path).toBe('prompts/p.prompt.md');

    const content = await provider.readFile(refs[0], 'prompts/p.prompt.md');
    expect(content).toMatch(/title: P/);

    await expect(provider.readFile(refs[0], 'README.md')).rejects.toThrow(/not a primitive candidate/);
  });

  it('respects pathPrefix option when enumerating tree', async () => {
    const promptBytes = Buffer.from('---\ntitle: P\n---\n\n# P\n', 'utf8');
    const promptSha = computeGitBlobSha(promptBytes);
    const client = new FakeGitHubApi();
    client.seedJson('/repos/o/r/commits/main', { sha: 'sha1' });
    client.seedJson('/repos/o/r/git/trees/sha1?recursive=1', {
      sha: 'sha1',
      truncated: false,
      tree: [
        { path: 'subdir/prompts/p.prompt.md', type: 'blob', sha: promptSha, size: promptBytes.length }
      ]
    });
    const cache = new BlobCache(tmp);
    const provider = new GitHubSingleBundleProvider({
      spec: makeSpec(), client, cache, pathPrefix: 'subdir'
    });
    const refs = await collectRefs(provider);
    const manifest = await provider.readManifest(refs[0]);
    expect(manifest.items?.length).toBe(1);
    expect(manifest.items?.[0].path).toBe('subdir/prompts/p.prompt.md');
  });

  it('respects bundleId override option', async () => {
    const client = new FakeGitHubApi();
    client.seedJson('/repos/o/r/commits/main', { sha: 'abc123' });
    client.seedJson('/repos/o/r/git/trees/abc123?recursive=1', { sha: 'abc123', truncated: false, tree: [] });
    const cache = new BlobCache(tmp);
    const provider = new GitHubSingleBundleProvider({
      spec: makeSpec(), client, cache, bundleId: 'custom-bundle-id'
    });
    const refs = await collectRefs(provider);
    expect(refs[0].bundleId).toBe('custom-bundle-id');
  });

  it('getCommitSha returns the commit sha from enumeration', async () => {
    const client = new FakeGitHubApi();
    client.seedJson('/repos/o/r/commits/main', { sha: 'commit-sha-123' });
    client.seedJson('/repos/o/r/git/trees/commit-sha-123?recursive=1', { sha: 'commit-sha-123', truncated: false, tree: [] });
    const cache = new BlobCache(tmp);
    const provider = new GitHubSingleBundleProvider({ spec: makeSpec(), client, cache });
    const commitSha = await provider.getCommitSha();
    expect(commitSha).toBe('commit-sha-123');
  });

  it('classifies file paths by extension in pathKindHint', async () => {
    const skillSha = 'f'.repeat(40);
    const client = new FakeGitHubApi();
    client.seedJson('/repos/o/r/commits/main', { sha: 'sha1' });
    client.seedJson('/repos/o/r/git/trees/sha1?recursive=1', {
      sha: 'sha1',
      truncated: false,
      tree: [
        { path: 'prompts/hello.prompt.md', type: 'blob', sha: skillSha, size: 10 },
        { path: 'instructions/instr.instructions.md', type: 'blob', sha: skillSha, size: 10 },
        { path: 'chatmodes/m.chatmode.md', type: 'blob', sha: skillSha, size: 10 },
        { path: 'agents/a.agent.md', type: 'blob', sha: skillSha, size: 10 },
        { path: 'skills/s.skill.md', type: 'blob', sha: skillSha, size: 10 },
        { path: 'mcp/mcp.json', type: 'blob', sha: skillSha, size: 10 }
      ]
    });
    const cache = new BlobCache(tmp);
    const provider = new GitHubSingleBundleProvider({ spec: makeSpec(), client, cache });
    const refs = await collectRefs(provider);
    const manifest = await provider.readManifest(refs[0]);
    expect(manifest.items).toBeDefined();
    expect(manifest.items?.[0].kind).toBe('prompt');
    expect(manifest.items?.[1].kind).toBe('instruction');
    expect(manifest.items?.[2].kind).toBe('chat-mode');
    expect(manifest.items?.[3].kind).toBe('agent');
    expect(manifest.items?.[4].kind).toBe('skill');
    expect(manifest.items?.[5].kind).toBe('mcp-server');
  });

  it('throws error when reading file not in repo tree', async () => {
    const client = new FakeGitHubApi();
    client.seedJson('/repos/o/r/commits/main', { sha: 'sha1' });
    client.seedJson('/repos/o/r/git/trees/sha1?recursive=1', { sha: 'sha1', truncated: false, tree: [] });
    const cache = new BlobCache(tmp);
    const provider = new GitHubSingleBundleProvider({ spec: makeSpec(), client, cache });
    const refs = await collectRefs(provider);
    await expect(provider.readFile(refs[0], 'prompts/missing.prompt.md')).rejects.toThrow('not found in repo tree');
  });

  it('throws error when reading non-primitive candidate file', async () => {
    const client = new FakeGitHubApi();
    client.seedJson('/repos/o/r/commits/main', { sha: 'sha1' });
    client.seedJson('/repos/o/r/git/trees/sha1?recursive=1', { sha: 'sha1', truncated: false, tree: [] });
    const cache = new BlobCache(tmp);
    const provider = new GitHubSingleBundleProvider({ spec: makeSpec(), client, cache });
    const refs = await collectRefs(provider);
    await expect(provider.readFile(refs[0], 'README.md')).rejects.toThrow('not a primitive candidate');
  });
});
