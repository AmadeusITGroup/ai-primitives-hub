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
  AwesomeCopilotBundleProvider,
} from '../../../src/harvest/bundle-providers/awesome-copilot-bundle-provider';
import {
  FakeGitHubApi,
} from '../../helpers/fake-github-api';
import {
  createTempDir,
} from '../../helpers/temp-dir';

let tmp: string;
let cleanup: () => void;
beforeEach(() => {
  [tmp, cleanup] = createTempDir('pi-acprov-');
});
afterEach(() => {
  cleanup();
});

function makeSpec(): HubSourceSpec {
  return {
    id: 'src-a',
    name: 'Src A',
    type: 'awesome-copilot',
    url: 'https://github.com/o/r',
    owner: 'o',
    repo: 'r',
    branch: 'main',
    collectionsPath: 'collections'
  };
}

/**
 * Seed commits/tree/blob + raw-content responses for one or more collection files.
 * @param client - Fake GitHub API to seed.
 * @param commitSha - Commit sha the fake `/commits/main` lookup should return.
 * @param files - Files to place in the tree, keyed by repo-relative path.
 */
function seedCollections(
  client: FakeGitHubApi,
  commitSha: string,
  files: { name: string; content: string }[]
): void {
  client.seedJson('/repos/o/r/commits/main', { sha: commitSha });
  const tree = files.map((f) => {
    const bytes = Buffer.from(f.content, 'utf8');
    const sha = computeGitBlobSha(bytes);
    client.seedText(`https://raw.githubusercontent.com/o/r/main/${f.name}`, f.content);
    return { path: f.name, type: 'blob', sha, size: bytes.length };
  });
  client.seedJson(`/repos/o/r/git/trees/${commitSha}?recursive=1`, { sha: commitSha, truncated: false, tree });
}

async function collectRefs(provider: AwesomeCopilotBundleProvider): Promise<BundleRef[]> {
  const refs: BundleRef[] = [];
  for await (const r of provider.listBundles()) {
    refs.push(r);
  }
  return refs;
}

