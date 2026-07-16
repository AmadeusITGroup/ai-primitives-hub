import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  hasPathTraversal,
  isValidProtocol,
  sanitizeHubId,
  validateHubReference,
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
});

describe('isValidProtocol', () => {
  it('accepts https only', () => {
    expect(isValidProtocol('https:')).toBe(true);
    expect(isValidProtocol('http:')).toBe(false);
    expect(isValidProtocol('ftp:')).toBe(false);
  });
});

describe('sanitizeHubId', () => {
  it('accepts a valid hub id', () => {
    expect(() => sanitizeHubId('my-hub_123')).not.toThrow();
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

describe('validateHubReference', () => {
  it('accepts a valid github reference', () => {
    expect(() => validateHubReference({ type: 'github', location: 'owner/repo' })).not.toThrow();
  });

  it('rejects a malformed github reference', () => {
    expect(() => validateHubReference({ type: 'github', location: 'not-owner-slash-repo' })).toThrow(
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

  it('rejects a malformed url reference', () => {
    expect(() => validateHubReference({ type: 'url', location: 'not a url' })).toThrow('Invalid URL format');
  });

  it('rejects an empty location', () => {
    expect(() => validateHubReference({ type: 'local', location: '' })).toThrow('cannot be empty');
  });
});
