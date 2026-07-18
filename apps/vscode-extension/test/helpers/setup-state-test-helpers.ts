/**
 * Setup State Test Helpers
 *
 * Shared utilities for SetupStateManager tests.
 * Provides consistent mock data generation for hub-related tests.
 */

/**
 * Create mock hub data for testing
 * @param hasHubs - Whether to include hubs in the list
 * @param hasActiveHub - Whether to include an active hub
 * @returns Object with mockHubs array and mockActiveHub
 */
export function createMockHubData(hasHubs: boolean, hasActiveHub: boolean) {
  const mockHubs = hasHubs
    ? [{
      id: 'test-hub',
      name: 'Test Hub',
      description: 'Test hub description',
      reference: {
        type: 'github' as const,
        location: 'test/hub'
      }
    }]
    : [];

  const mockActiveHub = hasActiveHub
    ? {
      config: {
        version: '1.0.0',
        metadata: {
          name: 'Test Hub',
          description: 'Test hub description',
          maintainer: 'Test',
          updatedAt: new Date().toISOString()
        },
        sources: [],
        profiles: []
      },
      reference: {
        type: 'github' as const,
        location: 'test/hub'
      }
    }
    : null;

  return { mockHubs, mockActiveHub };
}

/**
 * Format test parameters for error messages
 * @param params - Object with test parameters
 * @returns Formatted string for error messages
 */
export function formatTestParams(params: Record<string, any>): string {
  return Object.entries(params)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
}
