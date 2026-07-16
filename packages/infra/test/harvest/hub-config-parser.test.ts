/**
 * Coverage tests for infra/harvest/hub-config-parser.ts.
 *
 * Tests parseHubConfig and normalizeRepoFromUrl functions.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  normalizeRepoFromUrl,
  parseHubConfig,
} from '../../src/harvest/hub-config-parser';

describe('normalizeRepoFromUrl', () => {
  it('parses standard GitHub HTTPS URL', () => {
    const result = normalizeRepoFromUrl('https://github.com/owner/repo');
    expect(result).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses GitHub URL with www subdomain', () => {
    const result = normalizeRepoFromUrl('https://www.github.com/owner/repo');
    expect(result).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses GitHub URL with .git suffix', () => {
    const result = normalizeRepoFromUrl('https://github.com/owner/repo.git');
    expect(result).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses GitHub URL with trailing slash', () => {
    const result = normalizeRepoFromUrl('https://github.com/owner/repo/');
    expect(result).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('returns undefined for non-GitHub host', () => {
    const result = normalizeRepoFromUrl('https://gitlab.com/owner/repo');
    expect(result).toBeUndefined();
  });

  it('returns undefined for invalid URL', () => {
    const result = normalizeRepoFromUrl('not-a-url');
    expect(result).toBeUndefined();
  });

  it('returns undefined for URL with insufficient path segments', () => {
    const result = normalizeRepoFromUrl('https://github.com/owner');
    expect(result).toBeUndefined();
  });
});

describe('parseHubConfig', () => {
  it('parses YAML string with github source', () => {
    const yaml = `
sources:
  - type: github
    url: https://github.com/owner/repo
`;
    const result = parseHubConfig(yaml);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('github');
    expect(result[0].owner).toBe('owner');
    expect(result[0].repo).toBe('repo');
  });

  it('parses object with github source', () => {
    const obj = {
      sources: [
        { type: 'github', url: 'https://github.com/owner/repo' }
      ]
    };
    const result = parseHubConfig(obj);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('github');
    expect(result[0].owner).toBe('owner');
  });

  it('filters out disabled sources', () => {
    const obj = {
      sources: [
        { type: 'github', url: 'https://github.com/owner/repo', enabled: false }
      ]
    };
    const result = parseHubConfig(obj);
    expect(result).toHaveLength(0);
  });

  it('filters out non-github hosts', () => {
    const obj = {
      sources: [
        { type: 'github', url: 'https://gitlab.com/owner/repo' }
      ]
    };
    const result = parseHubConfig(obj);
    expect(result).toHaveLength(0);
  });

  it('filters out unsupported source types', () => {
    const obj = {
      sources: [
        { type: 'unknown', url: 'https://github.com/owner/repo' }
      ]
    };
    const result = parseHubConfig(obj);
    expect(result).toHaveLength(0);
  });

  it('generates default id from owner-repo', () => {
    const obj = {
      sources: [
        { type: 'github', url: 'https://github.com/owner/repo' }
      ]
    };
    const result = parseHubConfig(obj);
    expect(result[0].id).toBe('owner-repo');
  });

  it('uses provided id when available', () => {
    const obj = {
      sources: [
        { type: 'github', url: 'https://github.com/owner/repo', id: 'custom-id' }
      ]
    };
    const result = parseHubConfig(obj);
    expect(result[0].id).toBe('custom-id');
  });

  it('generates default name from repo', () => {
    const obj = {
      sources: [
        { type: 'github', url: 'https://github.com/owner/repo' }
      ]
    };
    const result = parseHubConfig(obj);
    expect(result[0].name).toBe('repo');
  });

  it('uses provided name when available', () => {
    const obj = {
      sources: [
        { type: 'github', url: 'https://github.com/owner/repo', name: 'Custom Name' }
      ]
    };
    const result = parseHubConfig(obj);
    expect(result[0].name).toBe('Custom Name');
  });

  it('uses id as name fallback when name not provided', () => {
    const obj = {
      sources: [
        { type: 'github', url: 'https://github.com/owner/repo', id: 'custom-id' }
      ]
    };
    const result = parseHubConfig(obj);
    expect(result[0].name).toBe('custom-id');
  });

  it('sets default branch to main', () => {
    const obj = {
      sources: [
        { type: 'github', url: 'https://github.com/owner/repo' }
      ]
    };
    const result = parseHubConfig(obj);
    expect(result[0].branch).toBe('main');
  });

  it('uses provided branch from config', () => {
    const obj = {
      sources: [
        { type: 'github', url: 'https://github.com/owner/repo', config: { branch: 'develop' } }
      ]
    };
    const result = parseHubConfig(obj);
    expect(result[0].branch).toBe('develop');
  });

  it('preserves raw config', () => {
    const obj = {
      sources: [
        { type: 'github', url: 'https://github.com/owner/repo', config: { customField: 'value' } }
      ]
    };
    const result = parseHubConfig(obj);
    expect(result[0].rawConfig).toEqual({ customField: 'value' });
  });

  it('handles awesome-copilot source type', () => {
    const obj = {
      sources: [
        { type: 'awesome-copilot', url: 'https://github.com/owner/repo' }
      ]
    };
    const result = parseHubConfig(obj);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('awesome-copilot');
  });

  it('handles awesome-copilot-plugin source type', () => {
    const obj = {
      sources: [
        { type: 'awesome-copilot-plugin', url: 'https://github.com/owner/repo' }
      ]
    };
    const result = parseHubConfig(obj);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('awesome-copilot-plugin');
  });

  it('sets default pluginsPath for awesome-copilot-plugin', () => {
    const obj = {
      sources: [
        { type: 'awesome-copilot-plugin', url: 'https://github.com/owner/repo' }
      ]
    };
    const result = parseHubConfig(obj);
    expect(result[0].pluginsPath).toBe('plugins');
  });

  it('uses provided pluginsPath for awesome-copilot-plugin', () => {
    const obj = {
      sources: [
        { type: 'awesome-copilot-plugin', url: 'https://github.com/owner/repo', config: { pluginsPath: 'custom-plugins' } }
      ]
    };
    const result = parseHubConfig(obj);
    expect(result[0].pluginsPath).toBe('custom-plugins');
  });

  it('does not set pluginsPath for github source', () => {
    const obj = {
      sources: [
        { type: 'github', url: 'https://github.com/owner/repo' }
      ]
    };
    const result = parseHubConfig(obj);
    expect(result[0].pluginsPath).toBeUndefined();
  });

  it('handles collectionsPath from config', () => {
    const obj = {
      sources: [
        { type: 'github', url: 'https://github.com/owner/repo', config: { collectionsPath: 'my-collections' } }
      ]
    };
    const result = parseHubConfig(obj);
    expect(result[0].collectionsPath).toBe('my-collections');
  });

  it('handles empty sources array', () => {
    const obj = { sources: [] };
    const result = parseHubConfig(obj);
    expect(result).toHaveLength(0);
  });

  it('handles missing sources field', () => {
    const obj = {};
    const result = parseHubConfig(obj);
    expect(result).toHaveLength(0);
  });

  it('throws on malformed YAML', () => {
    const yaml = 'invalid: yaml: [';
    expect(() => parseHubConfig(yaml)).toThrow();
  });

  it('handles multiple sources', () => {
    const obj = {
      sources: [
        { type: 'github', url: 'https://github.com/owner1/repo1' },
        { type: 'github', url: 'https://github.com/owner2/repo2' }
      ]
    };
    const result = parseHubConfig(obj);
    expect(result).toHaveLength(2);
    expect(result[0].owner).toBe('owner1');
    expect(result[1].owner).toBe('owner2');
  });

  it('filters invalid entries from multiple sources', () => {
    const obj = {
      sources: [
        { type: 'github', url: 'https://github.com/owner/repo' },
        { type: 'unknown', url: 'https://github.com/owner/repo2' },
        { type: 'github', url: 'https://gitlab.com/owner/repo3' }
      ]
    };
    const result = parseHubConfig(obj);
    expect(result).toHaveLength(1);
    expect(result[0].owner).toBe('owner');
  });
});
