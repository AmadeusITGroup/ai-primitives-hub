/**
 * Tests for registry/resolve-install-source.ts — resolving an install
 * `--source` value to a configured hub source.
 */
import {
  type HubConfig,
  type HubProfile,
  RegistryError,
  type RegistrySource,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  githubRepoSlugForSource,
  type InstallSourceHubs,
  resolveInstallSource,
} from '../../src/registry/resolve-install-source';

const source = (id: string, repo: string, name = `${id} name`): RegistrySource => ({
  id,
  name,
  type: 'github',
  url: `https://github.com/acme-org/${repo}`,
  enabled: true,
  priority: 0
});

const profile = (id: string, bundles: HubProfile['bundles']): HubProfile => ({
  id,
  name: id,
  description: 'd',
  icon: '',
  bundles,
  active: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
});

const config = (sources: RegistrySource[], profiles: HubProfile[] = []): HubConfig => ({
  version: '1.0.0',
  metadata: { name: 'Sample Hub', description: 'd', maintainer: 'm', updatedAt: '2026-01-01T00:00:00.000Z' },
  sources,
  profiles
});

/** A hub on disk: a loadable config, or a load error (malformed file). */
type FakeHub = HubConfig | Error;

/**
 * In-memory hub storage with the same contract as `HubManager`:
 * `getHub` returns null for missing or malformed hubs, `listSources`
 * throws for them.
 * @param hubs Hubs by id.
 * @param activeHubId Active hub id.
 * @returns Hub read access.
 */
const fakeHubs = (hubs: Record<string, FakeHub>, activeHubId: string | null = null): InstallSourceHubs => ({
  getActiveHubId: async () => activeHubId,
  hasHub: async (hubId) => hubId in hubs,
  getHub: async (hubId) => {
    const hub = hubs[hubId];
    return hub === undefined || hub instanceof Error ? null : { id: hubId, config: hub };
  },
  listSources: async (hubId) => {
    const hub = hubId === undefined ? undefined : hubs[hubId];
    if (hub === undefined) {
      throw new Error(`Hub not found: ${String(hubId)}`);
    }
    if (hub instanceof Error) {
      throw hub;
    }
    return hub.sources.map((s) => ({ ...s, hubId }));
  }
});

describe('resolveInstallSource', () => {
  const first = source('sample-collections', 'sample-skills');
  const second = source('other-collections', 'other-skills');

  describe('--source as a hub id', () => {
    it('returns the source a profile names for the bundle when the hub has several sources', async () => {
      const hubs = fakeHubs({
        'sample-hub': config([first, second], [
          profile('developer', [{ id: 'acme-org-other-skills-tools', version: 'latest', source: 'other-collections', required: true }])
        ])
      });

      const resolved = await resolveInstallSource(hubs, 'sample-hub', 'acme-org-other-skills-tools');

      expect(resolved?.id).toBe('other-collections');
      expect(resolved?.hubId).toBe('sample-hub');
    });

    it('returns null when the hub has several sources and no profile names the bundle', async () => {
      const hubs = fakeHubs({
        'sample-hub': config([first, second], [
          profile('developer', [{ id: 'acme-org-sample-skills-other', version: 'latest', source: 'sample-collections', required: true }])
        ])
      });

      await expect(resolveInstallSource(hubs, 'sample-hub', 'acme-org-sample-skills-unlisted')).resolves.toBeNull();
    });

    it('returns the only source when no profile names the bundle', async () => {
      const hubs = fakeHubs({ 'sample-hub': config([first]) });

      await expect(resolveInstallSource(hubs, 'sample-hub', 'anything')).resolves.toMatchObject({ id: 'sample-collections' });
    });
  });

  describe('--source as a source in the active hub', () => {
    const hubs = fakeHubs({ 'sample-hub': config([first, second]) }, 'sample-hub');

    it('matches a source id', async () => {
      await expect(resolveInstallSource(hubs, 'other-collections', 'x')).resolves.toMatchObject({ id: 'other-collections' });
    });

    it('matches a source name', async () => {
      await expect(resolveInstallSource(hubs, 'sample-collections name', 'x')).resolves.toMatchObject({ id: 'sample-collections' });
    });

    it('prefers an active-hub source over a hub with the same id', async () => {
      const shadowed = fakeHubs({
        'sample-hub': config([source('demo', 'sample-skills')]),
        demo: config([second])
      }, 'sample-hub');

      await expect(resolveInstallSource(shadowed, 'demo', 'x')).resolves.toMatchObject({ id: 'demo', hubId: 'sample-hub' });
    });
  });

  it('returns null when nothing matches', async () => {
    const hubs = fakeHubs({ 'sample-hub': config([first]) }, 'sample-hub');

    await expect(resolveInstallSource(hubs, 'no-such-source', 'x')).resolves.toBeNull();
  });

  it('returns null for a stale active-hub pointer', async () => {
    await expect(resolveInstallSource(fakeHubs({}, 'gone-hub'), 'demo', 'x')).resolves.toBeNull();
  });

  describe('unreadable hub configuration', () => {
    it('reports an active hub that fails to load instead of no match', async () => {
      const hubs = fakeHubs({ 'sample-hub': new Error('bad indentation of a mapping entry') }, 'sample-hub');

      const err = await resolveInstallSource(hubs, 'demo', 'x').catch((e: unknown) => e);

      expect(err).toBeInstanceOf(RegistryError);
      expect((err as RegistryError).code).toBe('HUB.LOAD_FAILED');
      expect((err as RegistryError).message).toContain('hub "sample-hub"');
      expect((err as RegistryError).message).toContain('bad indentation');
    });

    it('reports the hub named by --source when it fails to load', async () => {
      const hubs = fakeHubs({ demo: new Error('unexpected end of the stream') });

      await expect(resolveInstallSource(hubs, 'demo', 'x')).rejects.toThrow(/hub "demo".*unexpected end of the stream/);
    });

    it('still resolves through a readable hub when the active hub fails to load', async () => {
      const hubs = fakeHubs({ 'sample-hub': new Error('broken'), demo: config([first]) }, 'sample-hub');

      await expect(resolveInstallSource(hubs, 'demo', 'x')).resolves.toMatchObject({ id: 'sample-collections', hubId: 'demo' });
    });
  });
});

describe('githubRepoSlugForSource', () => {
  it('returns owner/repo for a GitHub source or lockfile source entry', () => {
    expect(githubRepoSlugForSource({ type: 'github', url: 'https://github.com/acme-org/sample-skills' })).toBe('acme-org/sample-skills');
  });

  it('returns undefined for other source types', () => {
    expect(githubRepoSlugForSource({ type: 'local', url: '/tmp/sample' })).toBeUndefined();
  });
});
