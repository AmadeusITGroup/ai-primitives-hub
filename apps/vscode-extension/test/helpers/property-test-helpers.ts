/**
 * Property-Based Test Helpers
 *
 * Shared utilities for property-based tests across adapter test files.
 * These helpers provide consistent patterns for error checking, logging,
 * HTTP mocking, and test configuration.
 *
 * Usage:
 * ```typescript
 * import { ErrorCheckers, LoggerHelpers, PropertyTestConfig, createMockHttpResponse } from '../helpers/property-test-helpers';
 * ```
 */

import * as fc from 'fast-check';
import * as sinon from 'sinon';

/**
 * HTTP status code to message mapping
 * Common HTTP status codes used in adapter tests
 */
export const HTTP_STATUS_MESSAGES: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable'
};

/**
 * Error checking utilities for adapter tests
 *
 * Provides consistent error message validation across property-based tests.
 * These helpers check for specific error patterns in adapter error messages.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
export const ErrorCheckers = {
  /**
   * Check if error indicates HTML content was detected instead of JSON
   * Used to verify proper Content-Type validation
   * @param error
   */
  indicatesHtmlDetection: (error: Error): boolean => {
    const msg = error.message.toLowerCase();
    return msg.includes('html')
      || msg.includes('content-type')
      || msg.includes('format')
      || msg.includes('parse');
  },

  /**
   * Check if error indicates an authentication issue
   * Used to verify proper auth error handling
   * @param error
   */
  indicatesAuthIssue: (error: Error): boolean => {
    const msg = error.message.toLowerCase();
    return msg.includes('authentication')
      || msg.includes('unauthorized')
      || msg.includes('forbidden')
      || msg.includes('access')
      || msg.includes('html');
  },

  /**
   * Check if error is specifically a JSON parsing error (not HTML-related)
   * Used to distinguish between JSON parse errors and HTML detection
   * @param error
   */
  isJsonParseError: (error: Error): boolean => {
    const msg = error.message.toLowerCase();
    return msg.includes('json')
      && msg.includes('parse')
      && !msg.includes('html');
  },

  /**
   * Check if error mentions any parsing issue
   * Used for general parsing error validation
   * @param error
   */
  mentionsParsingIssue: (error: Error): boolean => {
    const msg = error.message.toLowerCase();
    return msg.includes('parse')
      || msg.includes('format')
      || msg.includes('invalid')
      || msg.includes('error');
  },

  /**
   * Check if error indicates a network issue
   * Used to verify network error handling
   * @param error
   */
  indicatesNetworkIssue: (error: Error): boolean => {
    const msg = error.message.toLowerCase();
    return msg.includes('network')
      || msg.includes('timeout')
      || msg.includes('connection')
      || msg.includes('econnrefused')
      || msg.includes('enotfound');
  },

  /**
   * Check if error indicates a rate limit issue
   * Used to verify rate limit handling
   * @param error
   */
  indicatesRateLimit: (error: Error): boolean => {
    const msg = error.message.toLowerCase();
    return msg.includes('rate limit')
      || msg.includes('too many requests')
      || msg.includes('429');
  }
};

/**
 * Logger management utilities for tests with stubbed loggers
 *
 * Provides consistent logger interaction patterns across property-based tests.
 * Requires a sinon-stubbed Logger instance.
 */
export class LoggerHelpers {
  constructor(private readonly loggerStub: sinon.SinonStubbedInstance<any>) {}

  /**
   * Reset all logger stub history
   * Call this before capturing logs for a specific test scenario
   */
  public resetHistory(): void {
    this.loggerStub.debug?.resetHistory();
    this.loggerStub.info?.resetHistory();
    this.loggerStub.warn?.resetHistory();
    this.loggerStub.error?.resetHistory();
  }

  /**
   * Collect all log calls from all log levels
   * Returns array of sinon spy calls
   */
  public collectAllCalls(): sinon.SinonSpyCall[] {
    return [
      ...(this.loggerStub.debug?.getCalls() || []),
      ...(this.loggerStub.info?.getCalls() || []),
      ...(this.loggerStub.warn?.getCalls() || []),
      ...(this.loggerStub.error?.getCalls() || [])
    ];
  }

  /**
   * Check if any log contains the specified text (case-insensitive)
   * Useful for verifying specific log messages were emitted
   * @param searchText
   */
  public hasLogContaining(searchText: string): boolean {
    return this.collectAllCalls().some((call) => {
      const message = call.args[0]?.toString().toLowerCase() || '';
      return message.includes(searchText.toLowerCase());
    });
  }

