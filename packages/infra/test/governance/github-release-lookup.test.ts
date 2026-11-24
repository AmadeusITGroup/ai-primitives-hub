import type {
  GovernanceCollection,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  GitHubReleaseLookup,
} from '../../src/governance/github-release-lookup';
import {
  FakeGitHubApi,
} from '../helpers/fake-github-api';
import {
  RecordingGitHubApi,
} from '../helpers/recording-github-api';

const REPOSITORY = 'https://github.com/owner/repo';
const FIRST_PAGE = '/repos/owner/repo/releases?per_page=100&page=1';
const SECOND_PAGE = '/repos/owner/repo/releases?per_page=100&page=2';
const THIRD_PAGE = '/repos/owner/repo/releases?per_page=100&page=3';
const MANIFEST_URL = 'https://api.github.com/repos/owner/repo/releases/assets/1';
const ARCHIVE_URL = 'https://api.github.com/repos/owner/repo/releases/assets/2';
const OTHER_MANIFEST_URL = 'https://api.github.com/repos/owner/repo/releases/assets/3';
const MANIFEST = 'id: my-collection\nversion: 1.2.3\n';
// Unverified results explain why and how to fix, and never echo raw error text.
const UNVERIFIED = expect.objectContaining({
  status: 'unverified',
  message: expect.not.stringContaining('sensitive-error-marker'),
  hint: expect.any(String)
});

function collection(overrides: Partial<GovernanceCollection> = {}): GovernanceCollection {
  return { id: 'my-collection', sourceId: 'github-source', repository: REPOSITORY, ...overrides };
}

function asset(name: string, url: string): Record<string, unknown> {
  return { name, url };
}

function release(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: 'collection-v1.2.3',
    draft: false,
    prerelease: false,
    published_at: '2026-10-01T12:00:00Z',
    assets: [asset('deployment-manifest.yml', MANIFEST_URL), asset('bundle.zip', ARCHIVE_URL)],
    ...overrides
  };
}

function fixture(releases: unknown = [release()], manifest = MANIFEST) {
  const fake = new FakeGitHubApi().seedJson(FIRST_PAGE, releases).seedText(MANIFEST_URL, manifest);
  const api = new RecordingGitHubApi(fake);
  const apiForRepository = vi.fn(() => api);
  return { fake, api, apiForRepository, lookup: new GitHubReleaseLookup(apiForRepository) };
}

