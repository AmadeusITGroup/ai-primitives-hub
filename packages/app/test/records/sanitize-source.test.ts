/**
 * Tests for app/records/sanitize-source.ts (NFR4.5, BR3.2).
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  sanitizeSource,
  sanitizeSourceUrl,
} from '../../src/records/sanitize-source';
import {
  expectRecordError,
} from './record-test-utils';

describe('sanitizeSourceUrl', () => {
  it('removes the user name and password from a standard URL', () => {
    expect(sanitizeSourceUrl('https://user:s3cret@github.com/acme/tools')).toBe('https://github.com/acme/tools');
    expect(sanitizeSourceUrl('https://ghp_abc123@github.com/acme/tools.git')).toBe('https://github.com/acme/tools.git');
  });

  it('removes token-like query parameters and keeps the others', () => {
    const cleaned = sanitizeSourceUrl('https://host.example/index.json?token=abc&ref=main&access_token=def&sig=x&key=y');
    expect(cleaned).toBe('https://host.example/index.json?ref=main');
    expect(cleaned).not.toMatch(/abc|def/);
  });

  it('keeps a standard URL without secrets exactly as given', () => {
    expect(sanitizeSourceUrl('https://github.com/acme/tools')).toBe('https://github.com/acme/tools');
    expect(sanitizeSourceUrl('/Users/someone/bundles')).toBe('/Users/someone/bundles');
    expect(sanitizeSourceUrl(String.raw`C:\bundles\local`)).toBe(String.raw`C:\bundles\local`);
  });

  it('keeps an scp-style git@host:path URL', () => {
    expect(sanitizeSourceUrl('git@github.com:acme/tools.git')).toBe('git@github.com:acme/tools.git');
  });

  it('strips any other scp-style user, leaving host:path', () => {
    expect(sanitizeSourceUrl('deploy@github.com:acme/tools.git')).toBe('github.com:acme/tools.git');
    expect(sanitizeSourceUrl('user:pw@github.com:acme/tools.git')).toBe('github.com:acme/tools.git');
  });

  it('strips the user part of an unparseable URL that contains @', () => {
    const cleaned = sanitizeSourceUrl('https://user:tok@[not-an-ip/acme/tools');
    expect(cleaned).toBe('https://[not-an-ip/acme/tools');
    expect(cleaned).not.toContain('tok');
  });

  it('keeps an absolute local path with an @ in a folder name unchanged', () => {
    expect(sanitizeSourceUrl(String.raw`C:\Users\a@b\bundle`)).toBe(String.raw`C:\Users\a@b\bundle`);
    expect(sanitizeSourceUrl('C:/Users/a@b/bundle')).toBe('C:/Users/a@b/bundle');
    expect(sanitizeSourceUrl('/home/a@b/bundle')).toBe('/home/a@b/bundle');
    expect(sanitizeSourceUrl(String.raw`\\server\a@b\bundle`)).toBe(String.raw`\\server\a@b\bundle`);
  });

  it('still cleans scheme URLs as before', () => {
    expect(sanitizeSourceUrl('https://user:tok@host/x')).toBe('https://host/x');
    expect(sanitizeSourceUrl('ssh://git@host/x')).toBe('ssh://host/x');
  });

  it('leaves an @ after the authority alone', () => {
    expect(sanitizeSourceUrl('https://registry.example/@scope/pkg')).toBe('https://registry.example/@scope/pkg');
  });
});

describe('sanitizeSource', () => {
  it('copies only the C1 fields into a prototype-free object', () => {
    const source = sanitizeSource({
      sourceId: 'acme',
      type: 'github',
      url: 'https://user:pw@github.com/acme/tools',
      branch: 'main',
      credentialRef: 'ACME_TOKEN',
      token: 'ghp_secret',
      headers: { Authorization: 'Bearer x' }
    });
    expect(Object.getPrototypeOf(source)).toBeNull();
    expect({ ...source }).toEqual({
      type: 'github',
      url: 'https://github.com/acme/tools',
      branch: 'main',
      credentialRef: 'ACME_TOKEN'
    });
    expect(JSON.stringify(source)).not.toMatch(/ghp_secret|Bearer|pw/);
  });

  it('refuses a source without a type or a url', async () => {
    await expectRecordError(Promise.resolve().then(() => sanitizeSource({ type: 'github' })), 'RECORD.MALFORMED');
    await expectRecordError(Promise.resolve().then(() => sanitizeSource({ url: 'https://x' })), 'RECORD.MALFORMED');
  });
});
