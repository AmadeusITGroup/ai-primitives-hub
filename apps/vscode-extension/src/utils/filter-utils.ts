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
  tagMatch?: 'any' | 'all';
  searchText?: string;
}

type SearchField = 'id' | 'name' | 'description' | 'tag' | 'author' | 'env' | 'source';

interface SearchToken {
  excluded: boolean;
  field?: SearchField;
  value: string;
}

const SEARCH_TOKEN_PATTERN = /(-)?(?:(id|name|description|tag|author|env|source):)?(?:"([^"]+)"|(\S+))/giu;

function normalizeSearchValue(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

/**
 * Parse the marketplace's compact search syntax. Words are combined with AND;
 * quotes preserve phrases; a leading minus excludes a match; and field prefixes
 * restrict a term (for example `tag:security` or `author:"AI Team"`).
 * @param searchText - Raw text entered by the user.
 */
function parseSearchTokens(searchText: string): SearchToken[] {
  const tokens: SearchToken[] = [];
  for (const match of searchText.matchAll(SEARCH_TOKEN_PATTERN)) {
    const value = normalizeSearchValue(match[3] || match[4] || '');
    if (!value) {
      continue;
    }
    tokens.push({
      excluded: match[1] === '-',
      field: match[2]?.toLowerCase() as SearchField | undefined,
      value
    });
  }
  return tokens;
}

function bundleSearchFields(bundle: Bundle): Record<SearchField, string[]> {
  return {
    id: [normalizeSearchValue(bundle.id)],
    name: [normalizeSearchValue(bundle.name)],
    description: [normalizeSearchValue(bundle.description)],
    tag: bundle.tags.map((tag) => normalizeSearchValue(tag)),
    author: [normalizeSearchValue(bundle.author || '')],
    env: bundle.environments.map((environment) => normalizeSearchValue(environment)),
    source: [normalizeSearchValue(bundle.sourceId)]
  };
}

function tokenMatches(fields: Record<SearchField, string[]>, token: SearchToken): boolean {
  const values = token.field
    ? fields[token.field]
    : Object.values(fields).flat();
  return values.some((value) => value.includes(token.value));
}

function scoreBundle(fields: Record<SearchField, string[]>, tokens: SearchToken[]): number {
  let score = 0;
  for (const token of tokens) {
    if (token.excluded) {
      continue;
    }

    if (fields.id.includes(token.value)) {
      score += 120;
    } else if (fields.name.includes(token.value)) {
      score += 100;
    } else if (fields.name.some((value) => value.startsWith(token.value))) {
      score += 70;
    } else if (fields.tag.includes(token.value)) {
      score += 50;
    } else if (fields.author.includes(token.value)) {
      score += 35;
    } else if (fields.name.some((value) => value.includes(token.value))) {
      score += 30;
    } else if (fields.description.some((value) => value.includes(token.value))) {
      score += 15;
    } else {
      score += 10;
    }
  }
  return score;
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
 * @param match - Whether any or all selected tags must match.
 * @returns Filtered array of bundles
 */
export function filterBundlesByTags(
  bundles: Bundle[],
  tags: string[],
  match: 'any' | 'all' = 'any'
): Bundle[] {
  if (tags.length === 0) {
    return bundles;
  }

  const normalizedTags = tags.map((t) => t.toLowerCase());

  return bundles.filter((bundle) => {
    const bundleTags = bundle.tags.map((tag) => tag.toLowerCase());
    return match === 'all'
      ? normalizedTags.every((tag) => bundleTags.includes(tag))
      : normalizedTags.some((tag) => bundleTags.includes(tag));
  });
}

/**
 * Filter and relevance-rank bundles using the marketplace search syntax.
 * Unscoped terms search id, name, description, tags, author, environments,
 * and source. Multiple positive terms use AND semantics.
 * @param bundles - Array of bundles to filter
 * @param searchText - Text to search for (empty string returns all bundles)
 * @returns Filtered array of bundles
 */
export function filterBundlesBySearch(bundles: Bundle[], searchText: string): Bundle[] {
  if (!searchText || searchText.trim() === '') {
    return bundles;
  }

  const tokens = parseSearchTokens(searchText);
  if (tokens.length === 0) {
    return bundles;
  }

  return bundles
    .map((bundle, index) => {
      const fields = bundleSearchFields(bundle);
      return { bundle, fields, index };
    })
    .filter(({ fields }) => tokens.every((token) =>
      token.excluded ? !tokenMatches(fields, token) : tokenMatches(fields, token)
    ))
    .map(({ bundle, fields, index }) => ({
      bundle,
      index,
      score: scoreBundle(fields, tokens)
    }))
    .toSorted((a, b) => b.score - a.score || a.index - b.index)
    .map(({ bundle }) => bundle);
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
    filtered = filterBundlesByTags(filtered, options.tags, options.tagMatch);
  }

  if (options.searchText) {
    filtered = filterBundlesBySearch(filtered, options.searchText);
  }

  return filtered;
}