describe('GitHubReleaseLookup', () => {
  it.each([
    'my-collection',
    'owner-repo-my-collection-v1.2.3',
    'owner-repo-my-collection-1.2.3'
  ])('recognizes the exact raw or canonical collection ID %s', async (id) => {
    const { lookup } = fixture();
    expect(await lookup.lookup(collection({ id }))).toEqual({ status: 'published' });
  });

  it.each([
    ['deployment-manifest.yml', 'bundle.zip', MANIFEST],
    ['deployment-manifest.yaml', 'bundle.tar.gz', MANIFEST],
    ['deployment-manifest.json', 'bundle.zip', '{"id":"my-collection","version":"1.2.3"}']
  ])('accepts %s with a %s archive asset', async (manifestName, archiveName, content) => {
    const { lookup } = fixture([release({ assets: [asset(manifestName, MANIFEST_URL), asset(archiveName, ARCHIVE_URL)] })], content);
    expect(await lookup.lookup(collection())).toEqual({ status: 'published' });
  });

  it.each([
    'another-collection',
    'other-repo-my-collection-v1.2.3',
    'prefix-owner-repo-my-collection-1.2.3',
    'owner-repo-my-collection-v9.9.9',
    'MY-COLLECTION'
  ])('does not accept unrelated, suffix-only or wrong-version identity %s', async (id) => {
    const { lookup } = fixture();
    expect(await lookup.lookup(collection({ id }))).toEqual({ status: 'missing' });
  });

  it('does not infer a collection match from the release name or tag', async () => {
    const { lookup } = fixture([release({ tag_name: 'my-collection-v1.2.3', name: 'my-collection' })], 'id: unrelated\nversion: 1.2.3\n');
    expect(await lookup.lookup(collection())).toEqual({ status: 'missing' });
  });

  it.each([
    { assets: [] },
    { assets: [asset('bundle.zip', ARCHIVE_URL)] },
    { assets: [asset('deployment-manifest.yml', MANIFEST_URL)] },
    { assets: [asset('deployment-manifest.yml', MANIFEST_URL), asset('bundle.tgz', ARCHIVE_URL)] },
    { assets: [asset('nested/deployment-manifest.yml', MANIFEST_URL), asset('bundle.zip', ARCHIVE_URL)] }
  ])('requires both a standalone manifest and a supported archive: %j', async ({ assets }) => {
    const { lookup, api } = fixture([release({ assets })]);
    expect(await lookup.lookup(collection())).toEqual({ status: 'missing' });
    expect(api.countOf('getText')).toBe(0);
    expect(api.countOf('download')).toBe(0);
  });

  it.each([
    { draft: true, published_at: null },
    { prerelease: true }
  ])('excludes drafts and prereleases: %j', async (overrides) => {
    const { lookup, api } = fixture([release(overrides)]);
    expect(await lookup.lookup(collection())).toEqual({ status: 'missing' });
    expect(api.countOf('getText')).toBe(0);
  });

  it('returns missing for a completely accessible empty release list', async () => {
    expect(await fixture([]).lookup.lookup(collection())).toEqual({ status: 'missing' });
  });

  it('finds a matching release on page two after 100 earlier releases', async () => {
    const { lookup, fake, api } = fixture(Array.from({ length: 100 }, () => release({ assets: [] })));
    fake.seedJson(SECOND_PAGE, [release()]);
    expect(await lookup.lookup(collection())).toEqual({ status: 'published' });
    expect(api.calls.filter((call) => call.method === 'getJson').map((call) => call.pathOrUrl)).toEqual([FIRST_PAGE, SECOND_PAGE]);
  });

  it('does not stop pagination after finding a match', async () => {
    const { lookup, fake, api } = fixture(Array.from({ length: 100 }, () => release()));
    fake.seedJson(SECOND_PAGE, Array.from({ length: 100 }, () => release({ assets: [] }))).seedJson(THIRD_PAGE, []);
    expect(await lookup.lookup(collection())).toEqual({ status: 'published' });
    expect(api.calls.filter((call) => call.method === 'getJson').map((call) => call.pathOrUrl)).toEqual([FIRST_PAGE, SECOND_PAGE, THIRD_PAGE]);
  });

  it('checks beyond two full pages before returning missing', async () => {
    const { lookup, fake, api } = fixture(Array.from({ length: 100 }, () => release({ assets: [] })));
    fake.seedJson(SECOND_PAGE, Array.from({ length: 100 }, () => release({ assets: [] }))).seedJson(THIRD_PAGE, []);
    expect(await lookup.lookup(collection())).toEqual({ status: 'missing' });
    expect(api.countOf('getJson')).toBe(3);
  });

  it.each([
    '401 authentication failed',
    '403 access denied',
    '404 inaccessible repository',
    '429 rate limit',
    '503 unavailable',
    'JSON parse failure'
  ])('sanitizes release API failure: %s', async (failure) => {
    const { lookup, fake } = fixture();
    vi.spyOn(fake, 'getJson').mockRejectedValue(new Error(`${failure}: sensitive-error-marker`));
    expect(await lookup.lookup(collection())).toEqual(UNVERIFIED);
  });

  it('sanitizes a synchronous API factory failure and memoizes it', async () => {
    const apiForRepository = vi.fn(() => {
      throw new Error('sensitive-error-marker');
    });
    const lookup = new GitHubReleaseLookup(apiForRepository);
    const results = await Promise.all([lookup.lookup(collection()), lookup.lookup(collection({ id: 'other' }))]);
    expect(results).toEqual(Array.from({ length: 2 }, () => (UNVERIFIED)));
    expect(apiForRepository).toHaveBeenCalledTimes(1);
  });

  it('does not report missing when a later release page is inaccessible', async () => {
    const { lookup } = fixture(Array.from({ length: 100 }, () => release({ assets: [] })));
    expect(await lookup.lookup(collection())).toEqual(UNVERIFIED);
  });

  it('returns unverified when a candidate manifest cannot be downloaded', async () => {
    const { lookup, fake } = fixture();
    vi.spyOn(fake, 'getText').mockRejectedValue(new Error('sensitive-error-marker'));
    expect(await lookup.lookup(collection())).toEqual(UNVERIFIED);
  });

  it.each([
    'id: [invalid yaml',
    'null',
    '[]',
    'a scalar',
    'id: my-collection',
    'version: 1.2.3',
    'id: " "\nversion: 1.2.3',
    'id: my-collection\nversion: " "',
    'id: 123\nversion: 1.2.3',
    'id: my-collection\nversion: 123'
  ])('returns unverified for malformed or incomplete manifest %j', async (manifest) => {
    expect(await fixture([release()], manifest).lookup.lookup(collection())).toEqual(UNVERIFIED);
  });

  it('uses strict JSON parsing for JSON manifest assets', async () => {
    const { lookup } = fixture([release({ assets: [asset('deployment-manifest.json', MANIFEST_URL), asset('bundle.zip', ARCHIVE_URL)] })]);
    expect(await lookup.lookup(collection())).toEqual(UNVERIFIED);
  });

  it('accepts a valid match after an earlier unreadable candidate', async () => {
    const { lookup } = fixture([
      release({ assets: [asset('deployment-manifest.yml', OTHER_MANIFEST_URL), asset('bundle.zip', ARCHIVE_URL)] }),
      release()
    ]);
    expect(await lookup.lookup(collection())).toEqual({ status: 'published' });
  });

  it('accepts a valid match after an earlier malformed manifest', async () => {
    const { lookup, fake } = fixture([
      release({ assets: [asset('deployment-manifest.yml', OTHER_MANIFEST_URL), asset('bundle.zip', ARCHIVE_URL)] }),
      release()
    ]);
    fake.seedText(OTHER_MANIFEST_URL, 'id: [invalid yaml');
    expect(await lookup.lookup(collection())).toEqual({ status: 'published' });
  });

  it('does not report missing for an unrelated collection when any candidate remains unknown', async () => {
    const { lookup } = fixture([
      release(),
      release({ assets: [asset('deployment-manifest.yml', OTHER_MANIFEST_URL), asset('bundle.zip', ARCHIVE_URL)] })
    ]);
    expect(await lookup.lookup(collection({ id: 'unrelated' }))).toEqual(UNVERIFIED);
    expect(await lookup.lookup(collection())).toEqual({ status: 'published' });
  });

  it('checks all manifest assets rather than only the first candidate', async () => {
    const { lookup, fake } = fixture([release({ assets: [asset('deployment-manifest.json', OTHER_MANIFEST_URL), asset('deployment-manifest.yml', MANIFEST_URL), asset('bundle.zip', ARCHIVE_URL)] })]);
    fake.seedText(OTHER_MANIFEST_URL, '{"id":"other","version":"1.2.3"}');
    expect(await lookup.lookup(collection())).toEqual({ status: 'published' });
  });

  it.each([null, {}, 'not an array', { message: 'sensitive-error-marker' }])('returns unverified for a malformed release API result: %j', async (releases) => {
    expect(await fixture(releases).lookup.lookup(collection())).toEqual(UNVERIFIED);
  });

  it.each([
    null,
    {},
    release({ draft: 'false' }),
    release({ prerelease: undefined }),
    release({ tag_name: '' }),
    release({ published_at: null }),
    release({ published_at: 'not a timestamp' }),
    release({ assets: {} }),
    release({ assets: [null] }),
    release({ assets: [asset('', MANIFEST_URL)] }),
    release({ assets: [asset('deployment-manifest.yml', '')] }),
    release({ assets: [asset('deployment-manifest.yml', 'https://untrusted.example/manifest')] }),
    release({ assets: [asset('deployment-manifest.yml', 'http://api.github.com/repos/owner/repo/releases/assets/1')] }),
    release({ assets: [asset('deployment-manifest.yml', 'https://user:marker@api.github.com/repos/owner/repo/releases/assets/1')] }),
    release({ assets: [asset('deployment-manifest.yml', `${MANIFEST_URL}?secret=marker`)] }),
    release({ assets: [asset('deployment-manifest.yml', 'https://api.github.com/repos/owner/other/releases/assets/1')] })
  ])('returns unverified for malformed release fields: %j', async (value) => {
    expect(await fixture([value]).lookup.lookup(collection())).toEqual(UNVERIFIED);
  });

  it.each([
    undefined,
    '',
    'https://gitlab.com/owner/repo',
    'https://github.com/owner/repo?secret=marker',
    'https://user:marker@github.com/owner/repo'
  ])('handles invalid repository references without invoking the API factory: %j', async (repository) => {
    const { lookup, apiForRepository } = fixture();
    expect(await lookup.lookup(collection({ repository }))).toEqual(UNVERIFIED);
    expect(apiForRepository).not.toHaveBeenCalled();
  });

  it('memoizes the repository promise for concurrent and subsequent distinct collection queries', async () => {
    const { lookup, api, apiForRepository } = fixture();
    expect(await Promise.all([
      lookup.lookup(collection()),
      lookup.lookup(collection({ id: 'other', repository: 'git@github.com:owner/repo.git' })),
      lookup.lookup(collection({ id: 'owner-repo-my-collection-1.2.3', repository: 'owner/repo' }))
    ])).toEqual([{ status: 'published' }, { status: 'missing' }, { status: 'published' }]);
    expect(await lookup.lookup(collection({ repository: 'https://GITHUB.com/OWNER/REPO.git/' }))).toEqual({ status: 'published' });
    expect(apiForRepository).toHaveBeenCalledExactlyOnceWith(REPOSITORY);
    expect(api.countOf('getJson')).toBe(1);
    expect(api.countOf('getText')).toBe(1);
  });

  it('does not reuse cached identities for a different repository', async () => {
    const { lookup, fake, apiForRepository } = fixture();
    fake.seedJson('/repos/owner/other/releases?per_page=100&page=1', []);
    expect(await lookup.lookup(collection())).toEqual({ status: 'published' });
    expect(await lookup.lookup(collection({ repository: 'owner/other' }))).toEqual({ status: 'missing' });
    expect(apiForRepository).toHaveBeenCalledTimes(2);
  });

  it('memoizes failed release API reads for later queries without rejecting the lookup promise', async () => {
    const { lookup, fake, api } = fixture();
    vi.spyOn(fake, 'getJson').mockRejectedValue(new Error('sensitive-error-marker'));
    await lookup.lookup(collection());
    expect(await lookup.lookup(collection({ id: 'other' }))).toEqual(UNVERIFIED);
    expect(api.countOf('getJson')).toBe(1);
    expect(api.countOf('getText')).toBe(0);
  });

  it('memoizes inaccessible manifests without caching a collection-specific verdict', async () => {
    const { lookup, fake, api } = fixture();
    vi.spyOn(fake, 'getText').mockRejectedValue(new Error('sensitive-error-marker'));
    await lookup.lookup(collection());
    expect(await lookup.lookup(collection({ id: 'other' }))).toEqual(UNVERIFIED);
    expect(api.countOf('getJson')).toBe(1);
    expect(api.countOf('getText')).toBe(1);
  });
});
