/**
 * Tests for infra/hub/default-hubs.ts — the single source of truth for the
 * default hubs offered to both delivery layers.
 */
import type {
  HubReference,
} from '@ai-primitives-hub/core';
import {
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  clearCache,
  getDefaultHubs,
  getEnabledDefaultHubs,
  getRecommendedHub,
  isDefaultHub,
  isRecommendedDefaultHub,
} from '../../src/hub/default-hubs';

function reference(overrides: Partial<HubReference> = {}): HubReference {
  return {
    type: 'github',
    location: 'Amadeus-xDLC/genai.prompt-registry-config',
    ref: 'main',
    ...overrides
  };
}

describe('default hubs configuration', () => {
  beforeEach(() => {
    clearCache();
  });

  it('offers at least one enabled hub', () => {
    expect(getEnabledDefaultHubs().length).toBeGreaterThan(0);
  });

  it('marks exactly one hub as recommended so the selection is not order-dependent', () => {
    const recommended = getDefaultHubs().filter((hub) => hub.recommended);
    expect(recommended).toHaveLength(1);
    expect(getRecommendedHub()).toBe(recommended[0]);
  });

  it('gives every hub a plain-text icon and a VS Code codicon', () => {
    for (const hub of getDefaultHubs()) {
      expect(hub.icon).toBeTruthy();
      expect(hub.codicon).toBeTruthy();
    }
  });
});

describe('isDefaultHub', () => {
  beforeEach(() => {
    clearCache();
  });

  it('recognises every shipped default hub by its own reference', () => {
    for (const hub of getDefaultHubs()) {
      expect(isDefaultHub(hub.reference)).toBe(true);
    }
  });

  it('ignores the git ref, because a default hub on another branch is the same hub', () => {
    expect(isDefaultHub(reference({ ref: 'next' }))).toBe(true);
  });

  it('matches GitHub locations case-insensitively', () => {
    expect(isDefaultHub(reference({ location: 'amadeus-xdlc/GENAI.prompt-registry-config' }))).toBe(true);
  });

  it('rejects an unrelated hub', () => {
    expect(isDefaultHub(reference({ location: 'someone/private-hub' }))).toBe(false);
  });

  it('rejects a matching location under a different hub type', () => {
    const recommended = getRecommendedHub()!;
    expect(isDefaultHub({ type: 'local', location: recommended.reference.location })).toBe(false);
  });
});

describe('isRecommendedDefaultHub', () => {
  beforeEach(() => {
    clearCache();
  });

  it('accepts the recommended hub', () => {
    expect(isRecommendedDefaultHub(getRecommendedHub()!.reference)).toBe(true);
  });

  it('rejects a non-recommended default hub', () => {
    const other = getDefaultHubs().find((hub) => !hub.recommended);
    expect(other).toBeDefined();
    expect(isRecommendedDefaultHub(other!.reference)).toBe(false);
  });

  it('rejects an unrelated hub', () => {
    expect(isRecommendedDefaultHub(reference({ location: 'someone/private-hub' }))).toBe(false);
  });
});