describe('AwesomeCopilotBundleProvider', () => {
  it('lists one bundle per collection file with collection.id as bundleId', async () => {
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
    const client = new FakeGitHubApi();
    seedCollections(client, 'abc123', [
      { name: 'collections/collection-1.collection.yml', content: collection1Content },
      { name: 'collections/collection-2.collection.yml', content: collection2Content }
    ]);
    const cache = new BlobCache(tmp);
    const provider = new AwesomeCopilotBundleProvider({ spec: makeSpec(), client, cache });

    const refs = await collectRefs(provider);

    expect(refs.length).toBe(2);
    expect(refs[0]).toStrictEqual({
      sourceId: 'src-a', sourceType: 'awesome-copilot',
      bundleId: 'collection-1', bundleVersion: 'abc123', installed: false
    });
    expect(refs[1]).toStrictEqual({
      sourceId: 'src-a', sourceType: 'awesome-copilot',
      bundleId: 'collection-2', bundleVersion: 'abc123', installed: false
    });
  });

  it('readManifest returns synthetic manifest with collection metadata', async () => {
    const collectionContent = `id: test-collection
name: Test Collection
description: A test collection
version: 2.0.0
items:
  - path: prompts/hello.prompt.md
    kind: prompt
`;
    const client = new FakeGitHubApi();
    seedCollections(client, 'sha1', [{ name: 'collections/test-collection.collection.yml', content: collectionContent }]);
    const cache = new BlobCache(tmp);
    const provider = new AwesomeCopilotBundleProvider({ spec: makeSpec(), client, cache });

    const refs = await collectRefs(provider);
    const manifest = await provider.readManifest(refs[0]);
    expect(manifest.id).toBe('test-collection');
    expect(manifest.version).toBe('sha1');
    expect(manifest.name).toBe('Test Collection');
    expect(manifest.description).toBe('A test collection');
    expect(manifest.tags).toEqual(['awesome-copilot']);
    expect(manifest.items?.length).toBe(1);
    expect(manifest.items?.[0].path).toBe('prompts/hello.prompt.md');
  });

  it('readFile fetches file content from raw GitHub', async () => {
    const collectionContent = `id: test
name: Test
version: 1.0.0
items:
  - path: prompts/hello.prompt.md
    kind: prompt
`;
    const promptContent = 'Hello world';
    const client = new FakeGitHubApi();
    seedCollections(client, 'sha1', [
      { name: 'collections/test.collection.yml', content: collectionContent },
      { name: 'prompts/hello.prompt.md', content: promptContent }
    ]);
    const cache = new BlobCache(tmp);
    const provider = new AwesomeCopilotBundleProvider({ spec: makeSpec(), client, cache });

    const refs = await collectRefs(provider);
    const content = await provider.readFile(refs[0], 'prompts/hello.prompt.md');
    expect(content).toBe(promptContent);
  });

  it('uses custom collectionsPath from config', async () => {
    const collectionContent = `id: test
name: Test
version: 1.0.0
items: []
`;
    const customSpec: HubSourceSpec = {
      ...makeSpec(),
      collectionsPath: 'prompt-registry/collections'
    };
    const client = new FakeGitHubApi();
    seedCollections(client, 'sha1', [{ name: 'prompt-registry/collections/test.collection.yml', content: collectionContent }]);
    const cache = new BlobCache(tmp);
    const provider = new AwesomeCopilotBundleProvider({ spec: customSpec, client, cache });

    const refs = await collectRefs(provider);
    expect(refs.length).toBe(1);
    expect(refs[0].bundleId).toBe('test');
  });

  it('throws error when readManifest called with unknown bundleId', async () => {
    const collectionContent = `id: test
name: Test
version: 1.0.0
items: []
`;
    const client = new FakeGitHubApi();
    seedCollections(client, 'sha1', [{ name: 'collections/test.collection.yml', content: collectionContent }]);
    const cache = new BlobCache(tmp);
    const provider = new AwesomeCopilotBundleProvider({ spec: makeSpec(), client, cache });

    const unknownRef: BundleRef = {
      sourceId: 'src-a', sourceType: 'awesome-copilot',
      bundleId: 'unknown-bundle', bundleVersion: 'sha1', installed: false
    };
    await expect(provider.readManifest(unknownRef)).rejects.toThrow('Collection file not found');
  });

  it('throws error when readFile called with path not in repo tree', async () => {
    const collectionContent = `id: test
name: Test
version: 1.0.0
items: []
`;
    const client = new FakeGitHubApi();
    seedCollections(client, 'sha1', [{ name: 'collections/test.collection.yml', content: collectionContent }]);
    const cache = new BlobCache(tmp);
    const provider = new AwesomeCopilotBundleProvider({ spec: makeSpec(), client, cache });

    const refs = await collectRefs(provider);
    await expect(provider.readFile(refs[0], 'nonexistent/file.md')).rejects.toThrow('not a primitive candidate');
  });

  it('getCommitSha returns the commit sha', async () => {
    const collectionContent = `id: test
name: Test
version: 1.0.0
items: []
`;
    const client = new FakeGitHubApi();
    seedCollections(client, 'abc123', [{ name: 'collections/test.collection.yml', content: collectionContent }]);
    const cache = new BlobCache(tmp);
    const provider = new AwesomeCopilotBundleProvider({ spec: makeSpec(), client, cache });

    const commitSha = await provider.getCommitSha();
    expect(commitSha).toBe('abc123');
  });

  it('skips collections with invalid YAML', async () => {
    const invalidContent = 'invalid: yaml: content: [unclosed';
    const validContent = `id: valid
name: Valid
version: 1.0.0
items: []
`;
    const client = new FakeGitHubApi();
    seedCollections(client, 'sha1', [
      { name: 'collections/invalid.collection.yml', content: invalidContent },
      { name: 'collections/valid.collection.yml', content: validContent }
    ]);
    const cache = new BlobCache(tmp);
    const provider = new AwesomeCopilotBundleProvider({ spec: makeSpec(), client, cache });

    const refs = await collectRefs(provider);
    expect(refs.length).toBe(1);
    expect(refs[0].bundleId).toBe('valid');
  });

  it('skips collections missing id field', async () => {
    const noIdContent = `name: No ID
version: 1.0.0
items: []
`;
    const validContent = `id: valid
name: Valid
version: 1.0.0
items: []
`;
    const client = new FakeGitHubApi();
    seedCollections(client, 'sha1', [
      { name: 'collections/no-id.collection.yml', content: noIdContent },
      { name: 'collections/valid.collection.yml', content: validContent }
    ]);
    const cache = new BlobCache(tmp);
    const provider = new AwesomeCopilotBundleProvider({ spec: makeSpec(), client, cache });

    const refs = await collectRefs(provider);
    expect(refs.length).toBe(1);
    expect(refs[0].bundleId).toBe('valid');
  });

  it('infers kind from file path when item.kind is missing', async () => {
    const collectionContent = `id: test
name: Test
version: 1.0.0
items:
  - path: prompts/hello.prompt.md
  - path: instructions/guide.instructions.md
  - path: skills/my-skill/skill.md
`;
    const client = new FakeGitHubApi();
    seedCollections(client, 'sha1', [{ name: 'collections/test.collection.yml', content: collectionContent }]);
    const cache = new BlobCache(tmp);
    const provider = new AwesomeCopilotBundleProvider({ spec: makeSpec(), client, cache });

    const refs = await collectRefs(provider);
    const manifest = await provider.readManifest(refs[0]);
    expect(manifest.items?.[0].kind).toBe('prompt');
    expect(manifest.items?.[1].kind).toBe('instruction');
    expect(manifest.items?.[2].kind).toBe('skill');
  });
});
