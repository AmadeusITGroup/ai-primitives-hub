/**
 * Coverage tests for infra/github/errors.ts.
 *
 * Tests GitHubApiError and GitHubNetworkError classes.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  GitHubApiError,
  GitHubNetworkError,
} from '../../src/github/errors';

describe('GitHubApiError', () => {
  it('creates error with all fields', () => {
    const error = new GitHubApiError(
      'API request failed',
      404,
      '{"message":"Not found"}',
      'https://api.github.com/repos/owner/repo'
    );
    expect(error.name).toBe('GitHubApiError');
    expect(error.message).toBe('API request failed');
    expect(error.status).toBe(404);
    expect(error.body).toBe('{"message":"Not found"}');
    expect(error.url).toBe('https://api.github.com/repos/owner/repo');
  });

  it('is instance of Error', () => {
    const error = new GitHubApiError('Test', 500, '{}', 'https://api.github.com');
    expect(error instanceof Error).toBe(true);
  });

  it('is instance of GitHubApiError', () => {
    const error = new GitHubApiError('Test', 500, '{}', 'https://api.github.com');
    expect(error instanceof GitHubApiError).toBe(true);
  });

  it('preserves stack trace', () => {
    const error = new GitHubApiError('Test', 500, '{}', 'https://api.github.com');
    expect(error.stack).toBeDefined();
  });
});

describe('GitHubNetworkError', () => {
  it('creates error with required fields', () => {
    const error = new GitHubNetworkError(
      'Network error',
      'https://api.github.com/repos/owner/repo'
    );
    expect(error.name).toBe('GitHubNetworkError');
    expect(error.message).toBe('Network error');
    expect(error.url).toBe('https://api.github.com/repos/owner/repo');
    expect(error.cause).toBeUndefined();
  });

  it('creates error with optional cause', () => {
    const cause = new Error('Underlying error');
    const error = new GitHubNetworkError(
      'Network error',
      'https://api.github.com/repos/owner/repo',
      cause
    );
    expect(error.cause).toBe(cause);
  });

  it('is instance of Error', () => {
    const error = new GitHubNetworkError('Test', 'https://api.github.com');
    expect(error instanceof Error).toBe(true);
  });

  it('is instance of GitHubNetworkError', () => {
    const error = new GitHubNetworkError('Test', 'https://api.github.com');
    expect(error instanceof GitHubNetworkError).toBe(true);
  });

  it('preserves stack trace', () => {
    const error = new GitHubNetworkError('Test', 'https://api.github.com');
    expect(error.stack).toBeDefined();
  });
});
