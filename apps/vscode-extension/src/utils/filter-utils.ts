/**
 * Filtering utilities for marketplace bundles
 * Provides dynamic tag extraction, source filtering, tag-based filtering,
 * and the compact relevance-ranked search syntax used by the marketplace.
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
 * Content types that can be used for filtering
 */
export type ContentTypeFilter = 'agents' | 'skills' | 'prompts' | 'mcpServers' | 'instructions';

/**
 * Content breakdown showing count of each resource type in a bundle
 */
export interface ContentBreakdown {
  prompts: number;
  instructions: number;
  chatmodes: number;
  agents: number;
  skills: number;
  mcpServers: number;
}

/**
 * Filter options for marketplace
 */
export interface FilterOptions {
  sourceId?: string;
  tags?: string[];
  tagMatch?: 'any' | 'all';
  searchText?: string;
  contentTypes?: ContentTypeFilter[];
  environment?: string;
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

/**
 * Relevance tiers, highest first. Exact field matches rank above a partial
 * (substring) match on any structured field, which in turn rank above a mere
 * description mention. Without the partial-structured tiers a bundle matching
 * solely via a partial id/tag/env (e.g. "renovate" in the id "renovate-config")
 * fell through to the floor and sorted below description-only mentions. Mirrors
 * the webview's scoreSearchMatch so both search entry points rank identically.
 */
const SCORE_TIERS: { field: SearchField; kind: 'exact' | 'prefix' | 'substring'; points: number }[] = [
  { field: 'id', kind: 'exact', points: 120 },
  { field: 'name', kind: 'exact', points: 100 },
  { field: 'name', kind: 'prefix', points: 70 },
  { field: 'tag', kind: 'exact', points: 50 },
  { field: 'env', kind: 'exact', points: 40 },
  { field: 'author', kind: 'exact', points: 35 },
  { field: 'name', kind: 'substring', points: 30 },
  { field: 'id', kind: 'substring', points: 28 },
  { field: 'tag', kind: 'substring', points: 26 },
  { field: 'source', kind: 'exact', points: 25 },
  { field: 'env', kind: 'substring', points: 24 },
  { field: 'author', kind: 'substring', points: 22 },
  { field: 'source', kind: 'substring', points: 18 },
  { field: 'description', kind: 'substring', points: 8 }
];

const FLOOR_SCORE = 2;

function tierMatches(values: string[], value: string, kind: 'exact' | 'prefix' | 'substring'): boolean {
  if (kind === 'exact') {
    return values.includes(value);
  }
  if (kind === 'prefix') {
    return values.some((candidate) => candidate.startsWith(value));
  }
  return values.some((candidate) => candidate.includes(value));
}

function scoreToken(fields: Record<SearchField, string[]>, value: string): number {
  const tier = SCORE_TIERS.find((candidate) => tierMatches(fields[candidate.field], value, candidate.kind));
  return tier ? tier.points : FLOOR_SCORE;
}

function scoreBundle(fields: Record<SearchField, string[]>, tokens: SearchToken[]): number {
  let score = 0;
  for (const token of tokens) {
    if (!token.excluded) {
      score += scoreToken(fields, token.value);
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
 * Extract all unique environments from bundles, sorted alphabetically
 * @param bundles - Array of bundles to extract environments from
 * @returns Sorted array of unique environment strings
 */
export function extractAllEnvironments(bundles: Bundle[]): string[] {
  const environmentSet = new Set<string>();

  bundles.forEach((bundle) => {
    (bundle.environments || []).forEach((environment) => environmentSet.add(environment));
  });

  return Array.from(environmentSet).toSorted();
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
 * Filter bundles by tags. With `any` (default) a bundle matches if it carries
 * any of the selected tags; with `all` it must carry every selected tag.
 * Case-insensitive matching.
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
 * Filter bundles by environment.
 * Case-insensitive matching.
 * @param bundles - Array of bundles to filter
 * @param environment - Environment to filter by, or 'all' for no filtering
 * @returns Filtered array of bundles
 */
export function filterBundlesByEnvironment(bundles: Bundle[], environment: string): Bundle[] {
  if (environment === 'all' || !environment) {
    return bundles;
  }
  const normalized = environment.toLowerCase();
  return bundles.filter((bundle) =>
    (bundle.environments || []).some((candidate) => candidate.toLowerCase() === normalized)
  );
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
 * Filter bundles by content types based on their content breakdown (OR logic)
 * A bundle matches if it contains any of the specified content types
 * @param bundles - Array of bundles with contentBreakdown
 * @param contentTypes - Content types to filter by (empty array returns all bundles)
 * @returns Filtered array of bundles
 */
export function filterBundlesByContentType(
    bundles: (Bundle & { contentBreakdown?: Partial<ContentBreakdown> })[],
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
