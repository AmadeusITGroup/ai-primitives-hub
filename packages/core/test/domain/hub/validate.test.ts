import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  deriveExpectedBundlePrefix,
  formatHubBundleId,
  githubBundlePrefix,
  hasPathTraversal,
  isContributableHub,
  isValidGitHubOwner,
  isValidGitHubRepo,
  isValidProtocol,
  normalizeGitHubHubLocation,
  parseGitHubOwnerRepo,
  sanitizeHubId,
  skillsBundlePrefix,
  validateHubReference,
  validateHubSourcePolicies,
} from '../../../src/domain/hub/validate';

describe('hasPathTraversal', () => {
  it('returns false for a normal path', () => {
    expect(hasPathTraversal('some/normal/path')).toBe(false);
  });

  it('detects a literal ..', () => {
    expect(hasPathTraversal('../etc/passwd')).toBe(true);
  });

  it('detects a URL-encoded ..', () => {
    expect(hasPathTraversal('%2e%2e/etc/passwd')).toBe(true);
  });

  it('returns false for an empty path', () => {
    expect(hasPathTraversal('')).toBe(false);
  });

  it('fails closed for malformed URL encoding', () => {
    expect(hasPathTraversal('%2')).toBe(true);
  });
});

describe('githubBundlePrefix', () => {
  it('derives the owner and repository prefix', () => {
    expect(githubBundlePrefix('https://github.com/example-org/example-repository'))
      .toBe('example-org-example-repository-');
  });

  it('accepts a .git repository suffix', () => {
    expect(githubBundlePrefix('https://github.com/example-org/example-repository.git'))
      .toBe('example-org-example-repository-');
  });

  it('rejects non-canonical GitHub hosts and repository paths', () => {
    expect(githubBundlePrefix('https://github.com:443/example-org/example-repository')).toBeNull();
    expect(githubBundlePrefix('https://github.com/example-org/example-repository/tree/main')).toBeNull();
    expect(githubBundlePrefix('https://git.example.com/example-org/example-repository')).toBeNull();
  });
});

describe('isValidProtocol', () => {
  it('accepts https only', () => {
    expect(isValidProtocol('https:')).toBe(true);
    expect(isValidProtocol('http:')).toBe(false);
    expect(isValidProtocol('ftp:')).toBe(false);
  });
});

describe('sanitizeHubId', () => {
  it('accepts a valid hub id (including dots from repo names)', () => {
    expect(() => sanitizeHubId('my-hub_123')).not.toThrow();
    expect(() => sanitizeHubId('genai.prompt-registry-config')).not.toThrow();
  });

  it('rejects an empty id', () => {
    expect(() => sanitizeHubId('')).toThrow('cannot be empty');
  });

  it('rejects an id over 255 characters', () => {
    expect(() => sanitizeHubId('a'.repeat(256))).toThrow('too long');
  });

  it('rejects path separators and traversal', () => {
    expect(() => sanitizeHubId('../evil')).toThrow('path traversal');
    expect(() => sanitizeHubId('a/b')).toThrow('path traversal');
    expect(() => sanitizeHubId('a\\b')).toThrow('path traversal');
  });

  it('rejects disallowed characters', () => {
    expect(() => sanitizeHubId('my hub!')).toThrow('only alphanumeric');
  });
});

describe('parseGitHubOwnerRepo & normalizeGitHubHubLocation (single source of truth)', () => {
  it('parses owner/repo slugs and URLs with dots in repository names', () => {
    expect(isValidGitHubOwner('Amadeus-xDLC')).toBe(true);
    expect(isValidGitHubRepo('genai.prompt-registry-config')).toBe(true);
    expect(isValidGitHubRepo('.')).toBe(false);
    expect(isValidGitHubRepo('..')).toBe(false);

    expect(parseGitHubOwnerRepo('Amadeus-xDLC/genai.prompt-registry-config')).toEqual({
      host: 'github.com',
      owner: 'Amadeus-xDLC',
      repo: 'genai.prompt-registry-config',
      subPathSegments: []
    });

    expect(parseGitHubOwnerRepo('https://github.com/Amadeus-xDLC/genai.prompt-registry-config.git')).toEqual({
      host: 'github.com',
      owner: 'Amadeus-xDLC',
      repo: 'genai.prompt-registry-config',
      subPathSegments: []
    });

    expect(parseGitHubOwnerRepo('git@github.com:Amadeus-xDLC/genai.prompt-registry-config.git')).toEqual({
      host: 'github.com',
      owner: 'Amadeus-xDLC',
      repo: 'genai.prompt-registry-config',
      subPathSegments: []
    });

    expect(normalizeGitHubHubLocation('https://github.com/Amadeus-xDLC/genai.prompt-registry-config/blob/main/hub-config.yml')).toEqual({
      location: 'Amadeus-xDLC/genai.prompt-registry-config',
      ref: 'main'
    });
  });
});

