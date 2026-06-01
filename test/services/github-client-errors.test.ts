import * as assert from 'node:assert';
import {
  GitHubAuthError,
  GitHubClientError,
  GitHubNotFoundError,
  GitHubRateLimitError,
} from '../../src/services/github-client-errors';

suite('GitHubClientErrors', () => {
  test('GitHubClientError extends Error with statusCode', () => {
    const error = new GitHubClientError('test error', 500);
    assert.strictEqual(error.message, 'test error');
    assert.strictEqual(error.statusCode, 500);
    assert.strictEqual(error.name, 'GitHubClientError');
    assert.ok(error instanceof Error);
  });

  test('GitHubAuthError is a GitHubClientError with 401/403', () => {
    const error = new GitHubAuthError('unauthorized');
    assert.strictEqual(error.statusCode, 401);
    assert.strictEqual(error.name, 'GitHubAuthError');
    assert.ok(error instanceof GitHubClientError);
  });

  test('GitHubNotFoundError is a GitHubClientError with 404', () => {
    const error = new GitHubNotFoundError('owner', 'repo');
    assert.strictEqual(error.statusCode, 404);
    assert.ok(error.message.includes('owner/repo'));
    assert.ok(error instanceof GitHubClientError);
  });

  test('GitHubRateLimitError includes resetAt date', () => {
    const resetAt = new Date('2026-06-01T00:00:00Z');
    const error = new GitHubRateLimitError(resetAt);
    assert.strictEqual(error.statusCode, 403);
    assert.strictEqual(error.resetAt, resetAt);
    assert.ok(error.message.includes('rate limit'));
    assert.ok(error instanceof GitHubClientError);
  });
});