  /**
   * Get all error-level log messages
   * Returns array of error message strings
   */
  public getErrorMessages(): string[] {
    return (this.loggerStub.error?.getCalls() || [])
      .map((call: sinon.SinonSpyCall) => call.args[0]?.toString() || '');
  }

  /**
   * Get all debug-level log messages
   * Returns array of debug message strings
   */
  public getDebugMessages(): string[] {
    return (this.loggerStub.debug?.getCalls() || [])
      .map((call: sinon.SinonSpyCall) => call.args[0]?.toString() || '');
  }

  /**
   * Check if any log at specified level contains text
   * @param level
   * @param searchText
   */
  public hasLogAtLevel(level: 'debug' | 'info' | 'warn' | 'error', searchText: string): boolean {
    const calls = this.loggerStub[level]?.getCalls() || [];
    return calls.some((call: sinon.SinonSpyCall) => {
      const message = call.args[0]?.toString().toLowerCase() || '';
      return message.includes(searchText.toLowerCase());
    });
  }
}

/**
 * Property test configuration
 *
 * Centralized configuration for property-based tests.
 * Optimized for speed while maintaining good coverage.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
export const PropertyTestConfig = {
  /**
   * Number of test runs for different test complexity levels
   * Reduced for faster execution while maintaining coverage
   */
  RUNS: {
    QUICK: 3, // Quick smoke tests
    STANDARD: 5, // Standard property tests
    EXTENDED: 8, // Tests with more complex scenarios
    COMPREHENSIVE: 10, // Tests covering many combinations
    THOROUGH: 15 // Thorough testing (use sparingly)
  },

  /**
   * Default timeout for property-based tests (milliseconds)
   * Reduced for faster feedback
   */
  TIMEOUT: 5000,

  /**
   * Fast-check options optimized for speed
   */
  FAST_CHECK_OPTIONS: {
    verbose: false,
    endOnFailure: true, // Stop on first failure for faster feedback
    interruptAfterTimeLimit: 1000 // Stop after 1 second per property
  }
};

/**
 * Create a mock HTTP response object
 *
 * Returns a mock that mimics Node.js IncomingMessage behavior.
 * Useful for testing HTTP adapter logic without real network calls.
 * @param statusCode - HTTP status code (e.g., 200, 404, 500)
 * @param responseBody - Response body as string (default: JSON error)
 * @param contentType - Content-Type header value (default: application/json)
 * @returns Mock response object with on() method for event handling
 */
export const createMockHttpResponse = (
  statusCode: number,
  responseBody: string = JSON.stringify({ message: 'Error' }),
  contentType = 'application/json'
) => {
  const mockResponse = {
    statusCode,
    statusMessage: HTTP_STATUS_MESSAGES[statusCode] || 'Unknown',
    headers: {
      'content-type': contentType,
      'content-length': responseBody.length.toString()
    },
    on: (event: 'data' | 'end' | 'error', handler: (arg?: any) => void) => {
      if (event === 'data') {
        handler(Buffer.from(responseBody));
      } else if (event === 'end') {
        handler();
      }
      // 'error' events are not emitted in this mock
      return mockResponse; // Return same instance for proper chaining
    }
  };

  return mockResponse;
};

/**
 * Stub HTTPS module to return a mock response
 *
 * Optimized version that reuses mock objects for better performance.
 * @param sandbox - Sinon sandbox for stub management
 * @param statusCode - HTTP status code to return
 * @param responseBody - Optional response body (default: JSON error)
 * @param contentType - Optional Content-Type header (default: application/json)
 * @returns Sinon stub for verification
 */
export const stubHttpsWithResponse = (
  sandbox: sinon.SinonSandbox,
  statusCode: number,
  responseBody?: string,
  contentType?: string
) => {
  const https = require('node:https');
  const mockResponse = createMockHttpResponse(statusCode, responseBody, contentType);

  // Reuse existing stub if it exists, otherwise create new one
  const existingStub = https.get?.isSinonProxy ? https.get : null;
  if (existingStub) {
    existingStub.callsFake((...args: any[]) => {
      const callback = args[2] || args[1];
      if (typeof callback === 'function') {
        callback(mockResponse);
      }
      return { on: () => ({ on: () => {} }) };
    });
    return existingStub;
  }

  return sandbox.stub(https, 'get')
    .callsFake((...args: any[]) => {
      const callback = args[2] || args[1];
      if (typeof callback === 'function') {
        callback(mockResponse);
      }
      return { on: () => ({ on: () => {} }) };
    });
};