describe('validateHubReference', () => {
  it('accepts a valid github reference (including dots in repository name and full GitHub URLs)', () => {
    expect(() => validateHubReference({ type: 'github', location: 'owner/repo' })).not.toThrow();
    expect(() => validateHubReference({ type: 'github', location: 'Amadeus-xDLC/genai.prompt-registry-config' })).not.toThrow();
    expect(() => validateHubReference({ type: 'github', location: 'https://github.com/Amadeus-xDLC/genai.prompt-registry-config' })).not.toThrow();
  });

  it('rejects a malformed github reference', () => {
    expect(() => validateHubReference({ type: 'github', location: 'not-owner-slash-repo' })).toThrow(
      'Expected: owner/repo'
    );
    expect(() => validateHubReference({ type: 'github', location: '../repo' })).toThrow(
      'Expected: owner/repo'
    );
    expect(() => validateHubReference({ type: 'github', location: './repo' })).toThrow(
      'Expected: owner/repo'
    );
    expect(() => validateHubReference({ type: 'github', location: 'owner/.' })).toThrow(
      'Expected: owner/repo'
    );
  });

  it('accepts a valid local reference', () => {
    expect(() => validateHubReference({ type: 'local', location: './hubs/my-hub' })).not.toThrow();
  });

  it('rejects a local reference with path traversal', () => {
    expect(() => validateHubReference({ type: 'local', location: '../../etc' })).toThrow('traversal');
  });

  it('accepts a valid https url reference', () => {
    expect(() => validateHubReference({ type: 'url', location: 'https://example.com/hub.yml' })).not.toThrow();
  });

  it('rejects a non-https url reference', () => {
    expect(() => validateHubReference({ type: 'url', location: 'http://example.com/hub.yml' })).toThrow(
      'HTTPS'
    );
  });

  it('allows loopback http only for Artifactory development references', () => {
    expect(() => validateHubReference({ type: 'artifactory', location: 'http://127.0.0.1:8081/artifactory/hub' })).not.toThrow();
    expect(() => validateHubReference({ type: 'artifactory', location: 'http://localhost:8081/artifactory/hub' })).not.toThrow();
    expect(() => validateHubReference({ type: 'artifactory', location: 'http://example.com/artifactory/hub' })).toThrow('HTTPS');
  });

  it('rejects a malformed url reference', () => {
    expect(() => validateHubReference({ type: 'url', location: 'not a url' })).toThrow('Invalid URL format');
  });

  it('rejects an empty location', () => {
    expect(() => validateHubReference({ type: 'local', location: '' })).toThrow('cannot be empty');
  });
});

