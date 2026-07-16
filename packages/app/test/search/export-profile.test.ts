/**
 * Tests for app/search/export-profile.ts.
 *
 * No dedicated test suite exists for this module in the reference
 * branch, so this is new, from-scratch example-based coverage (not a
 * port) of `exportShortlistAsProfile`'s documented behavior: resolving
 * a shortlist's primitives against a `PrimitiveIndex`, grouping them
 * by bundle into a `HubProfile`, and optionally suggesting a curated
 * `Collection`.
 */
import type {
  Primitive,
} from '@ai-primitives-hub/core';
import {
  PrimitiveIndex,
} from '@ai-primitives-hub/infra';
import type {
  Shortlist,
} from '@ai-primitives-hub/infra';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  exportShortlistAsProfile,
} from '../../src/search/export-profile';

function makePrimitive(overrides: Partial<Primitive> = {}): Primitive {
  return {
    id: 'source-1::bundle-1::prompt.md',
    bundle: {
      sourceId: 'source-1',
      sourceType: 'github',
      bundleId: 'bundle-1',
      bundleVersion: '1.0.0',
      installed: false
    },
    kind: 'prompt',
    title: 'Test Prompt',
    description: 'A test prompt',
    path: 'prompts/test.prompt.md',
    tags: ['test'],
    bodyPreview: 'preview',
    contentHash: 'abc123',
    ...overrides
  };
}

function makeShortlist(overrides: Partial<Shortlist> = {}): Shortlist {
  return {
    id: 'shortlist-1',
    name: 'My Shortlist',
    primitiveIds: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides
  };
}

