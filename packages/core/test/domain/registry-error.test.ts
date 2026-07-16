/**
 * Coverage tests for domain/registry-error.ts.
 *
 * Tests RegistryError class, validateCode, and isRegistryError type guard.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  isRegistryError,
  RegistryError,
  type RegistryErrorJson,
  type RegistryErrorOptions,
} from '../../src/domain/registry-error';

describe('RegistryError', () => {
  it('creates error with required fields', () => {
    const opts: RegistryErrorOptions = {
      code: 'BUNDLE.NOT_FOUND',
      message: 'Bundle not found'
    };
    const error = new RegistryError(opts);
    expect(error.name).toBe('RegistryError');
    expect(error.code).toBe('BUNDLE.NOT_FOUND');
    expect(error.message).toBe('Bundle not found');
  });

  it('creates error with optional hint', () => {
    const error = new RegistryError({
      code: 'BUNDLE.NOT_FOUND',
      message: 'Bundle not found',
      hint: 'Run `ai-primitives-hub bundle list` to see available bundles'
    });
    expect(error.hint).toBe('Run `ai-primitives-hub bundle list` to see available bundles');
  });

  it('creates error with optional docsUrl', () => {
    const error = new RegistryError({
      code: 'BUNDLE.NOT_FOUND',
      message: 'Bundle not found',
      docsUrl: 'https://docs.example.com/errors/bundle-not-found'
    });
    expect(error.docsUrl).toBe('https://docs.example.com/errors/bundle-not-found');
  });

  it('creates error with optional context', () => {
    const error = new RegistryError({
      code: 'BUNDLE.NOT_FOUND',
      message: 'Bundle not found',
      context: { bundleId: 'test-bundle', version: '1.0.0' }
    });
    expect(error.context).toEqual({ bundleId: 'test-bundle', version: '1.0.0' });
  });

  it('creates error with optional cause', () => {
    const cause = new Error('Underlying error');
    const error = new RegistryError({
      code: 'BUNDLE.NOT_FOUND',
      message: 'Bundle not found',
      cause
    });
    expect(error.cause).toBe(cause);
  });

  it('serializes to JSON with all fields', () => {
    const error = new RegistryError({
      code: 'BUNDLE.NOT_FOUND',
      message: 'Bundle not found',
      hint: 'Check bundle list',
      docsUrl: 'https://docs.example.com',
      context: { bundleId: 'test' }
    });
    const json: RegistryErrorJson = error.toJSON();
    expect(json).toEqual({
      code: 'BUNDLE.NOT_FOUND',
      message: 'Bundle not found',
      hint: 'Check bundle list',
      docsUrl: 'https://docs.example.com',
      context: { bundleId: 'test' }
    });
  });

  it('serializes to JSON with only required fields', () => {
    const error = new RegistryError({
      code: 'BUNDLE.NOT_FOUND',
      message: 'Bundle not found'
    });
    const json: RegistryErrorJson = error.toJSON();
    expect(json).toEqual({
      code: 'BUNDLE.NOT_FOUND',
      message: 'Bundle not found'
    });
  });

  it('throws TypeError for invalid code format', () => {
    expect(() => new RegistryError({
      code: 'INVALID_FORMAT',
      message: 'Test'
    })).toThrow(TypeError);
  });

  it('throws TypeError for invalid namespace', () => {
    expect(() => new RegistryError({
      code: 'INVALID_NAMESPACE.ERROR',
      message: 'Test'
    })).toThrow(TypeError);
  });

  it('accepts all valid namespaces', () => {
    const validNamespaces = ['BUNDLE', 'INDEX', 'HUB', 'PRIMITIVE', 'CONFIG', 'NETWORK', 'AUTH', 'FS', 'PLUGIN', 'USAGE', 'INTERNAL'];
    for (const ns of validNamespaces) {
      const error = new RegistryError({
        code: `${ns}.TEST_ERROR`,
        message: 'Test'
      });
      expect(error.code).toBe(`${ns}.TEST_ERROR`);
    }
  });
});

describe('isRegistryError', () => {
  it('returns true for RegistryError instance', () => {
    const error = new RegistryError({
      code: 'BUNDLE.NOT_FOUND',
      message: 'Test'
    });
    expect(isRegistryError(error)).toBe(true);
  });

  it('returns false for plain Error', () => {
    const error = new Error('Test');
    expect(isRegistryError(error)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isRegistryError(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isRegistryError(undefined)).toBe(false);
  });

  it('returns false for non-object', () => {
    expect(isRegistryError('string')).toBe(false);
    expect(isRegistryError(123)).toBe(false);
  });
});