describe('isContributableHub', () => {
  it('qualifies a github hub reference for contribution', () => {
    expect(isContributableHub({
      type: 'github',
      location: 'AmadeusITGroup/prompt-registry-config',
      ref: 'main'
    })).toEqual({
      contributable: true,
      repositorySlug: 'AmadeusITGroup/prompt-registry-config'
    });
  });

  it('rejects Artifactory hubs as read-only replicas populated by promotion', () => {
    const result = isContributableHub({
      type: 'artifactory',
      location: 'https://artifactory.example.com/artifactory/hub'
    });
    expect(result.contributable).toBe(false);
    expect(result.reason).toContain('Artifactory');
    expect(result.reason).toContain('read-only');
  });

  it('qualifies a GitHub URL hub reference and extracts owner/repo', () => {
    expect(isContributableHub({
      type: 'url',
      location: 'https://raw.githubusercontent.com/AmadeusITGroup/prompt-registry-config/main/hub-config.yml'
    })).toEqual({
      contributable: true,
      repositorySlug: 'AmadeusITGroup/prompt-registry-config'
    });

    expect(isContributableHub({
      type: 'url',
      location: 'https://github.com/AmadeusITGroup/prompt-registry-config/blob/main/hub-config.yml'
    })).toEqual({
      contributable: true,
      repositorySlug: 'AmadeusITGroup/prompt-registry-config'
    });
  });

  it('rejects non-GitHub URL and unlinked local hub references', () => {
    expect(isContributableHub({
      type: 'url',
      location: 'https://example.com/hub-config.yml'
    }).contributable).toBe(false);

    expect(isContributableHub({
      type: 'local',
      location: '/tmp/hub-config.yml'
    }).contributable).toBe(false);
  });

  it('qualifies a local hub reference when a GitHub remote slug is resolved', () => {
    expect(isContributableHub(
      { type: 'local', location: '/workspace/prompt-registry-config/hub-config.yml' },
      'AmadeusITGroup/prompt-registry-config'
    )).toEqual({
      contributable: true,
      repositorySlug: 'AmadeusITGroup/prompt-registry-config'
    });
  });
});

describe('skillsBundlePrefix & formatHubBundleId', () => {
  it('derives skills-<org>-<repo>- from a skills repository URL', () => {
    expect(skillsBundlePrefix('https://github.com/github/awesome-copilot/skills'))
      .toBe('skills-github-awesome-copilot-');
    expect(skillsBundlePrefix('https://github.com/anthropics/skills/skills'))
      .toBe('skills-anthropics-skills-');
    expect(skillsBundlePrefix('https://example.com/not-github/skills'))
      .toBeNull();
  });

  it('derives expected prefix and formats bundle IDs idempotently across source types', () => {
    const githubSource = {
      type: 'github',
      url: 'https://github.com/AmadeusITGroup/community-collections'
    };
    const skillsSource = {
      type: 'skills',
      url: 'https://github.com/github/awesome-copilot/skills'
    };
    const awesomeSource = {
      type: 'awesome-copilot',
      url: 'https://github.com/github/awesome-copilot'
    };

    expect(deriveExpectedBundlePrefix(githubSource)).toBe('AmadeusITGroup-community-collections-');
    expect(formatHubBundleId(githubSource, 'amadeus-ospo'))
      .toBe('AmadeusITGroup-community-collections-amadeus-ospo');
    expect(formatHubBundleId(githubSource, 'AmadeusITGroup-community-collections-amadeus-ospo'))
      .toBe('AmadeusITGroup-community-collections-amadeus-ospo');

    expect(deriveExpectedBundlePrefix(skillsSource)).toBe('skills-github-awesome-copilot-');
    expect(formatHubBundleId(skillsSource, 'webapp-testing'))
      .toBe('skills-github-awesome-copilot-webapp-testing');
    expect(formatHubBundleId(skillsSource, 'skills-github-awesome-copilot-webapp-testing'))
      .toBe('skills-github-awesome-copilot-webapp-testing');

    expect(deriveExpectedBundlePrefix(awesomeSource)).toBeNull();
    expect(formatHubBundleId(awesomeSource, 'commit-message')).toBe('commit-message');
  });

  it('enforces skills source bundle prefix in validateHubSourcePolicies', () => {
    const violations = validateHubSourcePolicies({
      sources: [
        {
          id: 'awesome-skills',
          type: 'skills',
          url: 'https://github.com/github/awesome-copilot/skills',
          enabled: true,
          priority: 10
        }
      ],
      profiles: [
        {
          id: 'frontend-developer',
          name: 'Frontend Developer',
          bundles: [
            {
              id: 'webapp-testing',
              version: 'latest',
              source: 'awesome-skills',
              required: true
            }
          ]
        }
      ]
    });

    expect(violations).toContain(
      "Profile 'frontend-developer' bundle #1 must reference skills source 'awesome-skills' with an ID starting 'skills-github-awesome-copilot-'."
    );
  });
});
