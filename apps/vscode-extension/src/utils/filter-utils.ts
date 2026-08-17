/**
 * Filtering utilities for marketplace bundles
 * Provides dynamic tag extraction, source filtering, and tag-based filtering
 */

import {
  Bundle,
  RegistrySource,
} from '../types/registry';

/**
 * Source with bundle count for UI display
 */
export interface SourceWithCount extends RegistrySource {
  bundleCount: number;
}

/**
 * Filter options for marketplace
 */
export interface FilterOptions {
  sourceId?: string;
  tags?: string[];
  searchText?: string;
  contentTypes?: ContentTypeFilter[];
}

/**
 * Extract all unique tags from bundles, sorted alphabetically
 * @param bundles - Array of bundles to extract tags from
 * @returns Sorted array of unique tag strings
 */
export function extractAllTags(bundles: Bundle[]): string[] {
  const tagSet = new Set<string>();

  bundles.forEach((bundle) => {
    bundle.tags.forEach((tag) => tagSet.add(tag));
  });

  return Array.from(tagSet).toSorted();
}

/**
 * Get tag frequency across all bundles
 * Useful for showing popular tags or tag clouds
 * @param bundles - Array of bundles to analyze
 * @returns Map of tag to occurrence count
 */
export function getTagFrequency(bundles: Bundle[]): Map<string, number> {
  const frequency = new Map<string, number>();

  bundles.forEach((bundle) => {
    bundle.tags.forEach((tag) => {
      frequency.set(tag, (frequency.get(tag) || 0) + 1);
    });
  });

  return frequency;
}

/**
 * Extract sources that have at least one bundle, with bundle count
 * @param bundles - Array of bundles
 * @param allSources - All available registry sources
 * @returns Array of sources with bundle counts
 */
export function extractBundleSources(
    bundles: Bundle[],
    allSources: RegistrySource[]
): SourceWithCount[] {
  const sourceCounts = new Map<string, number>();

  bundles.forEach((bundle) => {
    sourceCounts.set(bundle.sourceId, (sourceCounts.get(bundle.sourceId) || 0) + 1);
  });

  return allSources
    .filter((source) => sourceCounts.has(source.id))
    .map((source) => ({
      ...source,
      bundleCount: sourceCounts.get(source.id)!
    }));
}

/**
 * Filter bundles by source ID
 * @param bundles - Array of bundles to filter
 * @param sourceId - Source ID to filter by, or 'all' for no filtering
 * @returns Filtered array of bundles
 */
export function filterBundlesBySource(bundles: Bundle[], sourceId: string): Bundle[] {
  if (sourceId === 'all' || !sourceId) {
    return bundles;
  }
  return bundles.filter((b) => b.sourceId === sourceId);
}

/**
 * Filter bundles by tags (OR logic - bundle matches if it has any of the specified tags)
 * Case-insensitive matching
 * @param bundles - Array of bundles to filter
 * @param tags - Tags to filter by (empty array returns all bundles)
 * @returns Filtered array of bundles
 */
export function filterBundlesByTags(bundles: Bundle[], tags: string[]): Bundle[] {
  if (tags.length === 0) {
    return bundles;
  }

  const normalizedTags = tags.map((t) => t.toLowerCase());

  return bundles.filter((bundle) => {
    return bundle.tags.some((bundleTag) =>
      normalizedTags.includes(bundleTag.toLowerCase())
    );
  });
}

/**
 * Filter bundles by search text (searches name, description, and tags)
 * Case-insensitive matching
 * @param bundles - Array of bundles to filter
 * @param searchText - Text to search for (empty string returns all bundles)
 * @returns Filtered array of bundles
 */
export function filterBundlesBySearch(bundles: Bundle[], searchText: string): Bundle[] {
  if (!searchText || searchText.trim() === '') {
    return bundles;
  }

  const term = searchText.toLowerCase();

  return bundles.filter((bundle) =>
    bundle.name.toLowerCase().includes(term)
    || bundle.description.toLowerCase().includes(term)
    || bundle.tags.some((tag) => tag.toLowerCase().includes(term))
    || bundle.author.toLowerCase().includes(term)
  );
}

/**
 * Content types that can be used for filtering
 */
export type ContentTypeFilter = 'agents' | 'skills' | 'prompts' | 'mcpServers' | 'instructions';

/**
 * Filter bundles by content types based on their content breakdown (OR logic)
 * A bundle matches if it contains any of the specified content types
 * @param bundles - Array of bundles with contentBreakdown
 * @param contentTypes - Content types to filter by (empty array returns all bundles)
 * @returns Filtered array of bundles
 */
export function filterBundlesByContentType(
    bundles: (Bundle & { contentBreakdown?: { prompts?: number; instructions?: number; agents?: number; skills?: number; mcpServers?: number } })[],
    contentTypes: ContentTypeFilter[]
): Bundle[] {
  if (contentTypes.length === 0) {
    return bundles;
  }
  return bundles.filter((bundle) => {
    if (!bundle.contentBreakdown) {
      return false;
    }
    return contentTypes.some((type) => (bundle.contentBreakdown![type] || 0) > 0);
  });
}

/**
 * Apply all filters to bundles
 * Combines source, tag, and search filtering
 * @param bundles - Array of bundles to filter
 * @param options - Filter options
 * @returns Filtered array of bundles
 */
export function applyFilters(bundles: Bundle[], options: FilterOptions): Bundle[] {
  let filtered = bundles;

  if (options.sourceId) {
    filtered = filterBundlesBySource(filtered, options.sourceId);
  }

  if (options.tags && options.tags.length > 0) {
    filtered = filterBundlesByTags(filtered, options.tags);
  }

  if (options.contentTypes && options.contentTypes.length > 0) {
    filtered = filterBundlesByContentType(filtered, options.contentTypes);
  }

  if (options.searchText) {
    filtered = filterBundlesBySearch(filtered, options.searchText);
  }

  return filtered;
}
