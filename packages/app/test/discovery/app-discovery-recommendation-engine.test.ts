/**
 * Tests for recommendation engine.
 * @module test/app/discovery/recommendation-engine
 */

import type {
  DiscoveryOptions,
} from '@prompt-registry/core';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type {
  DetectedContext,
} from '../../src/context-detection';
import {
  RecommendationEngine,
  RecommendationEngineError,
} from '../../src/discovery/recommendation-engine';

describe('RecommendationEngine', () => {
  let mockContext: DetectedContext;
  let mockCopilotSdk: any;

  beforeEach(() => {
    mockContext = {
      techStack: {
        languages: ['TypeScript'],
        frameworks: ['React'],
        packageManagers: ['npm'],
        buildTools: [],
        testFrameworks: []
      },
      domain: {
        category: 'web-application',
        businessDomain: 'authentication',
        technicalDomain: 'frontend'
      },
      activity: {
        recentFiles: [],
        workingDirectory: '/test/project'
      },
      detectedAt: new Date().toISOString()
    };

    mockCopilotSdk = {
      isAvailable: vi.fn(),
      createSession: vi.fn()
    };
  });

  it('should fallback to current behavior when AI unavailable', async () => {
    mockCopilotSdk.isAvailable.mockReturnValue(false);

    const engine = new RecommendationEngine(mockCopilotSdk);
    const options: DiscoveryOptions = {
      enableAI: true,
      interactive: false,
      cwd: '/test/project'
    };

    const recommendations = await engine.generateRecommendations(mockContext, options);

    expect(recommendations).toBeDefined();
    expect(Array.isArray(recommendations)).toBe(true);
    // Should fall back to query-based search
    expect(mockCopilotSdk.createSession).not.toHaveBeenCalled();
  });

  it('should use AI when available and enabled', async () => {
    const mockSession = {
      sendAndWait: vi.fn().mockResolvedValue(JSON.stringify({
        recommendations: [
          {
            type: 'profile',
            id: 'profile-1',
            name: 'Frontend Developer',
            description: 'Profile for frontend development',
            relevanceScore: 0.95,
            reasoning: 'Matches your React frontend stack',
            source: 'amadeus-hub',
            aiRecommended: true
          }
        ]
      })),
      close: vi.fn()
    };

    mockCopilotSdk.isAvailable.mockReturnValue(true);
    mockCopilotSdk.createSession.mockResolvedValue(mockSession);

    const engine = new RecommendationEngine(mockCopilotSdk);
    const options: DiscoveryOptions = {
      enableAI: true,
      interactive: false,
      cwd: '/test/project'
    };

    const recommendations = await engine.generateRecommendations(mockContext, options);

    expect(mockCopilotSdk.createSession).toHaveBeenCalled();
    expect(mockSession.sendAndWait).toHaveBeenCalled();
    expect(mockSession.close).toHaveBeenCalled();
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0].aiRecommended).toBe(true);
  });

  it('should throw RecommendationEngineError when context is null', async () => {
    const engine = new RecommendationEngine(mockCopilotSdk);
    const options: DiscoveryOptions = {
      enableAI: true,
      interactive: false,
      cwd: '/test/project'
    };

    await expect(
      engine.generateRecommendations(null as unknown as DetectedContext, options)
    ).rejects.toThrow(RecommendationEngineError);
    await expect(
      engine.generateRecommendations(null as unknown as DetectedContext, options)
    ).rejects.toThrow('Context is required for recommendation generation');
  });

  it('should throw RecommendationEngineError when context is undefined', async () => {
    const engine = new RecommendationEngine(mockCopilotSdk);
    const options: DiscoveryOptions = {
      enableAI: true,
      interactive: false,
      cwd: '/test/project'
    };

    await expect(
      engine.generateRecommendations(undefined as unknown as DetectedContext, options)
    ).rejects.toThrow(RecommendationEngineError);
  });

  it('should not use AI when enableAI is false', async () => {
    mockCopilotSdk.isAvailable.mockReturnValue(true);

    const engine = new RecommendationEngine(mockCopilotSdk);
    const options: DiscoveryOptions = {
      enableAI: false,
      interactive: false,
      cwd: '/test/project'
    };

    const recommendations = await engine.generateRecommendations(mockContext, options);

    expect(mockCopilotSdk.createSession).not.toHaveBeenCalled();
    expect(recommendations).toBeDefined();
  });

  it('should handle AI session errors gracefully', async () => {
    mockCopilotSdk.isAvailable.mockReturnValue(true);
    mockCopilotSdk.createSession.mockRejectedValue(new Error('SDK error'));

    const engine = new RecommendationEngine(mockCopilotSdk);
    const options: DiscoveryOptions = {
      enableAI: true,
      interactive: false,
      cwd: '/test/project'
    };

    // Should throw RecommendationEngineError for session creation failure
    await expect(engine.generateRecommendations(mockContext, options)).rejects.toThrow(
      RecommendationEngineError
    );
    await expect(engine.generateRecommendations(mockContext, options)).rejects.toThrow(
      'Failed to create AI session'
    );
  });

  it('should handle malformed AI response gracefully', async () => {
    const mockSession = {
      sendAndWait: vi.fn().mockResolvedValue('invalid json'),
      close: vi.fn()
    };

    mockCopilotSdk.isAvailable.mockReturnValue(true);
    mockCopilotSdk.createSession.mockResolvedValue(mockSession);

    const engine = new RecommendationEngine(mockCopilotSdk);
    const options: DiscoveryOptions = {
      enableAI: true,
      interactive: false,
      cwd: '/test/project'
    };

    const recommendations = await engine.generateRecommendations(mockContext, options);

    // Should fall back to query-based search on parse error
    expect(recommendations).toBeDefined();
  });

  it('should handle empty AI response gracefully', async () => {
    const mockSession = {
      sendAndWait: vi.fn().mockResolvedValue(''),
      close: vi.fn()
    };

    mockCopilotSdk.isAvailable.mockReturnValue(true);
    mockCopilotSdk.createSession.mockResolvedValue(mockSession);

    const engine = new RecommendationEngine(mockCopilotSdk);
    const options: DiscoveryOptions = {
      enableAI: true,
      interactive: false,
      cwd: '/test/project'
    };

    const recommendations = await engine.generateRecommendations(mockContext, options);

    expect(recommendations).toEqual([]);
    expect(mockSession.close).toHaveBeenCalled();
  });

  it('should handle AI response with no recommendations field', async () => {
    const mockSession = {
      sendAndWait: vi.fn().mockResolvedValue(JSON.stringify({})),
      close: vi.fn()
    };

    mockCopilotSdk.isAvailable.mockReturnValue(true);
    mockCopilotSdk.createSession.mockResolvedValue(mockSession);

    const engine = new RecommendationEngine(mockCopilotSdk);
    const options: DiscoveryOptions = {
      enableAI: true,
      interactive: false,
      cwd: '/test/project'
    };

    const recommendations = await engine.generateRecommendations(mockContext, options);

    expect(recommendations).toEqual([]);
    expect(mockSession.close).toHaveBeenCalled();
  });

  it('should handle AI request errors gracefully', async () => {
    const mockSession = {
      sendAndWait: vi.fn().mockRejectedValue(new Error('Network error')),
      close: vi.fn()
    };

    mockCopilotSdk.isAvailable.mockReturnValue(true);
    mockCopilotSdk.createSession.mockResolvedValue(mockSession);

    const engine = new RecommendationEngine(mockCopilotSdk);
    const options: DiscoveryOptions = {
      enableAI: true,
      interactive: false,
      cwd: '/test/project'
    };

    await expect(engine.generateRecommendations(mockContext, options)).rejects.toThrow(
      RecommendationEngineError
    );
    await expect(engine.generateRecommendations(mockContext, options)).rejects.toThrow(
      'Failed to send request to AI'
    );
  });

  it('should handle session close errors gracefully', async () => {
    const mockSession = {
      sendAndWait: vi.fn().mockResolvedValue(JSON.stringify({
        recommendations: [
          {
            type: 'profile',
            id: 'profile-1',
            name: 'Test Profile',
            description: 'Test',
            relevanceScore: 0.9,
            reasoning: 'Test',
            source: 'test',
            aiRecommended: true
          }
        ]
      })),
      close: vi.fn().mockRejectedValue(new Error('Close error'))
    };

    mockCopilotSdk.isAvailable.mockReturnValue(true);
    mockCopilotSdk.createSession.mockResolvedValue(mockSession);

    const engine = new RecommendationEngine(mockCopilotSdk);
    const options: DiscoveryOptions = {
      enableAI: true,
      interactive: false,
      cwd: '/test/project'
    };

    const recommendations = await engine.generateRecommendations(mockContext, options);

    // Should still return recommendations even if close fails
    expect(recommendations).toHaveLength(1);
    expect(mockSession.close).toHaveBeenCalled();
  });

  it('should handle AI timeout gracefully', async () => {
    const timeoutSdk = {
      isAvailable: vi.fn().mockResolvedValue(true),
      createSession: vi.fn().mockResolvedValue({
        sendAndWait: vi.fn().mockImplementation(() => new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), 10)
        )),
        sendWithStream: vi.fn(),
        close: vi.fn()
      })
    };

    const engine = new RecommendationEngine(timeoutSdk);
    const options: DiscoveryOptions = {
      kinds: ['skill', 'prompt'],
      limit: 10,
      indexFile: '/test/index.json',
      cwd: '/test/project',
      enableAI: true,
      interactive: false
    };

    // Timeout errors are thrown as RecommendationEngineError
    await expect(engine.generateRecommendations(mockContext, options)).rejects.toThrow(
      RecommendationEngineError
    );
  });

  it('should handle AI response with null values gracefully', async () => {
    const nullResponseSdk = {
      isAvailable: vi.fn().mockResolvedValue(true),
      createSession: vi.fn().mockResolvedValue({
        sendAndWait: vi.fn().mockResolvedValue('[null, null]'),
        sendWithStream: vi.fn(),
        close: vi.fn()
      })
    };

    const engine = new RecommendationEngine(nullResponseSdk);
    const options: DiscoveryOptions = {
      kinds: ['skill', 'prompt'],
      limit: 10,
      indexFile: '/test/index.json',
      cwd: '/test/project',
      enableAI: true,
      interactive: false
    };

    const recommendations = await engine.generateRecommendations(mockContext, options);
    expect(recommendations).toBeDefined();
  });

  it('should handle AI response with missing required fields gracefully', async () => {
    const missingFieldsSdk = {
      isAvailable: vi.fn().mockResolvedValue(true),
      createSession: vi.fn().mockResolvedValue({
        sendAndWait: vi.fn().mockResolvedValue('[{"id": "test"}]'),
        sendWithStream: vi.fn(),
        close: vi.fn()
      })
    };

    const engine = new RecommendationEngine(missingFieldsSdk);
    const options: DiscoveryOptions = {
      kinds: ['skill', 'prompt'],
      limit: 10,
      indexFile: '/test/index.json',
      cwd: '/test/project',
      enableAI: true,
      interactive: false
    };

    const recommendations = await engine.generateRecommendations(mockContext, options);
    expect(recommendations).toBeDefined();
  });

  it('should handle AI response with invalid score gracefully', async () => {
    const invalidScoreSdk = {
      isAvailable: vi.fn().mockResolvedValue(true),
      createSession: vi.fn().mockResolvedValue({
        sendAndWait: vi.fn().mockResolvedValue('[{"id": "test", "score": "invalid"}]'),
        sendWithStream: vi.fn(),
        close: vi.fn()
      })
    };

    const engine = new RecommendationEngine(invalidScoreSdk);
    const options: DiscoveryOptions = {
      kinds: ['skill', 'prompt'],
      limit: 10,
      indexFile: '/test/index.json',
      cwd: '/test/project',
      enableAI: true,
      interactive: false
    };

    const recommendations = await engine.generateRecommendations(mockContext, options);
    expect(recommendations).toBeDefined();
  });

  it('should handle AI response with negative score gracefully', async () => {
    const negativeScoreSdk = {
      isAvailable: vi.fn().mockResolvedValue(true),
      createSession: vi.fn().mockResolvedValue({
        sendAndWait: vi.fn().mockResolvedValue('[{"id": "test", "score": -0.5}]'),
        sendWithStream: vi.fn(),
        close: vi.fn()
      })
    };

    const engine = new RecommendationEngine(negativeScoreSdk);
    const options: DiscoveryOptions = {
      kinds: ['skill', 'prompt'],
      limit: 10,
      indexFile: '/test/index.json',
      cwd: '/test/project',
      enableAI: true,
      interactive: false
    };

    const recommendations = await engine.generateRecommendations(mockContext, options);
    expect(recommendations).toBeDefined();
  });

  it('should handle AI response with score > 1 gracefully', async () => {
    const highScoreSdk = {
      isAvailable: vi.fn().mockResolvedValue(true),
      createSession: vi.fn().mockResolvedValue({
        sendAndWait: vi.fn().mockResolvedValue('[{"id": "test", "score": 1.5}]'),
        sendWithStream: vi.fn(),
        close: vi.fn()
      })
    };

    const engine = new RecommendationEngine(highScoreSdk);
    const options: DiscoveryOptions = {
      kinds: ['skill', 'prompt'],
      limit: 10,
      indexFile: '/test/index.json',
      cwd: '/test/project',
      enableAI: true,
      interactive: false
    };

    const recommendations = await engine.generateRecommendations(mockContext, options);
    expect(recommendations).toBeDefined();
  });

  it('should handle AI response with very large score gracefully', async () => {
    const largeScoreSdk = {
      isAvailable: vi.fn().mockResolvedValue(true),
      createSession: vi.fn().mockResolvedValue({
        sendAndWait: vi.fn().mockResolvedValue('[{"id": "test", "score": 999999}]'),
        sendWithStream: vi.fn(),
        close: vi.fn()
      })
    };

    const engine = new RecommendationEngine(largeScoreSdk);
    const options: DiscoveryOptions = {
      kinds: ['skill', 'prompt'],
      limit: 10,
      indexFile: '/test/index.json',
      cwd: '/test/project',
      enableAI: true,
      interactive: false
    };

    const recommendations = await engine.generateRecommendations(mockContext, options);
    expect(recommendations).toBeDefined();
  });

  it('should handle AI response with very large array gracefully', async () => {
    const largeArraySdk = {
      isAvailable: vi.fn().mockResolvedValue(true),
      createSession: vi.fn().mockResolvedValue({
        sendAndWait: vi.fn().mockResolvedValue(JSON.stringify(
          Array.from({ length: 1000 }, (_, i) => ({
            type: 'profile',
            id: `profile-${i}`,
            name: `Profile ${i}`,
            description: 'Test',
            relevanceScore: 0.9,
            reasoning: 'Test',
            source: 'test',
            aiRecommended: true
          }))
        )),
        sendWithStream: vi.fn(),
        close: vi.fn()
      })
    };

    const engine = new RecommendationEngine(largeArraySdk);
    const options: DiscoveryOptions = {
      kinds: ['skill', 'prompt'],
      limit: 10,
      indexFile: '/test/index.json',
      cwd: '/test/project',
      enableAI: true,
      interactive: false
    };

    const recommendations = await engine.generateRecommendations(mockContext, options);
    expect(recommendations).toBeDefined();
  });

  it('should handle AI response with unicode in fields gracefully', async () => {
    const unicodeSdk = {
      isAvailable: vi.fn().mockResolvedValue(true),
      createSession: vi.fn().mockResolvedValue({
        sendAndWait: vi.fn().mockResolvedValue(JSON.stringify({
          recommendations: [
            {
              type: 'profile',
              id: '测试-1',
              name: '测试名称 🎉',
              description: '测试说明 🚀',
              relevanceScore: 0.95,
              reasoning: '测试推理',
              source: 'test',
              aiRecommended: true
            }
          ]
        })),
        sendWithStream: vi.fn(),
        close: vi.fn()
      })
    };

    const engine = new RecommendationEngine(unicodeSdk);
    const options: DiscoveryOptions = {
      kinds: ['skill', 'prompt'],
      limit: 10,
      indexFile: '/test/index.json',
      cwd: '/test/project',
      enableAI: true,
      interactive: false
    };

    const recommendations = await engine.generateRecommendations(mockContext, options);
    expect(recommendations).toBeDefined();
  });
});
