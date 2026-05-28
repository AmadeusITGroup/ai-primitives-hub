/**
 * Recommendation engine for AI-powered resource discovery.
 *
 * Orchestrates AI recommendations with fallback to query-based search.
 * @module app/discovery/recommendation-engine
 */

import type {
  CopilotSdk,
  DiscoveryOptions,
  ResourceRecommendation,
} from '@prompt-registry/core';
import type {
  DetectedContext,
} from '../context-detection';

/**
 * Error types for recommendation engine.
 */
export class RecommendationEngineError extends Error {
  public readonly code: string;
  public readonly cause?: unknown;

  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'RecommendationEngineError';
    this.code = code;
    this.cause = cause;
  }
}

/**
 * Recommendation engine class.
 */
export class RecommendationEngine {
  private readonly copilotSdk: CopilotSdk;

  constructor(copilotSdk: CopilotSdk) {
    this.copilotSdk = copilotSdk;
  }

  /**
   * Generate AI-powered recommendations.
   * @param context - Detected context.
   * @param options - Discovery options.
   * @returns Array of AI-generated recommendations.
   * @throws {RecommendationEngineError} if AI session creation or communication fails.
   */
  private async generateAiRecommendations(
    context: DetectedContext,
    options: DiscoveryOptions
  ): Promise<ResourceRecommendation[]> {
    let session;
    try {
      session = await this.copilotSdk.createSession({
        skillDirectories: [],
        onPermissionRequest: () => {
          // Default to approving permissions
          return Promise.resolve({ kind: 'approved' });
        }
      });
    } catch (error) {
      throw new RecommendationEngineError(
        'SESSION_CREATION_FAILED',
        'Failed to create AI session',
        error
      );
    }

    try {
      // Build prompt with context
      const prompt = this.buildPrompt(context, options);

      let response: string;
      try {
        response = await session.sendAndWait(prompt);
      } catch (error) {
        throw new RecommendationEngineError(
          'AI_REQUEST_FAILED',
          'Failed to send request to AI',
          error
        );
      }

      // Parse AI response
      const aiResult = this.parseAiResponse(response);
      return aiResult.recommendations;
    } finally {
      try {
        await session.close();
      } catch {
        // Ignore close errors
      }
    }
  }

  /**
   * Generate fallback recommendations using query-based search.
   * @param context - Detected context.
   * @param _options - Discovery options.
   * @returns Array of fallback recommendations.
   */
  private generateFallbackRecommendations(
    context: DetectedContext,
    _options: DiscoveryOptions
  ): Promise<ResourceRecommendation[]> {
    // Build search queries from context (reusing existing logic)
    buildSearchQueries(context);

    // For now, return empty array - this will be integrated with
    // primitive index search in a future iteration
    return Promise.resolve([]);
  }

  /**
   * Build prompt for AI.
   * @param context - Detected context.
   * @param options - Discovery options.
   * @returns Prompt string.
   */
  private buildPrompt(context: DetectedContext, options: DiscoveryOptions): string {
    const contextSummary = {
      techStack: context.techStack,
      domain: context.domain,
      activity: context.activity
    };

    return JSON.stringify({
      task: 'recommend_resources',
      context: contextSummary,
      options: {
        limit: options.limit ?? 10,
        kinds: options.kinds
      }
    });
  }

  /**
   * Parse AI response.
   * @param response - AI response string.
   * @returns Parsed recommendations.
   */
  private parseAiResponse(response: string): { recommendations: ResourceRecommendation[] } {
    try {
      if (!response || response.trim().length === 0) {
        return { recommendations: [] };
      }

      const parsed = JSON.parse(response) as { recommendations?: ResourceRecommendation[] };
      return {
        recommendations: parsed.recommendations ?? []
      };
    } catch {
      // Return empty recommendations on parse error
      return { recommendations: [] };
    }
  }

  /**
   * Generate recommendations based on context.
   * @param context - Detected context.
   * @param options - Discovery options.
   * @returns Array of resource recommendations.
   * @throws {RecommendationEngineError} if context is invalid or generation fails.
   */
  public async generateRecommendations(
    context: DetectedContext,
    options: DiscoveryOptions
  ): Promise<ResourceRecommendation[]> {
    // Validate context
    if (!context) {
      throw new RecommendationEngineError(
        'INVALID_CONTEXT',
        'Context is required for recommendation generation'
      );
    }

    // If AI is disabled or unavailable, fall back to query-based search
    if (!options.enableAI || !this.copilotSdk.isAvailable()) {
      return this.generateFallbackRecommendations(context, options);
    }

    try {
      return await this.generateAiRecommendations(context, options);
    } catch (error) {
      // Log error and fall back to query-based search
      if (error instanceof RecommendationEngineError) {
        throw error;
      }

      // Fall back to query-based search on unexpected errors
      return this.generateFallbackRecommendations(context, options);
    }
  }
}

/**
 * Build search queries from detected context.
 * @param context Detected context.
 * @returns Search queries.
 */
export function buildSearchQueries(context: DetectedContext): string[] {
  const queries: string[] = [];

  // Tech stack queries
  const { techStack } = context;
  if (techStack.languages.length > 0) {
    queries.push(techStack.languages.join(' '));
  }
  if (techStack.frameworks.length > 0) {
    queries.push(techStack.frameworks.join(' '));
  }

  // Domain queries
  const { domain } = context;
  if (domain.category) {
    queries.push(domain.category);
  }
  if (domain.businessDomain) {
    queries.push(domain.businessDomain);
  }
  if (domain.technicalDomain) {
    queries.push(domain.technicalDomain);
  }

  // Combined queries
  if (techStack.languages.length > 0 && domain.category) {
    queries.push(`${techStack.languages[0]} ${domain.category}`);
  }
  if (techStack.frameworks.length > 0 && domain.businessDomain) {
    queries.push(`${techStack.frameworks[0]} ${domain.businessDomain}`);
  }

  // Default query if no specific context detected
  if (queries.length === 0) {
    queries.push('copilot prompt instruction');
  }

  return queries;
}
