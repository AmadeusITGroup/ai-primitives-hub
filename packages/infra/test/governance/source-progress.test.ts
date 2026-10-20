import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  HubSourceCollectionIndex,
} from '../../src/governance/hub-source-collection-index';

describe('source inventory progress', () => {
  it('reports overlapping source starts and incomplete completion without hiding other sources', async () => {
    const events: unknown[] = [];
    const sources = ['a', 'b'].map((id) => ({ id, name: id, type: 'github' as const, enabled: true, priority: 0, url: 'https://github.com/owner/repo' }));
    const inventory = await new HubSourceCollectionIndex(sources, () => {
      throw new Error('Unused');
    }, {
      listCollections: (_repository, sourceId) => {
        if (sourceId === 'a') {
          return Promise.reject(new Error('SECRET token=hidden'));
        }
        return Promise.resolve({ collections: [{ id: 'test', sourceId }], unverifiedSources: [] });
      }
    }, (event) => events.push(event)).read();
    expect(events).toEqual([
      { phase: 'start', sourceId: 'a', index: 1, total: 2 },
      { phase: 'start', sourceId: 'b', index: 2, total: 2 },
      { phase: 'complete', sourceId: 'a', index: 1, total: 2, collections: 0, unverified: true },
      { phase: 'complete', sourceId: 'b', index: 2, total: 2, collections: 1, unverified: false }
    ]);
    expect(inventory.collections).toHaveLength(1);
    expect(inventory.unverifiedSources).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('SECRET');
  });
});