/**
 * Common test data generators for fast-check
 *
 * These generators provide reusable arbitraries for property-based tests.
 * They ensure consistent test data generation across different test files.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
export const TestGenerators = {
  /**
   * Generate a valid GitHub token string
   * Filters out whitespace-only strings to ensure valid tokens
   */
  githubToken: () => {
    return fc.string({ minLength: 20, maxLength: 50 })
      .filter((s) => s.trim().length > 0);
  },

  /**
   * Generate a valid HTTP URL
   * Uses fast-check's built-in webUrl generator
   */
  httpUrl: () => {
    return fc.webUrl({ validSchemes: ['http', 'https'] });
  },

  /**
   * Generate a valid GitHub repository URL
   * Format: https://github.com/{owner}/{repo}
   * Owner: 1-39 chars, alphanumeric + hyphens
   * Repo: 1-100 chars, alphanumeric + hyphens + underscores
   */
  githubRepoUrl: () => {
    const ownerChars = 'abcdefghijklmnopqrstuvwxyz0123456789-'.split('');
    const repoChars = 'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('');

    return fc.tuple(
      fc.array(fc.constantFrom(...ownerChars), { minLength: 1, maxLength: 39 })
        .map((chars) => chars.join('')),
      fc.array(fc.constantFrom(...repoChars), { minLength: 1, maxLength: 100 })
        .map((chars) => chars.join(''))
    ).map(([owner, repo]) => `https://github.com/${owner}/${repo}`);
  },

  /**
   * Generate HTTP status codes by category
   * @param type - Optional category filter (success, client-error, server-error)
   * @returns Arbitrary that generates status codes from the specified category
   */
  httpStatusCode: (type?: 'success' | 'client-error' | 'server-error') => {
    switch (type) {
      case 'success': {
        return fc.constantFrom(200, 201, 204);
      }
      case 'client-error': {
        return fc.constantFrom(400, 401, 403, 404, 429);
      }
      case 'server-error': {
        return fc.constantFrom(500, 502, 503);
      }
      default: {
        return fc.constantFrom(200, 201, 400, 401, 403, 404, 429, 500, 502, 503);
      }
    }
  },

  /**
   * Generate Content-Type header values
   * Includes common types: JSON, HTML, plain text, binary
   */
  contentType: () => {
    return fc.constantFrom(
      'application/json',
      'application/json; charset=utf8',
      'text/html',
      'text/html; charset=utf8',
      'text/plain',
      'application/octet-stream'
    );
  }
};

/**
 * Bundle-specific test data generators
 *
 * Shared generators for bundle-related property-based tests.
 * Ensures consistent version and bundle ID generation across test files.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
export const BundleGenerators = {
  /**
   * Generate semantic version strings (0-10 for each component)
   * Format: "major.minor.patch" (e.g., "1.2.3")
   *
   * Used across AutoUpdateService, UpdateChecker, and RegistryTreeProvider tests.
   */
  version: () => {
    return fc.tuple(
      fc.integer({ min: 0, max: 10 }),
      fc.integer({ min: 0, max: 10 }),
      fc.integer({ min: 0, max: 10 })
    ).map(([major, minor, patch]) => `${major}.${minor}.${patch}`);
  },

  /**
   * Generate valid bundle IDs
   * Format: lowercase alphanumeric with hyphens, 1-20 chars
   *
   * Used across AutoUpdateService, UpdateChecker, and RegistryTreeProvider tests.
   */
  bundleId: () => {
    return fc.string({ minLength: 1, maxLength: 20 })
      .map((s) => s.replace(/[^a-zA-Z0-9-]/g, 'a').toLowerCase());
  },

  /**
   * Generate semantic version tuples (for UpdateChecker compatibility)
   * Returns tuple of [major, minor, patch] integers
   * @param maxMajor - Maximum major version (default: 10)
   * @param maxMinor - Maximum minor version (default: 10)
   * @param maxPatch - Maximum patch version (default: 10)
   */
  versionTuple: (maxMajor = 10, maxMinor = 10, maxPatch = 10) => {
    return fc.tuple(
      fc.integer({ min: 0, max: maxMajor }),
      fc.integer({ min: 0, max: maxMinor }),
      fc.integer({ min: 0, max: maxPatch })
    );
  }
};
