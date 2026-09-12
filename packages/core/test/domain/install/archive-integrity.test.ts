import {
  createHash,
} from 'node:crypto';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  parseArchiveIntegrity,
  verifyArchiveIntegrity,
} from '../../../src';

describe('archive integrity', () => {
  it('parses only canonical sha256 digests and verifies bytes', () => {
    const bytes = new TextEncoder().encode('archive');
    const digest = createHash('sha256').update(bytes).digest('hex');
    expect(parseArchiveIntegrity(`sha256:${digest}`)).toBe(digest);
    expect(parseArchiveIntegrity(`sha256:${digest.toUpperCase()}`)).toBeNull();
    expect(parseArchiveIntegrity(`sha512:${digest}`)).toBeNull();
    expect(verifyArchiveIntegrity(bytes, `sha256:${digest}`)).toBe(true);
    expect(verifyArchiveIntegrity(bytes, `sha256:${'b'.repeat(64)}`)).toBe(false);
  });
});
