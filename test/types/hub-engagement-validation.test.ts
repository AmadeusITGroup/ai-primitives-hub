import * as assert from 'node:assert';
import {
  suite,
  test,
} from 'mocha';
import {
  validateHubConfig,
} from '../../src/types/hub';

suite('Hub Engagement Configuration Validation', () => {
  test('should accept valid engagement configuration with all fields', () => {
    const config = {
      version: '1.0.0',
      metadata: {
        name: 'Test Hub',
        description: 'Test hub description',
        maintainer: 'test@example.com',
        updatedAt: '2025-01-29T00:00:00Z'
      },
      sources: [
        {
          id: 'test-source',
          type: 'github',
          enabled: true,
          priority: 1
        }
      ],
      profiles: [],
      engagement: {
        enabled: true,
        backend: {
          type: 'github-discussions',
          repository: 'owner/repo'
        },
        ratings: {
          enabled: true,
          ratingsUrl: 'https://example.com/ratings.json'
        },
        feedback: {
          enabled: true,
          requireRating: false,
          maxLength: 2000,
          feedbackUrl: 'https://example.com/feedbacks.json'
        }
      }
    };

    const result = validateHubConfig(config);
    assert.strictEqual(result.valid, true, `Validation failed: ${result.errors.join(', ')}`);
    assert.strictEqual(result.errors.length, 0);
  });

  test('should accept engagement configuration without optional URLs', () => {
    const config = {
      version: '1.0.0',
      metadata: {
        name: 'Test Hub',
        description: 'Test hub description',
        maintainer: 'test@example.com',
        updatedAt: '2025-01-29T00:00:00Z'
      },
      sources: [
        {
          id: 'test-source',
          type: 'github',
          enabled: true,
          priority: 1
        }
      ],
      profiles: [],
      engagement: {
        enabled: true,
        backend: {
          type: 'file'
        },
        ratings: {
          enabled: true
        },
        feedback: {
          enabled: true
        }
      }
    };

    const result = validateHubConfig(config);
    assert.strictEqual(result.valid, true, `Validation failed: ${result.errors.join(', ')}`);
    assert.strictEqual(result.errors.length, 0);
  });

  test('should reject invalid ratingsUrl', () => {
    const config = {
      version: '1.0.0',
      metadata: {
        name: 'Test Hub',
        description: 'Test hub description',
        maintainer: 'test@example.com',
        updatedAt: '2025-01-29T00:00:00Z'
      },
      sources: [
        {
          id: 'test-source',
          type: 'github',
          enabled: true,
          priority: 1
        }
      ],
      profiles: [],
      engagement: {
        enabled: true,
        ratings: {
          enabled: true,
          ratingsUrl: 'not-a-valid-url'
        }
      }
    };

    const result = validateHubConfig(config);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('ratingsUrl')));
  });

  test('should reject invalid feedbackUrl', () => {
    const config = {
      version: '1.0.0',
      metadata: {
        name: 'Test Hub',
        description: 'Test hub description',
        maintainer: 'test@example.com',
        updatedAt: '2025-01-29T00:00:00Z'
      },
      sources: [
        {
          id: 'test-source',
          type: 'github',
          enabled: true,
          priority: 1
        }
      ],
      profiles: [],
      engagement: {
        enabled: true,
        feedback: {
          enabled: true,
          feedbackUrl: 'invalid-url'
        }
      }
    };

    const result = validateHubConfig(config);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('feedbackUrl')));
  });

  test('should reject non-string ratingsUrl', () => {
    const config = {
      version: '1.0.0',
      metadata: {
        name: 'Test Hub',
        description: 'Test hub description',
        maintainer: 'test@example.com',
        updatedAt: '2025-01-29T00:00:00Z'
      },
      sources: [
        {
          id: 'test-source',
          type: 'github',
          enabled: true,
          priority: 1
        }
      ],
      profiles: [],
      engagement: {
        enabled: true,
        ratings: {
          enabled: true,
          ratingsUrl: 123 as any
        }
      }
    };

    const result = validateHubConfig(config);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('ratingsUrl') && e.includes('string')));
  });

  test('should reject non-string feedbackUrl', () => {
    const config = {
      version: '1.0.0',
      metadata: {
        name: 'Test Hub',
        description: 'Test hub description',
        maintainer: 'test@example.com',
        updatedAt: '2025-01-29T00:00:00Z'
      },
      sources: [
        {
          id: 'test-source',
          type: 'github',
          enabled: true,
          priority: 1
        }
      ],
      profiles: [],
      engagement: {
        enabled: true,
        feedback: {
          enabled: true,
          feedbackUrl: { url: 'test' } as any
        }
      }
    };

    const result = validateHubConfig(config);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('feedbackUrl') && e.includes('string')));
  });

  test('should accept hub config without engagement section', () => {
    const config = {
      version: '1.0.0',
      metadata: {
        name: 'Test Hub',
        description: 'Test hub description',
        maintainer: 'test@example.com',
        updatedAt: '2025-01-29T00:00:00Z'
      },
      sources: [
        {
          id: 'test-source',
          type: 'github',
          enabled: true,
          priority: 1
        }
      ],
      profiles: []
    };

    const result = validateHubConfig(config);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.length, 0);
  });

  test('should validate backend type for github-discussions', () => {
    const config = {
      version: '1.0.0',
      metadata: {
        name: 'Test Hub',
        description: 'Test hub description',
        maintainer: 'test@example.com',
        updatedAt: '2025-01-29T00:00:00Z'
      },
      sources: [
        {
          id: 'test-source',
          type: 'github',
          enabled: true,
          priority: 1
        }
      ],
      profiles: [],
      engagement: {
        enabled: true,
        backend: {
          type: 'github-discussions'
          // Missing repository field
        }
      }
    };

    const result = validateHubConfig(config);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('repository')));
  });
});
