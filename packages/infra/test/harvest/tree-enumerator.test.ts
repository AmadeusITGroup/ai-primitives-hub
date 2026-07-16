import * as path from 'node:path';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  EtagStore,
} from '../../src/harvest/etag-store';
import {
  enumerateRepoTree,
  isPrimitiveCandidatePath,
  resolveCommitSha,
} from '../../src/harvest/tree-enumerator';
import {
  FakeGitHubApi,
} from '../helpers/fake-github-api';
import {
  RecordingGitHubApi,
} from '../helpers/recording-github-api';
import {
  createTempDir,
} from '../helpers/temp-dir';

describe('tree-enumerator', () => {
  it('isPrimitiveCandidatePath recognises the known kinds (and nothing else)', () => {
    const yes = [
      'prompts/foo.prompt.md',
      'instructions/bar.instructions.md',
      'chatmodes/baz.chatmode.md',
      'agents/qux.agent.md',
      'skills/demo/SKILL.md',
      'mcp.json',
      'collection.yml',
      'deployment-manifest.yml',
      '.vscode/mcp.json'
    ];
    for (const p of yes) {
      expect(isPrimitiveCandidatePath(p)).toBe(true);
    }
    const no = [
      'README.md',
      'src/index.ts',
      'package.json',
      '.github/workflows/ci.yml',
      'deep/node_modules/thing.js'
    ];
    for (const p of no) {
      expect(isPrimitiveCandidatePath(p)).toBe(false);
    }
  });

  it('resolves a branch to a commit sha and enumerates primitive candidates', async () => {
    const client = new FakeGitHubApi();
    client.seedJson('/repos/o/r/commits/main', { sha: 'cafe1234' });
    client.seedJson('/repos/o/r/git/trees/cafe1234?recursive=1', {
      sha: 'cafe1234',
      truncated: false,
      tree: [
        { path: 'prompts/a.prompt.md', type: 'blob', sha: 'aaaa', size: 10 },
        { path: 'README.md', type: 'blob', sha: 'bbbb', size: 50 },
        { path: 'collections/x/collection.yml', type: 'blob', sha: 'cccc', size: 100 },
        { path: 'collections/x', type: 'tree', sha: 'xxxx' }
      ]
    });
    const r = await enumerateRepoTree(client, { owner: 'o', repo: 'r', ref: 'main' });
    expect(r.commitSha).toBe('cafe1234');
    expect(
      r.candidates.map((c) => c.path).toSorted()
    ).toStrictEqual(
      ['collections/x/collection.yml', 'prompts/a.prompt.md']
    );
    expect(r.candidates.find((c) => c.path === 'prompts/a.prompt.md')?.blobSha).toBe('aaaa');
  });

  it('throws a descriptive error on truncated trees', async () => {
    const client = new FakeGitHubApi();
    client.seedJson('/repos/o/r/commits/main', { sha: 'sha1' });
    client.seedJson('/repos/o/r/git/trees/sha1?recursive=1', { sha: 'sha1', truncated: true, tree: [] });
    await expect(
      enumerateRepoTree(client, { owner: 'o', repo: 'r', ref: 'main' })
    ).rejects.toThrow(/truncated/i);
  });

  it('resolveCommitSha uses EtagStore and replays cached sha on 304', async () => {
    const [tmp, cleanup] = createTempDir('pi-enum-etag-');
    const fake = new FakeGitHubApi();
    fake.seedJson('/repos/o/r/commits/main', { sha: 'sha-1' }, '"etag-1"');
    const client = new RecordingGitHubApi(fake);
    const store = await EtagStore.open(path.join(tmp, 'etags.json'));

    const sha1 = await resolveCommitSha(client, { owner: 'o', repo: 'r', ref: 'main', etagStore: store });
    await store.save();
    expect(sha1).toBe('sha-1');
    expect(client.countOf('getJsonWithEtag')).toBe(1);

    const reopened = await EtagStore.open(path.join(tmp, 'etags.json'));
    const sha2 = await resolveCommitSha(client, { owner: 'o', repo: 'r', ref: 'main', etagStore: reopened });
    expect(sha2).toBe('sha-1');
    expect(client.countOf('getJsonWithEtag')).toBe(2);

    cleanup();
  });

  it('supports a custom path prefix filter (for awesome-copilot collectionsPath)', async () => {
    const client = new FakeGitHubApi();
    client.seedJson('/repos/o/r/commits/main', { sha: 'abc' });
    client.seedJson('/repos/o/r/git/trees/abc?recursive=1', {
      sha: 'abc',
      truncated: false,
      tree: [
        { path: 'collections/a/prompts/x.prompt.md', type: 'blob', sha: 'a1', size: 1 },
        { path: 'other/prompts/y.prompt.md', type: 'blob', sha: 'a2', size: 1 }
      ]
    });
    const r = await enumerateRepoTree(client, {
      owner: 'o', repo: 'r', ref: 'main', pathPrefix: 'collections/'
    });
    expect(r.candidates.map((c) => c.path)).toStrictEqual(['collections/a/prompts/x.prompt.md']);
  });
});
