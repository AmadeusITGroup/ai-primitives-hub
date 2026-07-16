import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  categorizeError,
} from '../../src/domain/errors';

describe('categorizeError', () => {
  it('categorizes network errors', () => {
    expect(categorizeError(new Error('Network timeout'))).toBe('network');
    expect(categorizeError(new Error('ECONNREFUSED'))).toBe('network');
    expect(categorizeError(new Error('DNS lookup failed'))).toBe('network');
  });

  it('categorizes not-found errors', () => {
    expect(categorizeError(new Error('Resource not found'))).toBe('notfound');
    expect(categorizeError(new Error('Request failed with 404'))).toBe('notfound');
  });

  it('categorizes validation errors', () => {
    expect(categorizeError(new Error('Invalid input'))).toBe('validation');
    expect(categorizeError(new Error('Schema validation failed'))).toBe('validation');
  });

  it('categorizes authentication errors', () => {
    expect(categorizeError(new Error('Unauthorized'))).toBe('authentication');
    expect(categorizeError(new Error('403 Forbidden'))).toBe('authentication');
  });

  it('falls back to unexpected for unrecognized messages', () => {
    expect(categorizeError(new Error('Something exploded'))).toBe('unexpected');
  });

  it('is case-insensitive', () => {
    expect(categorizeError(new Error('NETWORK TIMEOUT'))).toBe('network');
  });
});