describe('exportShortlistAsProfile', () => {
  it('exports a single-bundle shortlist as a profile with one bundle ref', () => {
    const primitive = makePrimitive({ id: 'p1' });
    const index = PrimitiveIndex.fromPrimitives([primitive]);
    const shortlist = makeShortlist({ primitiveIds: ['p1'] });

    const result = exportShortlistAsProfile(index, shortlist, { profileId: 'my-profile' });

    expect(result.profile.bundles).toEqual([
      { id: 'bundle-1', version: '1.0.0', source: 'source-1', required: true }
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('groups multiple primitives from the same bundle into a single bundle ref', () => {
    const p1 = makePrimitive({ id: 'p1', path: 'a.prompt.md' });
    const p2 = makePrimitive({ id: 'p2', path: 'b.prompt.md' });
    const index = PrimitiveIndex.fromPrimitives([p1, p2]);
    const shortlist = makeShortlist({ primitiveIds: ['p1', 'p2'] });

    const result = exportShortlistAsProfile(index, shortlist, { profileId: 'my-profile' });

    expect(result.profile.bundles).toHaveLength(1);
  });

  it('sorts bundle refs by sourceId then bundleId', () => {
    const pZ = makePrimitive({
      id: 'pz',
      bundle: { sourceId: 'z-source', sourceType: 'github', bundleId: 'z-bundle', bundleVersion: '1.0.0', installed: false }
    });
    const pA = makePrimitive({
      id: 'pa',
      bundle: { sourceId: 'a-source', sourceType: 'github', bundleId: 'a-bundle', bundleVersion: '1.0.0', installed: false }
    });
    const index = PrimitiveIndex.fromPrimitives([pZ, pA]);
    const shortlist = makeShortlist({ primitiveIds: ['pz', 'pa'] });

    const result = exportShortlistAsProfile(index, shortlist, { profileId: 'my-profile' });

    expect(result.profile.bundles.map((b) => b.source)).toEqual(['a-source', 'z-source']);
  });

  it('warns and skips a shortlist primitive id that is missing from the index', () => {
    const primitive = makePrimitive({ id: 'p1' });
    const index = PrimitiveIndex.fromPrimitives([primitive]);
    const shortlist = makeShortlist({ primitiveIds: ['p1', 'missing-id'] });

    const result = exportShortlistAsProfile(index, shortlist, { profileId: 'my-profile' });

    expect(result.profile.bundles).toHaveLength(1);
    expect(result.warnings).toContain('Primitive missing-id not found in index (likely removed); skipping');
  });

  it('produces an empty-bundles warning for an empty shortlist', () => {
    const index = PrimitiveIndex.fromPrimitives([]);
    const shortlist = makeShortlist({ primitiveIds: [] });

    const result = exportShortlistAsProfile(index, shortlist, { profileId: 'my-profile' });

    expect(result.profile.bundles).toEqual([]);
    expect(result.warnings).toContain('Shortlist is empty or all primitives are missing; profile has no bundles.');
  });

  it('produces both not-found and empty-bundles warnings when every id is missing', () => {
    const index = PrimitiveIndex.fromPrimitives([]);
    const shortlist = makeShortlist({ primitiveIds: ['gone-1', 'gone-2'] });

    const result = exportShortlistAsProfile(index, shortlist, { profileId: 'my-profile' });

    expect(result.warnings).toEqual([
      'Primitive gone-1 not found in index (likely removed); skipping',
      'Primitive gone-2 not found in index (likely removed); skipping',
      'Shortlist is empty or all primitives are missing; profile has no bundles.'
    ]);
  });

  it('defaults profile name/description from the shortlist when not overridden', () => {
    const index = PrimitiveIndex.fromPrimitives([]);
    const shortlist = makeShortlist({ name: 'Shortlist Name', description: 'Shortlist description' });

    const result = exportShortlistAsProfile(index, shortlist, { profileId: 'my-profile' });

    expect(result.profile.name).toBe('Shortlist Name');
    expect(result.profile.description).toBe('Shortlist description');
  });

  it('synthesizes a default description from the shortlist name when the shortlist has none', () => {
    const index = PrimitiveIndex.fromPrimitives([]);
    const shortlist = makeShortlist({ name: 'Shortlist Name', description: undefined });

    const result = exportShortlistAsProfile(index, shortlist, { profileId: 'my-profile' });

    expect(result.profile.description).toBe('Profile curated from shortlist "Shortlist Name"');
  });

  it('lets explicit options override profile name, description, icon, and path', () => {
    const index = PrimitiveIndex.fromPrimitives([]);
    const shortlist = makeShortlist({ name: 'Shortlist Name', description: 'Shortlist description' });

    const result = exportShortlistAsProfile(index, shortlist, {
      profileId: 'my-profile',
      profileName: 'Override Name',
      description: 'Override description',
      icon: '🚀',
      path: ['team', 'frontend']
    });

    expect(result.profile.name).toBe('Override Name');
    expect(result.profile.description).toBe('Override description');
    expect(result.profile.icon).toBe('🚀');
    expect(result.profile.path).toEqual(['team', 'frontend']);
  });

  it('does not include a suggested collection by default', () => {
    const primitive = makePrimitive({ id: 'p1' });
    const index = PrimitiveIndex.fromPrimitives([primitive]);
    const shortlist = makeShortlist({ primitiveIds: ['p1'] });

    const result = exportShortlistAsProfile(index, shortlist, { profileId: 'my-profile' });

    expect(result.suggestedCollection).toBeUndefined();
  });

  it('builds a suggested collection from resolved primitives when requested', () => {
    const primitive = makePrimitive({ id: 'p1', kind: 'prompt', path: 'prompts/test.prompt.md', title: 'Test Prompt', description: 'A test prompt', tags: ['a', 'b'] });
    const index = PrimitiveIndex.fromPrimitives([primitive]);
    const shortlist = makeShortlist({ primitiveIds: ['p1'] });

    const result = exportShortlistAsProfile(index, shortlist, { profileId: 'my-profile', suggestCollection: true });

    expect(result.suggestedCollection).toEqual({
      id: 'my-profile',
      name: 'My Shortlist',
      description: 'Curated collection from shortlist "My Shortlist"',
      items: [
        { path: 'prompts/test.prompt.md', kind: 'prompt', title: 'Test Prompt', description: 'A test prompt', tags: ['a', 'b'] }
      ]
    });
  });

  it('does not build a suggested collection when there are no resolved primitives, even if requested', () => {
    const index = PrimitiveIndex.fromPrimitives([]);
    const shortlist = makeShortlist({ primitiveIds: ['missing-id'] });

    const result = exportShortlistAsProfile(index, shortlist, { profileId: 'my-profile', suggestCollection: true });

    expect(result.suggestedCollection).toBeUndefined();
  });

  it('uses collectionId to override the suggested collection id, independent of profileId', () => {
    const primitive = makePrimitive({ id: 'p1' });
    const index = PrimitiveIndex.fromPrimitives([primitive]);
    const shortlist = makeShortlist({ primitiveIds: ['p1'] });

    const result = exportShortlistAsProfile(index, shortlist, {
      profileId: 'my-profile',
      suggestCollection: true,
      collectionId: 'my-collection'
    });

    expect(result.suggestedCollection?.id).toBe('my-collection');
    expect(result.profile.id).toBe('my-profile');
  });

  it('excludes mcp-server primitives from the suggested collection and warns', () => {
    const mcpPrimitive = makePrimitive({ id: 'p1', kind: 'mcp-server' });
    const index = PrimitiveIndex.fromPrimitives([mcpPrimitive]);
    const shortlist = makeShortlist({ primitiveIds: ['p1'] });

    const result = exportShortlistAsProfile(index, shortlist, { profileId: 'my-profile', suggestCollection: true });

    expect(result.suggestedCollection?.items).toEqual([]);
    expect(result.warnings).toContain('Primitive p1 is kind "mcp-server" and cannot be included in a collection.');
  });

  it('omits empty title, description, and tags from collection items', () => {
    const primitive = makePrimitive({ id: 'p1', title: '', description: '', tags: [] });
    const index = PrimitiveIndex.fromPrimitives([primitive]);
    const shortlist = makeShortlist({ primitiveIds: ['p1'] });

    const result = exportShortlistAsProfile(index, shortlist, { profileId: 'my-profile', suggestCollection: true });

    expect(result.suggestedCollection?.items).toEqual([
      { path: primitive.path, kind: 'prompt', title: undefined, description: undefined, tags: undefined }
    ]);
  });

  it('defaults a bundle ref version to "latest" when bundleVersion is the "latest" sentinel', () => {
    const primitive = makePrimitive({ id: 'p1', bundle: { sourceId: 'source-1', sourceType: 'github', bundleId: 'bundle-1', bundleVersion: 'latest', installed: false } });
    const index = PrimitiveIndex.fromPrimitives([primitive]);
    const shortlist = makeShortlist({ primitiveIds: ['p1'] });

    const result = exportShortlistAsProfile(index, shortlist, { profileId: 'my-profile' });

    expect(result.profile.bundles[0].version).toBe('latest');
  });
});
