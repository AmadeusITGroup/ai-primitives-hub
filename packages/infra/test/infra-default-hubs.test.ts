import {
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  clearCache,
  findDefaultHub,
  getDefaultHubs,
  getEnabledDefaultHubs,
  getRecommendedHub,
} from '../src/default-hubs';

describe('default-hubs', () => {
  beforeEach(() => {
    clearCache();
  });

  it('returns default hubs from hardcoded fallback', () => {
    const hubs = getDefaultHubs();
    expect(hubs).toHaveLength(2);
    expect(hubs[0].name).toBe('Amadeus');
    expect(hubs[1].name).toBe('Prompt Registry Community Hub');
  });

  it('returns enabled hubs only', () => {
    const hubs = getEnabledDefaultHubs();
    expect(hubs).toHaveLength(2);
    expect(hubs.every((h) => h.enabled !== false)).toBe(true);
  });

  it('returns recommended hub', () => {
    const recommended = getRecommendedHub();
    expect(recommended).toBeDefined();
    expect(recommended?.name).toBe('Amadeus');
    expect(recommended?.recommended).toBe(true);
  });

  it('finds hub by name', () => {
    const amadeus = findDefaultHub('Amadeus');
    expect(amadeus).toBeDefined();
    expect(amadeus?.name).toBe('Amadeus');

    const community = findDefaultHub('Prompt Registry Community Hub');
    expect(community).toBeDefined();
    expect(community?.name).toBe('Prompt Registry Community Hub');

    const notFound = findDefaultHub('Non-existent Hub');
    expect(notFound).toBeUndefined();
  });

  it('has correct hub structure', () => {
    const hubs = getDefaultHubs();
    expect(hubs[0]).toMatchObject({
      name: 'Amadeus',
      description: 'Profiles curated by Amadeus',
      icon: '☁️',
      reference: {
        type: 'github',
        location: 'Amadeus-xDLC/genai.prompt-registry-config',
        ref: 'main'
      },
      recommended: true,
      enabled: true
    });
  });

  it('clears cache', () => {
    const firstCall = getDefaultHubs();
    clearCache();
    const secondCall = getDefaultHubs();
    expect(firstCall).toEqual(secondCall);
  });
});
